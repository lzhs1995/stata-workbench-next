"use strict";
// mcp-stata 1.26.1 session lifecycle, after the cancellation-drain patch.
// Keep the unchanged manager and message handlers; refuse unknown class bodies.
const ORIGINAL = String.raw`class StataSession:
    def __init__(self, session_id: str):
        self.id = session_id
        self.status = "starting"
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.pid: Optional[int] = None
        
        self._parent_conn, self._child_conn = Pipe()
        self._process = Process(target=self._run_worker, args=(self._child_conn,))
        self._process.daemon = True
        self._process.start()
        
        self._pending_requests: Dict[str, asyncio.Future] = {}
        self._log_listeners: Dict[str, List[Callable[[str], Awaitable[None]]]] = {}
        self._progress_listeners: Dict[str, List[Callable[[float, Optional[float], Optional[str]], Awaitable[None]]]] = {}
        
        self._listener_running = True
        self._listener_task = asyncio.create_task(self._listen_to_worker())

    def _run_worker(self, conn: Connection):
        from mcp_stata.worker import main
        main(conn)

    async def _listen_to_worker(self):
        loop = asyncio.get_running_loop()
        try:
            while self._listener_running:
                # Use poll with timeout to allow checking self._listener_running and asyncio cancellation
                if await loop.run_in_executor(None, self._parent_conn.poll, 0.2):
                    try:
                        msg = await loop.run_in_executor(None, self._parent_conn.recv)
                        await self._handle_worker_msg(msg)
                    except (EOFError, ConnectionResetError, BrokenPipeError):
                        logger.info(f"Session {self.id} worker connection closed.")
                        break
                else:
                    # Give the event loop a chance to process other tasks and check cancellation
                    await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            self._listener_running = False
            raise
        except Exception as e:
            logger.error(f"Error in session {self.id} listener: {e}")
            self.status = "error"
        finally:
            self._listener_running = False
            if self.status != "error":
                self.status = "stopped"

    async def _handle_worker_msg(self, msg: Dict[str, Any]):
        event = msg.get("event")
        msg_id = msg.get("id")
        
        if event == "ready":
            self.pid = msg.get("pid")
            self.status = "running"
            logger.info(f"Session {self.id} ready (PID: {self.pid})")
        
        elif event == "log":
            if msg_id in self._log_listeners:
                for cb in self._log_listeners[msg_id]:
                    await cb(msg.get("text"))
        
        elif event == "progress":
            if msg_id in self._progress_listeners:
                for cb in self._progress_listeners[msg_id]:
                    await cb(msg.get("progress"), msg.get("total"), msg.get("message"))
        
        elif event == "result":
            if msg_id in self._pending_requests:
                if not self._pending_requests[msg_id].done():
                    self._pending_requests[msg_id].set_result(msg.get("result"))
                self._cleanup_listeners(msg_id)
        
        elif event == "error":
            if msg_id in self._pending_requests:
                if not self._pending_requests[msg_id].done():
                    self._pending_requests[msg_id].set_exception(RuntimeError(msg.get("message")))
                self._cleanup_listeners(msg_id)
            else:
                logger.error(f"Global worker error in session {self.id}: {msg.get('message')}")
                # Don't update status if already stopped or error
                if self.status not in ("stopped", "error"):
                    self.status = "error"

    def _cleanup_listeners(self, msg_id: str):
        self._log_listeners.pop(msg_id, None)
        self._progress_listeners.pop(msg_id, None)
        self._pending_requests.pop(msg_id, None)

    async def _ensure_listener(self):
        current_loop = asyncio.get_running_loop()
        if self._listener_task is None or self._listener_task.done() or (hasattr(self._listener_task, "get_loop") and self._listener_task.get_loop() != current_loop):
            if self._listener_task and not self._listener_task.done():
                self._listener_task.cancel()
            self._listener_running = True
            self._listener_task = current_loop.create_task(self._listen_to_worker())

    async def call(self, method: str, args: Dict[str, Any], 
                   notify_log: Optional[Callable[[str], Awaitable[None]]] = None,
                   notify_progress: Optional[Callable[[float, Optional[float], Optional[str]], Awaitable[None]]] = None) -> Any:
        
        await self._ensure_listener()
        msg_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending_requests[msg_id] = future
        
        if notify_log:
            self._log_listeners.setdefault(msg_id, []).append(notify_log)
        if notify_progress:
            self._progress_listeners.setdefault(msg_id, []).append(notify_progress)
            
        try:
            self._parent_conn.send({
                "type": method,
                "id": msg_id,
                "args": args
            })
            # Workbench cancellation must drain the live worker future before task_done.
            # Shield the worker result so cancelling the server task cannot cancel the
            # acknowledgement Future owned by the session listener.
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            logger.info(f"Cancellation requested for command {method}:{msg_id} in session {self.id}")
            try:
                self._parent_conn.send({"type": "break"})
            except Exception as e:
                logger.warning(f"Failed to send break command to worker for session {self.id}: {e}")

            # task_done is session-reuse evidence, so it must follow the worker's real
            # result/error acknowledgement. Repeated cancellation requests do not turn
            # this into a timer-based false terminal state; owned hard reset remains the
            # escape path if the worker never acknowledges.
            while not future.done():
                try:
                    await asyncio.shield(future)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            logger.info(f"Session {self.id} acknowledged break for {msg_id}")
            raise
        except (AttributeError, BrokenPipeError, ConnectionResetError) as e:
             self._cleanup_listeners(msg_id)
             raise RuntimeError(f"Failed to send command to worker: {e}")

    async def send_break(self):
        """Send an out-of-band break signal to the worker."""
        try:
            self._parent_conn.send({"type": "break"})
            logger.info(f"Break signal sent to session {self.id}")
        except Exception as e:
            logger.warning(f"Failed to send break command to session {self.id}: {e}")
            raise RuntimeError(f"Failed to send break signal: {e}")

    async def stop(self, timeout: float = 5.0):
        self._listener_running = False
        if self.status != "stopped":
            try:
                self._parent_conn.send({"type": "stop"})
            except Exception:
                pass
            
            if self._process and self._process.is_alive():
                self._process.terminate()
                
                # Use executor to join with timeout without blocking the event loop
                loop = asyncio.get_running_loop()
                try:
                    await loop.run_in_executor(None, self._process.join, timeout)
                except Exception:
                    pass
                
                if self._process.is_alive():
                    logger.warning(f"Session {self.id} worker (PID {self._process.pid}) did not exit after {timeout}s; killing.")
                    try:
                        self._process.kill()
                        await loop.run_in_executor(None, self._process.join)
                    except Exception as e:
                        logger.error(f"Failed to kill session {self.id} worker: {e}")
            
            self.status = "stopped"
            if self._listener_task:
                self._listener_task.cancel()
                try:
                    await self._listener_task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass

    def get_info(self) -> SessionInfo:
        return SessionInfo(
            id=self.id,
            status=self.status,
            created_at=self.created_at,
            pid=self.pid
        )

`;
const REPLACEMENT = String.raw`class StataSession:
    def __init__(self, session_id: str):
        import threading
        self.id = session_id
        self.status = "starting"
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.pid = None
        self._pending_requests = {}
        self._log_listeners = {}
        self._progress_listeners = {}
        self._send_lock = threading.Lock()
        self._send_tasks = set()
        self._listener_running = True
        self._parent_conn, self._child_conn = Pipe()
        # A bound method pickles self, including the unused parent endpoint.
        # The static target passes only the child's endpoint through spawn.
        self._process = Process(target=StataSession._run_worker, args=(self._child_conn,))
        self._process.daemon = True
        try:
            self._process.start()
        except BaseException:
            self._parent_conn.close()
            self._child_conn.close()
            raise
        self._child_conn.close()
        self._listener_task = asyncio.create_task(self._listen_to_worker())

    @staticmethod
    def _run_worker(conn: Connection):
        from mcp_stata.worker import main
        main(conn)

    async def _listen_to_worker(self):
        try:
            while self._listener_running:
                if await self._owned_io(self._parent_conn.poll, 0.2):
                    msg = await self._owned_io(self._parent_conn.recv)
                    await self._handle_worker_msg(msg)
                    if msg.get("event") == "error" and not msg.get("id"):
                        self._fail_pending(RuntimeError(msg.get("message", "Worker failed")))
                else:
                    self._check_worker()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.error("Session %s worker failed: %s", self.id, error)
            self._fail_pending(error)
        finally:
            self._listener_running = False
            if self.status not in ("error", "stopped"):
                self._fail_pending(RuntimeError("Worker listener stopped"))

    async def _handle_worker_msg(self, msg: Dict[str, Any]):
        event = msg.get("event")
        msg_id = msg.get("id")
        
        if event == "ready":
            self.pid = msg.get("pid")
            self.status = "running"
            logger.info(f"Session {self.id} ready (PID: {self.pid})")
        
        elif event == "log":
            if msg_id in self._log_listeners:
                for cb in self._log_listeners[msg_id]:
                    await cb(msg.get("text"))
        
        elif event == "progress":
            if msg_id in self._progress_listeners:
                for cb in self._progress_listeners[msg_id]:
                    await cb(msg.get("progress"), msg.get("total"), msg.get("message"))
        
        elif event == "result":
            if msg_id in self._pending_requests:
                if not self._pending_requests[msg_id].done():
                    self._pending_requests[msg_id].set_result(msg.get("result"))
                self._cleanup_listeners(msg_id)
        
        elif event == "error":
            if msg_id in self._pending_requests:
                if not self._pending_requests[msg_id].done():
                    self._pending_requests[msg_id].set_exception(RuntimeError(msg.get("message")))
                self._cleanup_listeners(msg_id)
            else:
                logger.error(f"Global worker error in session {self.id}: {msg.get('message')}")
                # Don't update status if already stopped or error
                if self.status not in ("stopped", "error"):
                    self.status = "error"

    def _cleanup_listeners(self, msg_id: str):
        self._log_listeners.pop(msg_id, None)
        self._progress_listeners.pop(msg_id, None)
        self._pending_requests.pop(msg_id, None)

    async def _ensure_listener(self):
        self._check_worker()
        current_loop = asyncio.get_running_loop()
        if self._listener_task.done() or self._listener_task.get_loop() != current_loop:
            # Never make a failed/dead session appear usable by restarting its listener.
            raise RuntimeError("Session listener unavailable; explicit recovery required")

    async def call(self, method: str, args: Dict[str, Any],
                   notify_log=None, notify_progress=None) -> Any:
        await self._ensure_listener()
        msg_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending_requests[msg_id] = future
        if notify_log:
            self._log_listeners[msg_id] = [notify_log]
        if notify_progress:
            self._progress_listeners[msg_id] = [notify_progress]
        try:
            await self._send({"type": method, "id": msg_id, "args": args})
            # Workbench cancellation must drain the live worker future before task_done.
            await asyncio.wait({future})
            return future.result()
        except asyncio.CancelledError:
            # _send drains before cancellation propagates, so no delayed command can
            # appear after this break or after the caller's terminal cancellation.
            import anyio
            with anyio.CancelScope(shield=True):
                if not future.done():
                    try:
                        await self._send({"type": "break"})
                    except (Exception, asyncio.CancelledError):
                        pass
                while not future.done():
                    try:
                        await asyncio.wait({future})
                    except asyncio.CancelledError:
                        continue
                if not future.cancelled():
                    error = future.exception()
                    if error is not None:
                        logger.warning("Cancelled request ended with worker error: %s", error)
            raise
        finally:
            self._cleanup_listeners(msg_id)
            if future.done() and not future.cancelled():
                future.exception()

    async def send_break(self):
        await self._send({"type": "break"})

    async def stop(self, timeout: float = 5.0):
        self.status = "stopped"
        self._fail_pending(RuntimeError("Session stopped explicitly"))
        # Do not send stop into a full pipe. Terminating this owned worker also
        # releases a blocked writer, since neither process retains the peer end.
        if self._process.is_alive():
            self._process.terminate()
        await self._owned_io(self._process.join, timeout)
        if self._process.is_alive():
            self._process.kill()
            await self._owned_io(self._process.join, timeout)
        if self._process.is_alive():
            raise RuntimeError("Owned worker did not terminate; connection retained")
        if self._send_tasks:
            await asyncio.gather(*list(self._send_tasks), return_exceptions=True)
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
        if self._listener_task:
            await asyncio.gather(self._listener_task, return_exceptions=True)
        self._parent_conn.close()

    def get_info(self) -> SessionInfo:
        try:
            self._check_worker()
        except RuntimeError:
            pass
        return SessionInfo(id=self.id, status=self.status,
                           created_at=self.created_at, pid=self.pid)

    def _fail_pending(self, error):
        if self.status != "stopped":
            self.status = "error"
        self._listener_running = False
        for future in list(self._pending_requests.values()):
            if not future.done():
                future.set_exception(RuntimeError(str(error)))
        self._pending_requests.clear()
        self._log_listeners.clear()
        self._progress_listeners.clear()

    def _check_worker(self):
        if self.status in ("error", "stopped"):
            raise RuntimeError(f"Session {self.id} is {self.status}; explicit recovery required")
        if not self._process.is_alive():
            error = RuntimeError(f"Session {self.id} worker exited (exitcode={self._process.exitcode})")
            self._fail_pending(error)
            raise error

    async def _owned_io(self, function, *args):
        # Cancellation cannot abandon a thread still using the connection.
        task = asyncio.create_task(asyncio.to_thread(function, *args))
        cancelled = None
        import anyio
        with anyio.CancelScope(shield=True):
            while not task.done():
                try:
                    await asyncio.wait({task})
                except asyncio.CancelledError as error:
                    cancelled = error
        if cancelled is not None:
            if not task.cancelled():
                task.exception()
            raise cancelled
        return task.result()

    def _send_sync(self, message):
        with self._send_lock:
            # Future settlement belongs to the asyncio thread, never this writer.
            if self.status in ("error", "stopped") or not self._process.is_alive():
                raise RuntimeError("Worker is unavailable; explicit recovery required")
            from multiprocessing.reduction import ForkingPickler
            # Own immutable bytes, so a failed write traceback cannot retain an
            # exported BytesIO buffer from multiprocessing's pickle helper.
            payload = bytes(ForkingPickler.dumps(message))
            self._parent_conn.send_bytes(payload)

    async def _send(self, message):
        task = asyncio.create_task(self._owned_io(self._send_sync, message))
        self._send_tasks.add(task)
        try:
            cancelled = None
            import anyio
            with anyio.CancelScope(shield=True):
                while not task.done():
                    try:
                        await asyncio.wait({task})
                    except asyncio.CancelledError as error:
                        cancelled = error
            if cancelled is not None:
                task.exception()
                raise cancelled
            return task.result()
        except Exception as error:
            self._fail_pending(error)
            message = str(error)
            error.__traceback__ = None
            raise RuntimeError(message) from None
        finally:
            self._send_tasks.discard(task)

`;
function patchSessions(source) {
  const oldCount = source.split(ORIGINAL).length - 1;
  const newCount = source.split(REPLACEMENT).length - 1;
  if (!oldCount && newCount === 1) return patchStopAll(source);
  if (oldCount !== 1 || newCount) throw new Error("unsupported session lifecycle source");
  return patchStopAll(source.replace(ORIGINAL, REPLACEMENT));
}
const STOP_ALL_ORIGINAL = `    async def stop_all(self):
        tasks = [s.stop() for s in self._sessions.values()]
        if tasks:
            await asyncio.gather(*tasks)
        self._sessions.clear()`;
const STOP_ALL_REPLACEMENT = `    async def stop_all(self):
        sessions = list(self._sessions.items())
        results = await asyncio.gather(*(s.stop() for _, s in sessions), return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        for (sid, _), result in zip(sessions, results):
            if not isinstance(result, BaseException):
                self._sessions.pop(sid, None)
        if errors:
            raise BaseExceptionGroup("Some owned sessions did not stop", errors)`;
function patchStopAll(source) {
  const oldCount = source.split(STOP_ALL_ORIGINAL).length - 1;
  const newCount = source.split(STOP_ALL_REPLACEMENT).length - 1;
  if (!oldCount && newCount === 1) return source;
  if (oldCount !== 1 || newCount) throw new Error("unsupported session-manager shutdown source");
  return source.replace(STOP_ALL_ORIGINAL, STOP_ALL_REPLACEMENT);
}
const SERVER_ORIGINAL = "    asyncio.run(init_sessions())\n\n    mcp.run()";
const SERVER_REPLACEMENT = `    async def serve():
        # Keep worker listeners and the MCP transport on one event loop.
        # asyncio.run(init_sessions()) used to cancel them before serving.
        try:
            await init_sessions()
            await mcp.run_stdio_async()
        finally:
            await session_manager.stop_all()

    asyncio.run(serve())`;
function patchServer(source) {
  const oldCount = source.split(SERVER_ORIGINAL).length - 1;
  const newCount = source.split(SERVER_REPLACEMENT).length - 1;
  if (!oldCount && newCount === 1) return source;
  if (oldCount !== 1 || newCount) throw new Error("unsupported server event-loop lifecycle source");
  return source.replace(SERVER_ORIGINAL, SERVER_REPLACEMENT);
}
module.exports = { ORIGINAL, REPLACEMENT, patchSessions, SERVER_ORIGINAL, SERVER_REPLACEMENT, patchServer,
  STOP_ALL_ORIGINAL, STOP_ALL_REPLACEMENT, patchStopAll };
