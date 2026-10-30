"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const streamStatePatch = require("./stata_stream_state_patch");
const smclLogPatch = require("./stata_smcl_log_patch");
const responseRcPatch = require("./stata_response_rc_patch");
const rcReadPatch = require("./stata_rc_read_patch");
const silentStatePatch = require("./stata_silent_state_patch");
const captureStatePatch = require("./stata_capture_state_patch");
const graphTaskDrainPatch = require("./stata_graph_task_drain_patch");
const graphErrorPatch = require("./stata_graph_error_patch");
const graphCallbackPatch = require("./stata_graph_callback_patch");
const detectorErrorPatch = require("./stata_detector_error_patch");
const detectorStatePatch = require("./stata_detector_state_patch");
const detectorSreturnPatch = require("./stata_detector_sreturn_patch");
const cacheTransactionPatch = require("./stata_cache_transaction_patch");
const exportStatePatch = require("./stata_export_state_patch");
const storedResultsPatch = require("./stata_stored_results_patch");
const startupStatePatch = require("./stata_startup_state_patch");
const bulkCachePatch = require("./stata_bulk_cache_patch");
const graphInventoryPatch = require("./stata_graph_inventory_patch");
const streamLifecyclePatch = require("./stata_stream_lifecycle_patch");
const helpStatePatch = require("./stata_help_state_patch");
const sessionHealthPatch = require("./stata_session_health_patch");
const logQueryPatch = require("./stata_log_query_patch");
const graphNameBoundaryPatch = require("./stata_graph_name_boundary_patch");
const preflightTimeoutPatch = require("./stata_preflight_timeout_patch");

const PATCH_MARKER = "UI/DataBrowser HTTP threads must not create a second asyncio loop";
const TASK_DONE_PATCH_MARKER = "Workbench task_done notification must not retain the MCP transport";
const LOG_PATH_NOTIFY_PATCH_MARKER = "Workbench log_path is authoritative before bounded MCP notification";
const CHECKPOINT_NOTIFY_PATCH_MARKER = "Workbench checkpoint progress stays out of the MCP notification pipe";
const STREAM_PATCH_MARKER_V17 = "Workbench log_path must be written before bounded MCP notifications";
const STREAM_PATCH_MARKER_V18 = "Workbench log_path must never wait indefinitely for MCP notifications";
const STREAM_PATCH_MARKER_V19 = "Workbench notification budget must be shared across the entire Stata run";
const STREAM_PATCH_MARKER = "Workbench notification budget must preserve valid Python source";
const STREAM_TAIL_PATCH_MARKER = "Workbench per-run log must contain its own completion marker before task_done";
const GRAPH_PROBE_PATCH_MARKER = "Workbench internal graph inventory probes must be quiet";
const INTERNAL_SILENT_PATCH_MARKER = "Workbench internal no-capture commands must stay out of the visible log";
const GRAPH_CACHE_DRAIN_PATCH_MARKER = "Workbench graph cache must drain before task_done";
const CHECKPOINT_GRAPH_CACHE_PATCH_MARKER = "Workbench internal checkpoints must not inventory/cache prior graphs";
const RESPECT_BACKGROUND_GRAPH_READY_PATCH_MARKER = "Workbench background tools must honor the client's graph-ready request";
const SESSION_BREAK_DRAIN_PATCH_MARKER = "Workbench cancellation must drain the live worker future before task_done";
const STATA_SET_BREAK_PATCH_MARKER = "Workbench cancellation uses StataSO_SetBreak";

const ORIGINAL_SESSION_CALL = `    async def call(self, method: str, args: Dict[str, Any], 
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
            return await future
        except asyncio.CancelledError:
            # If the session call is cancelled (e.g., from the server or UI),
            # send an out-of-band 'break' message to the worker to interrupt Stata.
            logger.info(f"Cancellation requested for command {method}:{msg_id} in session {self.id}")
            try:
                self._parent_conn.send({"type": "break"})
            except Exception as e:
                logger.warning(f"Failed to send break command to worker for session {self.id}: {e}")
            
            # Wait briefly for the worker to return the result of the interrupted command.
            # We use shield so that we stay in this call until we see the worker acknowledge or we timeout.
            # This prevents the next command from being sent while the worker is still cleaning up.
            try:
                # Give Stata a few seconds to acknowledge the break.
                await asyncio.wait_for(asyncio.shield(future), timeout=3.0)
                logger.info(f"Session {self.id} acknowledged break for {msg_id}")
            except (asyncio.TimeoutError, Exception) as e:
                logger.warning(f"Session {self.id} did not acknowledge break within timeout: {e}")
            
            # Re-raise cancellation
            raise
        except (AttributeError, BrokenPipeError, ConnectionResetError) as e:
             self._cleanup_listeners(msg_id)
             raise RuntimeError(f"Failed to send command to worker: {e}")
`;

const PATCHED_SESSION_CALL = `    async def call(self, method: str, args: Dict[str, Any], 
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
`;

const ORIGINAL_STATA_BREAK_REQUEST = `    def _request_break_in(self) -> None:
        """
        Attempt to interrupt a running Stata command when cancellation is requested.

        Uses the Stata sfi.breakIn hook when available; errors are swallowed because
        cancellation should never crash the host process.
        """
        try:
            import sfi  # type: ignore[import-not-found]

            break_fn = getattr(sfi, "breakIn", None) or getattr(sfi, "break_in", None)
            if callable(break_fn):
                try:
                    self._break_requested = True
                    for _ in range(3):
                        break_fn()
                        time.sleep(0.05)
                    logger.info("Sent breakIn() to Stata for cancellation")
                    self._poll_break_ack(timeout=3.0)
                except Exception as e:  # pragma: no cover - best-effort
                    logger.warning(f"Failed to send breakIn() to Stata: {e}")
            else:  # pragma: no cover - environment without Stata runtime
                logger.debug("sfi.breakIn not available; cannot interrupt Stata")
        except Exception as e:  # pragma: no cover - import failure or other
            logger.debug(f"Unable to import sfi for cancellation: {e}")

    def _request_break_in_fast(self) -> None:
        """Send a lightweight break signal without polling."""
        try:
            import sfi  # type: ignore[import-not-found]

            break_fn = getattr(sfi, "breakIn", None) or getattr(sfi, "break_in", None)
            if callable(break_fn):
                self._break_requested = True
                break_fn()
        except Exception:
            return
`;

const PATCHED_STATA_BREAK_REQUEST = `    def _set_stata_break(self) -> bool:
        """Signal the embedded Stata engine through its supported PyStata ABI."""
        # Workbench cancellation uses StataSO_SetBreak. StataNow's sfi module has
        # no breakIn/break_in API; PyStata itself uses this function for Ctrl+C.
        try:
            from pystata import config as pystata_config

            break_fn = getattr(pystata_config.stlib, "StataSO_SetBreak", None)
            if not callable(break_fn):
                logger.warning("StataSO_SetBreak is unavailable; cannot interrupt Stata")
                return False
            break_fn()
            return True
        except Exception as e:  # pragma: no cover - runtime-specific failure
            logger.warning(f"Failed to call StataSO_SetBreak: {e}")
            return False

    def _request_break_in(self) -> None:
        """Interrupt a running command without claiming completion."""
        self._break_requested = True
        if self._set_stata_break():
            logger.info("Sent StataSO_SetBreak() for cancellation")

    def _request_break_in_fast(self) -> None:
        """Repeat the same supported break signal while the command drains."""
        self._break_requested = True
        self._set_stata_break()
`;

const ORIGINAL_CALL_SYNC = `    def _call_sync(self, method: str, args: dict[str, Any]) -> Any:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        async def _run():
            session = await session_manager.get_or_create_session(self.session_id)
            return await session.call(method, args)

        if loop and loop.is_running():
            # If we're in a thread different from the loop's thread
            # (which is true for UI HTTP handler threads)
            import threading
            if threading.current_thread() != threading.main_thread(): # Simplified check
                future = asyncio.run_coroutine_threadsafe(_run(), loop)
                return future.result()
            else:
                # If we're on the main thread but in a loop, we can't block.
                # This case shouldn't happen for UIChannelManager but might for tests.
                # For tests, we'll try anyio.from_thread.run if available or just run it.
                return anyio.from_thread.run(_run)
        else:
            return asyncio.run(_run())
`;

const PATCHED_CALL_SYNC = `    def _call_sync(self, method: str, args: dict[str, Any]) -> Any:
        # UI/DataBrowser HTTP threads must not create a second asyncio loop for
        # a StataSession. Its worker listener and pending futures belong to the
        # loop currently driving the session listener.
        try:
            session = session_manager.get_session(self.session_id)
        except ValueError as exc:
            raise RuntimeError(
                f"Stata session {self.session_id!r} is not initialized"
            ) from exc

        listener_task = getattr(session, "_listener_task", None)
        listener_loop = listener_task.get_loop() if listener_task is not None else None
        if (listener_task is None or listener_task.done() or listener_loop is None
                or listener_loop.is_closed() or not listener_loop.is_running()):
            raise RuntimeError(
                f"Stata session {self.session_id!r} listener loop is unavailable"
            )

        async def _run():
            return await session.call(method, args)

        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None
        if current_loop is listener_loop:
            raise RuntimeError("Synchronous UI proxy cannot block the Stata listener loop")

        future = asyncio.run_coroutine_threadsafe(_run(), listener_loop)
        try:
            return future.result(timeout=60.0)
        except TimeoutError as exc:
            future.cancel()
            raise RuntimeError(
                f"Timed out waiting for Stata session {self.session_id!r}"
            ) from exc
`;

const ORIGINAL_TASK_DONE_NOTIFY = `async def _notify_task_done(session: object | None, task_info: BackgroundTask, request_id: object | None) -> None:
    if session is None:
        return
    payload = {
        "event": "task_done",
        "task_id": task_info.task_id,
        "status": "done" if task_info.done else "unknown",
        "log_path": task_info.log_path,
        "error": task_info.error,
    }
    try:
        await session.send_log_message(level="info", data=json.dumps(payload), related_request_id=request_id)
    except Exception:
        return
`;

const PATCHED_TASK_DONE_NOTIFY = `async def _notify_task_done(session: object | None, task_info: BackgroundTask, request_id: object | None) -> None:
    if session is None:
        return
    payload = {
        "event": "task_done",
        "task_id": task_info.task_id,
        "status": "done" if task_info.done else "unknown",
        "log_path": task_info.log_path,
        "error": task_info.error,
    }
    try:
        # Workbench task_done notification must not retain the MCP transport
        # after Stata and the authoritative log have already completed.
        await asyncio.wait_for(
            session.send_log_message(
                level="info",
                data=json.dumps(payload),
                related_request_id=request_id,
            ),
            timeout=0.25,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "task_done notification timed out for task %s; releasing transport",
            task_info.task_id,
        )
    except Exception:
        return
`;

const ORIGINAL_BACKGROUND_NOTIFY_HEAD = `    async def notify_log(text: str) -> None:
        if session is not None:
`;

const PATCHED_BACKGROUND_NOTIFY_HEAD_V1 = `    async def notify_log(text: str) -> None:
        # Workbench log_path is authoritative before bounded MCP notification.
        # The background tool must be able to return its task id and log path even
        # when the optional JSON-RPC notification channel is backpressured.
        try:
            payload = json.loads(text)
            if isinstance(payload, dict) and payload.get("event") == "log_path":
                task_info.log_path = payload.get("path")
                if ctx.request_id is not None and task_info.log_path:
                    _request_log_paths[str(ctx.request_id)] = task_info.log_path
        except Exception:
            pass

        if session is not None:
`;

const PATCHED_BACKGROUND_NOTIFY_HEAD = `    workbench_quiet_checkpoint = (
        "___CODEX_CHECKPOINT_DONE___" in str(locals().get("code") or "")
    )

    async def notify_log(text: str) -> None:
        # Workbench log_path is authoritative before bounded MCP notification.
        # The background tool must be able to return its task id and log path even
        # when the optional JSON-RPC notification channel is backpressured.
        try:
            payload = json.loads(text)
            if isinstance(payload, dict) and payload.get("event") == "log_path":
                task_info.log_path = payload.get("path")
                if ctx.request_id is not None and task_info.log_path:
                    _request_log_paths[str(ctx.request_id)] = task_info.log_path
        except Exception:
            pass

        # Workbench checkpoint progress stays out of the MCP notification pipe.
        # Its log file is still authoritative; only the small log_path event and
        # final task_done notification need to cross stdio.
        if workbench_quiet_checkpoint:
            try:
                checkpoint_event = json.loads(text).get("event")
            except Exception:
                checkpoint_event = None
            if checkpoint_event != "log_path":
                return

        if session is not None:
`;

const ORIGINAL_BACKGROUND_NOTIFY_SEND = `                await session.send_log_message(level="info", data=payload_to_send, related_request_id=ctx.request_id)`;

const PATCHED_BACKGROUND_NOTIFY_SEND = `                await asyncio.wait_for(
                    session.send_log_message(
                        level="info",
                        data=payload_to_send,
                        related_request_id=ctx.request_id,
                    ),
                    timeout=0.25,
                )`;

const ORIGINAL_STREAM_HELPER = `        has_written = False
        # Wait for Stata to create the SMCL file
`;

const PATCHED_STREAM_HELPER_V17 = `        has_written = False

        async def _write_and_notify(cleaned_chunk: str, label: str) -> None:
            # Workbench log_path must be written before bounded MCP notifications.
            # A single very large JSON-RPC log notification can fill the stdio pipe
            # and deadlock the task group even after Stata has completed.
            if tee:
                try:
                    tee.write(cleaned_chunk)
                except Exception:
                    pass
            max_notify_chars = 4000
            for offset in range(0, len(cleaned_chunk), max_notify_chars):
                try:
                    await notify_log(cleaned_chunk[offset:offset + max_notify_chars])
                except Exception as exc:
                    logger.debug("%s failed at offset %s: %s", label, offset, exc)
                    break

        # Wait for Stata to create the SMCL file
`;

const PATCHED_STREAM_HELPER_V18 = `        has_written = False
        notifications_enabled = True

        async def _write_and_notify(cleaned_chunk: str, label: str) -> None:
            nonlocal notifications_enabled
            # Workbench log_path must never wait indefinitely for MCP notifications.
            # The visible log is authoritative and is always written in full first.
            if tee:
                try:
                    tee.write(cleaned_chunk)
                except Exception:
                    pass
            if not notifications_enabled:
                return

            max_notify_chars = 4000
            max_notify_total = 16000
            notify_text = cleaned_chunk
            if len(notify_text) > max_notify_total:
                keep = max_notify_total // 2
                omitted = len(notify_text) - (keep * 2)
                notify_text = (
                    notify_text[:keep]
                    + f"\\n[Stata Workbench: {omitted} log characters written to log_path]\\n"
                    + notify_text[-keep:]
                )
            for offset in range(0, len(notify_text), max_notify_chars):
                try:
                    await asyncio.wait_for(
                        notify_log(notify_text[offset:offset + max_notify_chars]),
                        timeout=0.25,
                    )
                except asyncio.TimeoutError:
                    notifications_enabled = False
                    logger.warning(
                        "%s timed out at offset %s; continuing with log_path only",
                        label,
                        offset,
                    )
                    break
                except Exception as exc:
                    notifications_enabled = False
                    logger.debug("%s failed at offset %s: %s", label, offset, exc)
                    break

        # Wait for Stata to create the SMCL file
`;

const PATCHED_STREAM_HELPER_WITH_SEPARATORS = `        has_written = False
        notifications_enabled = True
        notify_budget_remaining = 4000
        tail_marker_buffer = ""
        saw_required_tail = required_tail_marker is None
        tail_marker_line = (
            re.compile(
                r"(?:^|\\n)(?:\\{(?:res|txt)\\})*"
                + re.escape(required_tail_marker)
                + r"\\s*(?:\\n|$)"
            )
            if required_tail_marker
            else None
        )

        async def _write_and_notify(cleaned_chunk: str, label: str) -> None:
            nonlocal notifications_enabled, notify_budget_remaining
            nonlocal tail_marker_buffer, saw_required_tail
            # Workbench notification budget must preserve valid Python source.
            # asyncio.wait_for cannot interrupt a synchronous stdio write after its
            # pipe is full, so keep the cumulative JSON-RPC notification payload
            # below the pipe-risk boundary. The complete visible log remains the
            # authority and is always written before any optional notification.
            if tee:
                try:
                    tee.write(cleaned_chunk)
                except Exception:
                    pass
            if tail_marker_line and not saw_required_tail:
                tail_marker_buffer = (tail_marker_buffer + "\\n" + cleaned_chunk)[-8192:]
                if tail_marker_line.search(tail_marker_buffer):
                    saw_required_tail = True
            if not notifications_enabled or notify_budget_remaining <= 0:
                notifications_enabled = False
                return

            max_notify_chars = 4000
            notify_text = cleaned_chunk
            if len(notify_text) > notify_budget_remaining:
                notice = "\\n[Stata Workbench: further progress available in log_path]\\n"
                keep = max(0, notify_budget_remaining - len(notice))
                notify_text = notify_text[:keep] + notice[:notify_budget_remaining - keep]
            for offset in range(0, len(notify_text), max_notify_chars):
                piece = notify_text[offset:offset + max_notify_chars]
                try:
                    await asyncio.wait_for(notify_log(piece), timeout=0.25)
                    notify_budget_remaining -= len(piece)
                except asyncio.TimeoutError:
                    notifications_enabled = False
                    logger.warning(
                        "%s timed out at offset %s; continuing with log_path only",
                        label,
                        offset,
                    )
                    break
                except Exception as exc:
                    notifications_enabled = False
                    logger.debug("%s failed at offset %s: %s", label, offset, exc)
                    break
            if notify_budget_remaining <= 0:
                notifications_enabled = False

        # Wait for Stata to create the SMCL file
`;

const PATCHED_STREAM_HELPER = PATCHED_STREAM_HELPER_WITH_SEPARATORS.replace(
  'tail_marker_buffer + "\\n" + cleaned_chunk', 'tail_marker_buffer + cleaned_chunk');

const PATCHED_STREAM_HELPER_V19 = PATCHED_STREAM_HELPER
  .replace(STREAM_PATCH_MARKER, STREAM_PATCH_MARKER_V19)
  .replace(
    'notice = "\\n[Stata Workbench: further progress available in log_path]\\n"',
    `notice = "
[Stata Workbench: further progress available in log_path]
"`
  );

// Deployed notification-budget builds shared STREAM_PATCH_MARKER with newer
// builds but did not yet track the completion tail. Match their exact body:
// a comment marker alone cannot establish that the helper was upgraded.
const LEGACY_STREAM_HELPER_WITHOUT_TAIL = PATCHED_STREAM_HELPER
  .replace(PATCHED_STREAM_HELPER.slice(
    PATCHED_STREAM_HELPER.indexOf('        tail_marker_buffer = ""'),
    PATCHED_STREAM_HELPER.indexOf('\n        async def _write_and_notify')
  ), '')
  .replace('            nonlocal tail_marker_buffer, saw_required_tail\n', '')
  .replace(PATCHED_STREAM_HELPER.slice(
    PATCHED_STREAM_HELPER.indexOf('            if tail_marker_line and not saw_required_tail:'),
    PATCHED_STREAM_HELPER.indexOf('            if not notifications_enabled or notify_budget_remaining <= 0:')
  ), '');

const ORIGINAL_STREAM_NOTIFY = `                    if cleaned_chunk:
                        try:
                            await notify_log(cleaned_chunk)
                        except Exception as exc:
                            logger.debug("notify_log failed: %s", exc)
                        
                        if tee:
                            try:
                                # Write cleaned SMCL to tee to satisfy requirements 
                                # for clean logs with preserved markup. 
                                tee.write(cleaned_chunk)
                            except Exception:
                                pass
                        has_written = True
`;

const PATCHED_STREAM_NOTIFY = `                    if cleaned_chunk:
                        await _write_and_notify(cleaned_chunk, "notify_log")
                        has_written = True
`;

const ORIGINAL_FINAL_STREAM_NOTIFY = `                if cleaned_chunk:
                    try:
                        await notify_log(cleaned_chunk)
                    except Exception as exc:
                        logger.debug("final notify_log failed: %s", exc)
                    
                    if tee:
                        try:
                            # Write cleaned SMCL to tee
                            tee.write(cleaned_chunk)
                        except Exception:
                            pass
                    has_written = True
`;

const PATCHED_FINAL_STREAM_NOTIFY = `                if cleaned_chunk:
                    await _write_and_notify(cleaned_chunk, "final notify_log")
                    has_written = True
`;

const ORIGINAL_STREAM_TAIL_SIGNATURE = `        start_offset: int = 0,
        tee: Optional[FileTeeIO] = None,
    ) -> None:`;

const PATCHED_STREAM_TAIL_SIGNATURE = `        start_offset: int = 0,
        tee: Optional[FileTeeIO] = None,
        required_tail_marker: Optional[str] = None,
    ) -> None:`;

const ORIGINAL_POST_DONE_DRAIN = `            # Final check for any remaining content
                chunk, chunk_bytes = await anyio.to_thread.run_sync(_read_content)
                if chunk:
                    last_pos += chunk_bytes
                cleaned_chunk = self._clean_internal_smcl(
                    chunk,
                    strip_output=False,
                    strip_leading_boilerplate=not has_written,
                )
                if cleaned_chunk:
                    await _write_and_notify(cleaned_chunk, "final notify_log")
                    has_written = True
            
            if on_chunk is not None:
                # Final check even if last chunk is empty, to ensure 
                # graphs created at the very end are detected.
                try:
                    await on_chunk(chunk or "")
                except Exception as exc:
                    logger.debug("final on_chunk check failed: %s", exc)
`;

const PATCHED_POST_DONE_DRAIN = `            # Workbench per-run log must contain its own completion marker before task_done.
            # done can race the final persistent-SMCL flush, so a single read (the
            # old, accidentally loop-indented block) could permanently truncate
            # log_path while the session log continued to a verified completion.
            completion_deadline = time.monotonic() + 5.0
            chunk = ""
            while True:
                chunk, chunk_bytes = await anyio.to_thread.run_sync(_read_content)
                if chunk:
                    last_pos += chunk_bytes
                    cleaned_chunk = self._clean_internal_smcl(
                        chunk,
                        strip_output=False,
                        strip_leading_boilerplate=not has_written,
                    )
                    if cleaned_chunk:
                        await _write_and_notify(cleaned_chunk, "final notify_log")
                        has_written = True
                    if on_chunk is not None:
                        try:
                            await on_chunk(chunk)
                        except Exception as exc:
                            logger.debug("final on_chunk check failed: %s", exc)
                    continue
                if saw_required_tail or time.monotonic() >= completion_deadline:
                    break
                await anyio.sleep(0.05)

            if on_chunk is not None and not chunk:
                try:
                    await on_chunk("")
                except Exception as exc:
                    logger.debug("final on_chunk check failed: %s", exc)
`;

const ORIGINAL_STREAM_CALL_TAIL = `                            start_offset=start_offset,
                            tee=tee,
                        )`;

const PATCHED_STREAM_CALL_TAIL_COMMAND = `                            start_offset=start_offset,
                            tee=tee,
                            required_tail_marker=((__m.group(0) if (__m := re.search(r"___CODEX_RUN_DONE_[A-Za-z0-9_.:-]+___", code)) else None)),
                        )`;

const PATCHED_STREAM_CALL_TAIL_DOFILE = `                            start_offset=start_offset,
                            tee=tee,
                            required_tail_marker=((__m.group(0) if (__m := re.search(r"___CODEX_RUN_DONE_[A-Za-z0-9_.:-]+___", dofile_text)) else None)),
                        )`;

const ORIGINAL_CLIENT_GRAPH_INVENTORY = `                        "quietly graph dir, memory\\n"
                        "macro define mcp_graph_list \\\"\`r(list)'\\\"\\n"
                        "if \\\"\`r(list)'\\\" != \\\"\\\" {\\n"
                        "  foreach g in \`r(list)' {\\n"
                        "    quietly graph describe \`g'\\n"`;

const PATCHED_CLIENT_GRAPH_INVENTORY = `                        # Workbench internal graph inventory probes must be quiet.
                        "capture quietly graph dir, memory\\n"
                        "macro define mcp_graph_list \\\"\`r(list)'\\\"\\n"
                        "if \\\"\`r(list)'\\\" != \\\"\\\" {\\n"
                        "  foreach g in \`r(list)' {\\n"
                        "    capture quietly graph describe \`g'\\n"`;

const ORIGINAL_INTERNAL_SILENT_EXEC = `                    f"capture noisily {inner_code}\\n"`;
const PATCHED_INTERNAL_SILENT_EXEC = `                    # Workbench internal no-capture commands must stay out of the visible log.
                    f"capture quietly {inner_code}\\n"`;

const ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND = `            asyncio.create_task(
                self._cache_new_graphs(
                    graph_cache,
                    notify_progress=notify_progress,
                    total_lines=total_lines,
                    completed_label="Command",
                )
            )`;

const PATCHED_BACKGROUND_GRAPH_CACHE_COMMAND = `            # Workbench graph cache must drain before task_done. A detached graph
            # task can retain _exec_lock and deadlock the next shared-session run.
            await self._cache_new_graphs(
                graph_cache,
                notify_progress=notify_progress,
                total_lines=total_lines,
                completed_label="Command",
            )`;

const ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE = `            asyncio.create_task(
                self._cache_new_graphs(
                    graph_cache,
                    notify_progress=notify_progress,
                    total_lines=total_lines,
                    completed_label="Do-file",
                )
            )`;

const PATCHED_BACKGROUND_GRAPH_CACHE_DOFILE = `            # Workbench graph cache must drain before task_done. A detached graph
            # task can retain _exec_lock and deadlock the next shared-session run.
            await self._cache_new_graphs(
                graph_cache,
                notify_progress=notify_progress,
                total_lines=total_lines,
                completed_label="Do-file",
            )`;

const ORIGINAL_BACKGROUND_GRAPH_READY_OPTION = `                        "emit_graph_ready": True,
                        "graph_ready_task_id": task_id,`;

const PATCHED_BACKGROUND_GRAPH_READY_OPTION = `                        # Workbench internal checkpoints must not inventory/cache prior graphs.
                        "emit_graph_ready": not workbench_quiet_checkpoint,
                        "graph_ready_task_id": task_id,`;

const ORIGINAL_DOFILE_BACKGROUND_SIGNATURE = `async def run_do_file_background(
    path: str,
    ctx: Context | None = None,
    echo: bool = True,
    as_json: bool = True,
    trace: bool = False,
    raw: bool = False,
    max_output_lines: int = None,
    cwd: str | None = None,
    session_id: str = "default",
) -> str:`;

const PATCHED_DOFILE_BACKGROUND_SIGNATURE = `async def run_do_file_background(
    path: str,
    ctx: Context | None = None,
    echo: bool = True,
    as_json: bool = True,
    trace: bool = False,
    raw: bool = False,
    max_output_lines: int = None,
    cwd: str | None = None,
    emit_graph_ready: bool = True,  # Workbench background tools must honor the client's graph-ready request.
    session_id: str = "default",
) -> str:`;

const ORIGINAL_COMMAND_BACKGROUND_SIGNATURE = `async def run_command_background(
    code: str,
    ctx: Context | None = None,
    echo: bool = True,
    as_json: bool = True,
    trace: bool = False,
    raw: bool = False,
    max_output_lines: int = None,
    cwd: str | None = None,
    session_id: str = "default",
) -> str:`;

const PATCHED_COMMAND_BACKGROUND_SIGNATURE = `async def run_command_background(
    code: str,
    ctx: Context | None = None,
    echo: bool = True,
    as_json: bool = True,
    trace: bool = False,
    raw: bool = False,
    max_output_lines: int = None,
    cwd: str | None = None,
    emit_graph_ready: bool = True,  # Workbench background tools must honor the client's graph-ready request.
    session_id: str = "default",
) -> str:`;

const PATCHED_RESPECT_BACKGROUND_GRAPH_READY_OPTION = `                        "emit_graph_ready": emit_graph_ready,
                        "graph_ready_task_id": task_id,`;

const ORIGINAL_DETECTOR_GRAPH_DIR = "quietly graph dir, memory";
const PATCHED_DETECTOR_GRAPH_DIR = "capture quietly graph dir, memory";
const ORIGINAL_DETECTOR_GRAPH_DESCRIBE = "quietly graph describe {resolved}\\n";
const PATCHED_DETECTOR_GRAPH_DESCRIBE = "capture quietly graph describe {resolved}\\n";

function addCandidate(set, candidate) {
  if (!candidate) return;
  set.add(path.resolve(candidate));
}

function runtimeRootFromCommand(command) {
  if (typeof command !== "string" || !path.isAbsolute(command)) return null;
  // An absolute uv/uvx launcher is not an installed Python environment.
  if (["uv", "uv.exe", "uvx", "uvx.exe"].includes(path.basename(command).toLowerCase())) return null;
  const parent = path.dirname(command);
  const leaf = path.basename(parent).toLowerCase();
  return leaf === "bin" || leaf === "scripts" ? path.dirname(parent) : null;
}

function runtimeOptionsFromConfig(config = {}, env = process.env) {
  return { command: config && config.command, env: { ...env, ...(config && config.env || {}) } };
}

function hasExplicitRuntime(options = {}) {
  const env = options.env || process.env;
  return Object.prototype.hasOwnProperty.call(options, "runtimeRoot") ||
    Object.prototype.hasOwnProperty.call(env, "MCP_STATA_RUNTIME_ROOT") ||
    runtimeRootFromCommand(options.command) !== null;
}

function explicitRuntimeRoot(options = {}) {
  const env = options.env || process.env;
  const candidate = Object.prototype.hasOwnProperty.call(options, "runtimeRoot")
    ? options.runtimeRoot
    : Object.prototype.hasOwnProperty.call(env, "MCP_STATA_RUNTIME_ROOT")
      ? env.MCP_STATA_RUNTIME_ROOT : runtimeRootFromCommand(options.command);
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error("An explicit runtime root must be an absolute path");
  }
  return path.resolve(candidate);
}

function runtimeRootFromUvCommand(command, options = {}) {
  if (!command) return null;
  const executable = path.basename(command).toLowerCase();
  if (!["uv", "uv.exe", "uvx", "uvx.exe"].includes(executable)) return null;
  const prefix = executable === "uv" || executable === "uv.exe"
    ? ["tool", "run"]
    : [];
  const packageSpec = options.packageSpec || "mcp-stata==1.26.1";
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  try {
    const result = spawnSync(
      command,
      [...prefix, "--from", packageSpec, "--with", "mcp<2", "python", "-I", "-c", "import sys; print(sys.prefix)"],
      { encoding: "utf8", timeout: options.timeoutMs || 15000, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result && result.status === 0) {
      const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const resolved = lines.reverse().find((line) => path.isAbsolute(line));
      return resolved ? path.resolve(resolved) : null;
    }
  } catch {}
  return null;
}

function candidateRuntimeRoots(options = {}) {
  // An explicit environment is a boundary, never a hint to try before shared home.
  if (hasExplicitRuntime(options)) return [explicitRuntimeRoot(options)];
  // Workbench runtime precedence: configured/fixed installs before disposable uv caches.
  // Explicit roots returned above never participate in fallback discovery.
  const roots = new Set();

  const env = options.env || process.env;
  const home = options.homedir || os.homedir();
  if (home) {
    addCandidate(roots, path.join(home, ".local", "share", "stata-workbench", "mcp-stata-1.26.1"));
    addCandidate(roots, path.join(home, "AppData", "Local", "stata-workbench", "mcp-stata-1.26.1"));
  }
  if (env.LOCALAPPDATA) {
    addCandidate(roots, path.join(env.LOCALAPPDATA, "stata-workbench", "mcp-stata-1.26.1"));
  }
  addCandidate(roots, options.uvRuntimeRoot);
  addCandidate(roots, runtimeRootFromUvCommand(options.uvCommand, options));
  return [...roots];
}

function serverPathForRoot(root) {
  const candidates = pythonSitePackageRoots(root)
    .map((sitePackages) => path.join(sitePackages, "mcp_stata", "server.py"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function clientPathForRoot(root) {
  const candidates = pythonSitePackageRoots(root)
    .map((sitePackages) => path.join(sitePackages, "mcp_stata", "stata_client.py"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function graphDetectorPathForRoot(root) {
  const candidates = pythonSitePackageRoots(root)
    .map((sitePackages) => path.join(sitePackages, "mcp_stata", "graph_detector.py"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function sessionPathForRoot(root) {
  const candidates = pythonSitePackageRoots(root)
    .map((sitePackages) => path.join(sitePackages, "mcp_stata", "sessions.py"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function pythonSitePackageRoots(root) {
  const candidates = [path.join(root, "Lib", "site-packages")];
  const lib = path.join(root, "lib");
  try {
    for (const name of fs.readdirSync(lib).sort()) {
      if (/^python\d+(?:\.\d+)*$/i.test(name)) {
        candidates.unshift(path.join(lib, name, "site-packages"));
      }
    }
  } catch {}
  return candidates;
}

function pythonCommandForRoot(root, options = {}) {
  if (options.pythonCommand) return options.pythonCommand;
  const candidates = process.platform === "win32"
    ? [
      path.join(root, "Scripts", "python.exe"),
      path.join(root, "python.exe"),
    ]
    : [
      path.join(root, "bin", "python3"),
      path.join(root, "bin", "python"),
    ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function compilePythonSources(root, sources, options = {}) {
  // Compile every candidate module before any runtime byte is replaced.
  const pythonCommand = pythonCommandForRoot(root, options);
  if (!pythonCommand) {
    return {
      ok: false,
      status: "python-not-found",
      root,
    };
  }
  const spawnSync = options.compileSpawnSync || childProcess.spawnSync;
  const compiler = [
    "import json, sys",
    // Read bytes: Windows text stdin uses the ANSI code page (cp936 on the test
    // machine), which turns UTF-8 source into surrogates and fails compile().
    "items = json.loads(sys.stdin.buffer.read())",
    "for item in items:",
    "    compile(item['source'], item['path'], 'exec')",
  ].join("\n");
  let result;
  try {
    result = spawnSync(
      pythonCommand,
      ["-I", "-c", compiler],
      {
        encoding: "utf8",
        input: JSON.stringify(sources),
        timeout: options.compileTimeoutMs || 15000,
        maxBuffer: options.compileMaxBuffer || (8 * 1024 * 1024),
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  } catch (error) {
    return {
      ok: false,
      status: "python-compile-threw",
      root,
      pythonCommand,
      error: error && error.message ? error.message : String(error),
    };
  }
  if (!result || result.status !== 0) {
    return {
      ok: false,
      status: "python-compile-failed",
      root,
      pythonCommand,
      exitCode: result ? result.status : null,
      signal: result ? result.signal || null : null,
      stderr: String(result && result.stderr || "").trim().slice(-4000),
      stdout: String(result && result.stdout || "").trim().slice(-1000),
      error: result && result.error
        ? (result.error.message || String(result.error))
        : null,
    };
  }
  return { ok: true, status: "python-compile-ok", root, pythonCommand };
}

// Windows wheels/installs can carry CRLF. Anchors are LF, so patch an LF view
// and write each file back with the line endings it had (see withOriginalEol).
function lfSource(bytes) {
  return bytes.toString("utf8").replace(/\r\n/g, "\n");
}

function withOriginalEol(original, source) {
  return original.includes("\r\n") ? source.replace(/\r?\n/g, "\r\n") : source;
}

function atomicWrite(file, content, mode) {
  const stat = fs.statSync(file);
  const temporary = `${file}.stata-workbench-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: mode == null ? stat.mode : mode });
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {}
  }
}

function patchRuntime(options = {}) {
  // Reject a positional root/options pair before discovery can select and write
  // the default live runtime. JavaScript otherwise silently ignores argument 2.
  if (arguments.length > 1 || options === null || typeof options !== "object" ||
      Array.isArray(options) ||
      (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) {
    return { ok: false, status: "invalid-options",
      error: "patchRuntime requires one options object; dryRun must be boolean" };
  }
  let roots;
  try { roots = candidateRuntimeRoots(options); }
  catch (error) { return { ok: false, status: "invalid-runtime-root", error: error.message }; }
  const located = roots
    .map((root) => ({
      root,
      serverPath: serverPathForRoot(root),
      clientPath: clientPathForRoot(root),
      graphDetectorPath: graphDetectorPathForRoot(root),
      sessionPath: sessionPathForRoot(root),
    }))
    .find((entry) => entry.serverPath && entry.clientPath &&
      entry.graphDetectorPath && entry.sessionPath);
  if (!located) {
    return { ok: false, status: "not-found", roots };
  }
  if (hasExplicitRuntime(options)) {
    // A site-packages symlink must not turn an isolated patch into a shared write.
    const realRoot = fs.realpathSync(located.root);
    for (const key of ["serverPath", "clientPath", "graphDetectorPath", "sessionPath"]) {
      const relative = path.relative(realRoot, fs.realpathSync(located[key]));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return { ok: false, status: "runtime-path-escape", component: key, roots };
      }
    }
  }

  const sessionBytes = fs.readFileSync(located.sessionPath);
  const sessionSource = lfSource(sessionBytes);
  let patchedSession = sessionSource;
  let sessionStatus = "already-applied";
  if (!sessionSource.includes(SESSION_BREAK_DRAIN_PATCH_MARKER)) {
    const count = patchedSession.split(ORIGINAL_SESSION_CALL).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "session",
        anchor: "worker-break-drain",
        ...located,
        anchorCount: count,
      };
    }
    patchedSession = patchedSession.replace(ORIGINAL_SESSION_CALL, PATCHED_SESSION_CALL);
    sessionStatus = options.dryRun ? "would-apply" : "applied";
  }

  try {
    const next = sessionHealthPatch.patchSessions(patchedSession);
    if (next !== patchedSession) sessionStatus = options.dryRun ? "would-apply" : "applied";
    patchedSession = next;
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "session-health", error: error.message, ...located };
  }

  const serverBytes = fs.readFileSync(located.serverPath);
  const serverSource = lfSource(serverBytes);
  let patchedServer = serverSource;
  let serverStatus = "already-applied";
  try {
    const next = sessionHealthPatch.patchServer(patchedServer);
    if (next !== patchedServer) serverStatus = options.dryRun ? "would-apply" : "applied";
    patchedServer = next;
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "server-event-loop", error: error.message, ...located };
  }
  if (!serverSource.includes(PATCH_MARKER)) {
    const count = patchedServer.split(ORIGINAL_CALL_SYNC).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        ...located,
        anchorCount: count,
      };
    }
    patchedServer = patchedServer.replace(ORIGINAL_CALL_SYNC, PATCHED_CALL_SYNC);
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!serverSource.includes(TASK_DONE_PATCH_MARKER)) {
    const count = patchedServer.split(ORIGINAL_TASK_DONE_NOTIFY).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        anchor: "task-done-notify",
        ...located,
        anchorCount: count,
      };
    }
    patchedServer = patchedServer.replace(
      ORIGINAL_TASK_DONE_NOTIFY,
      PATCHED_TASK_DONE_NOTIFY
    );
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!serverSource.includes(LOG_PATH_NOTIFY_PATCH_MARKER)) {
    const headCount = patchedServer.split(ORIGINAL_BACKGROUND_NOTIFY_HEAD).length - 1;
    const sendCount = patchedServer.split(ORIGINAL_BACKGROUND_NOTIFY_SEND).length - 1;
    if (headCount !== 2 || sendCount !== 2) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        anchor: "bounded-background-log-path-notify",
        ...located,
        headAnchorCount: headCount,
        sendAnchorCount: sendCount,
      };
    }
    patchedServer = patchedServer
      .replaceAll(ORIGINAL_BACKGROUND_NOTIFY_HEAD, PATCHED_BACKGROUND_NOTIFY_HEAD)
      .replaceAll(ORIGINAL_BACKGROUND_NOTIFY_SEND, PATCHED_BACKGROUND_NOTIFY_SEND);
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!patchedServer.includes(CHECKPOINT_NOTIFY_PATCH_MARKER)) {
    const count = patchedServer.split(PATCHED_BACKGROUND_NOTIFY_HEAD_V1).length - 1;
    if (count !== 2) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        anchor: "quiet-checkpoint-notifications",
        ...located,
        anchorCount: count,
      };
    }
    patchedServer = patchedServer.replaceAll(
      PATCHED_BACKGROUND_NOTIFY_HEAD_V1,
      PATCHED_BACKGROUND_NOTIFY_HEAD
    );
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!patchedServer.includes(CHECKPOINT_GRAPH_CACHE_PATCH_MARKER) &&
      !patchedServer.includes(RESPECT_BACKGROUND_GRAPH_READY_PATCH_MARKER)) {
    const count = patchedServer.split(ORIGINAL_BACKGROUND_GRAPH_READY_OPTION).length - 1;
    if (count !== 2) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        anchor: "quiet-checkpoint-graph-cache",
        ...located,
        anchorCount: count,
      };
    }
    patchedServer = patchedServer.replaceAll(
      ORIGINAL_BACKGROUND_GRAPH_READY_OPTION,
      PATCHED_BACKGROUND_GRAPH_READY_OPTION
    );
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!patchedServer.includes(RESPECT_BACKGROUND_GRAPH_READY_PATCH_MARKER)) {
    const doFileSignatureCount = patchedServer.split(
      ORIGINAL_DOFILE_BACKGROUND_SIGNATURE
    ).length - 1;
    const commandSignatureCount = patchedServer.split(
      ORIGINAL_COMMAND_BACKGROUND_SIGNATURE
    ).length - 1;
    const checkpointOptionCount = patchedServer.split(
      PATCHED_BACKGROUND_GRAPH_READY_OPTION
    ).length - 1;
    const originalOptionCount = patchedServer.split(
      ORIGINAL_BACKGROUND_GRAPH_READY_OPTION
    ).length - 1;
    if (doFileSignatureCount !== 1 || commandSignatureCount !== 1 ||
        (checkpointOptionCount !== 2 && originalOptionCount !== 2)) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "server",
        anchor: "respect-background-graph-ready",
        ...located,
        doFileSignatureCount,
        commandSignatureCount,
        checkpointOptionCount,
        originalOptionCount,
      };
    }
    const optionSource = checkpointOptionCount === 2
      ? PATCHED_BACKGROUND_GRAPH_READY_OPTION
      : ORIGINAL_BACKGROUND_GRAPH_READY_OPTION;
    patchedServer = patchedServer
      .replace(
        ORIGINAL_DOFILE_BACKGROUND_SIGNATURE,
        PATCHED_DOFILE_BACKGROUND_SIGNATURE
      )
      .replace(
        ORIGINAL_COMMAND_BACKGROUND_SIGNATURE,
        PATCHED_COMMAND_BACKGROUND_SIGNATURE
      )
      .replaceAll(
        optionSource,
        PATCHED_RESPECT_BACKGROUND_GRAPH_READY_OPTION
      );
    serverStatus = options.dryRun ? "would-apply" : "applied";
  }

  const clientBytes = fs.readFileSync(located.clientPath);
  const clientSource = lfSource(clientBytes);
  let patchedClient = clientSource;
  let clientStatus = "already-applied";
  try {
    patchedClient = logQueryPatch.normalizeClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "owned-log-query", error: error.message, ...located };
  }
  if (!patchedClient.includes(STATA_SET_BREAK_PATCH_MARKER)) {
    const count = patchedClient.split(ORIGINAL_STATA_BREAK_REQUEST).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "client",
        anchor: "supported-stata-break-api",
        ...located,
        anchorCount: count,
      };
    }
    patchedClient = patchedClient.replace(
      ORIGINAL_STATA_BREAK_REQUEST,
      PATCHED_STATA_BREAK_REQUEST
    );
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!clientSource.includes(STREAM_PATCH_MARKER)) {
    const replacements = clientSource.includes(STREAM_PATCH_MARKER_V19)
      ? [["stream-helper-v19", PATCHED_STREAM_HELPER_V19, PATCHED_STREAM_HELPER]]
      : clientSource.includes(STREAM_PATCH_MARKER_V18)
      ? [["stream-helper-v18", PATCHED_STREAM_HELPER_V18, PATCHED_STREAM_HELPER]]
      : clientSource.includes(STREAM_PATCH_MARKER_V17)
      ? [["stream-helper-v17", PATCHED_STREAM_HELPER_V17, PATCHED_STREAM_HELPER]]
      : [
        ["stream-helper", ORIGINAL_STREAM_HELPER, PATCHED_STREAM_HELPER],
        ["stream-notify", ORIGINAL_STREAM_NOTIFY, PATCHED_STREAM_NOTIFY],
        ["final-stream-notify", ORIGINAL_FINAL_STREAM_NOTIFY, PATCHED_FINAL_STREAM_NOTIFY],
      ];
    for (const [anchor, original, replacement] of replacements) {
      const count = patchedClient.split(original).length - 1;
      if (count !== 1) {
        return {
          ok: false,
          status: "unsupported-source",
          component: "client",
          anchor,
          ...located,
          anchorCount: count,
        };
      }
      patchedClient = patchedClient.replace(original, replacement);
    }
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }
  const tailHelperCount = patchedClient.split(PATCHED_STREAM_HELPER).length - 1;
  const legacyTailHelperCount = patchedClient.split(LEGACY_STREAM_HELPER_WITHOUT_TAIL).length - 1;
  const separatorHelperCount = patchedClient.split(PATCHED_STREAM_HELPER_WITH_SEPARATORS).length - 1;
  if (tailHelperCount === 0 && legacyTailHelperCount === 1 && separatorHelperCount === 0) {
    patchedClient = patchedClient.replace(LEGACY_STREAM_HELPER_WITHOUT_TAIL, () => PATCHED_STREAM_HELPER);
  } else if (tailHelperCount === 0 && legacyTailHelperCount === 0 && separatorHelperCount === 1) {
    patchedClient = patchedClient.replace(PATCHED_STREAM_HELPER_WITH_SEPARATORS, () => PATCHED_STREAM_HELPER);
  } else if (tailHelperCount !== 1 || legacyTailHelperCount !== 0 || separatorHelperCount !== 0) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "completion-tail-helper", tailHelperCount, legacyTailHelperCount, ...located };
  }
  if (!patchedClient.includes(STREAM_TAIL_PATCH_MARKER)) {
    const signatureCount = patchedClient.split(ORIGINAL_STREAM_TAIL_SIGNATURE).length - 1;
    const drainCount = patchedClient.split(ORIGINAL_POST_DONE_DRAIN).length - 1;
    const callCount = patchedClient.split(ORIGINAL_STREAM_CALL_TAIL).length - 1;
    if (signatureCount !== 1 || drainCount !== 1 || callCount !== 2) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "client",
        anchor: "per-run-log-tail-convergence",
        ...located,
        signatureCount,
        drainCount,
        callCount,
      };
    }
    patchedClient = patchedClient
      .replace(ORIGINAL_STREAM_TAIL_SIGNATURE, PATCHED_STREAM_TAIL_SIGNATURE)
      .replace(ORIGINAL_POST_DONE_DRAIN, PATCHED_POST_DONE_DRAIN)
      .replace(ORIGINAL_STREAM_CALL_TAIL, PATCHED_STREAM_CALL_TAIL_COMMAND)
      .replace(ORIGINAL_STREAM_CALL_TAIL, PATCHED_STREAM_CALL_TAIL_DOFILE);
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!clientSource.includes(GRAPH_PROBE_PATCH_MARKER)) {
    const count = patchedClient.split(ORIGINAL_CLIENT_GRAPH_INVENTORY).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "client",
        anchor: "quiet-graph-inventory",
        ...located,
        anchorCount: count,
      };
    }
    patchedClient = patchedClient.replace(
      ORIGINAL_CLIENT_GRAPH_INVENTORY,
      PATCHED_CLIENT_GRAPH_INVENTORY
    );
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!clientSource.includes(INTERNAL_SILENT_PATCH_MARKER)) {
    const count = patchedClient.split(ORIGINAL_INTERNAL_SILENT_EXEC).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "client",
        anchor: "quiet-internal-no-capture",
        ...located,
        anchorCount: count,
      };
    }
    patchedClient = patchedClient.replace(
      ORIGINAL_INTERNAL_SILENT_EXEC,
      PATCHED_INTERNAL_SILENT_EXEC
    );
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }
  if (!clientSource.includes(GRAPH_CACHE_DRAIN_PATCH_MARKER)) {
    const commandCount = patchedClient.split(ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND).length - 1;
    const doFileCount = patchedClient.split(ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE).length - 1;
    if (commandCount !== 1 || doFileCount !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "client",
        anchor: "drain-background-graph-cache",
        ...located,
        commandAnchorCount: commandCount,
        doFileAnchorCount: doFileCount,
      };
    }
    patchedClient = patchedClient
      .replace(
        ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND,
        PATCHED_BACKGROUND_GRAPH_CACHE_COMMAND
      )
      .replace(
        ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE,
        PATCHED_BACKGROUND_GRAPH_CACHE_DOFILE
      );
    clientStatus = options.dryRun ? "would-apply" : "applied";
  }

  try {
    const streamPatched = streamStatePatch.patchClient(patchedClient);
    if (streamPatched !== patchedClient) {
      patchedClient = streamPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "streaming-worker-state",
      error: error.message,
      ...located,
    };
  }

  try {
    const logsPatched = smclLogPatch.patchClient(patchedClient);
    if (logsPatched !== patchedClient) {
      patchedClient = logsPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "named-smcl-log-only",
      error: error.message,
      ...located,
    };
  }

  try {
    const rcPatched = responseRcPatch.patchClient(patchedClient);
    if (rcPatched !== patchedClient) {
      patchedClient = rcPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "execution-response-rc",
      error: error.message,
      ...located,
    };
  }

  try {
    const readPatched = rcReadPatch.patchClient(patchedClient);
    if (readPatched !== patchedClient) {
      patchedClient = readPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "readonly-rc-reader",
      error: error.message,
      ...located,
    };
  }

  try {
    const silentPatched = silentStatePatch.patchClient(patchedClient);
    if (silentPatched !== patchedClient) {
      patchedClient = silentPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "silent-maintenance-state",
      error: error.message,
      ...located,
    };
  }

  try {
    const capturePatched = captureStatePatch.patchClient(patchedClient);
    if (capturePatched !== patchedClient) {
      patchedClient = capturePatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return {
      ok: false,
      status: "unsupported-source",
      component: "client",
      anchor: "capture-request-state",
      error: error.message,
      ...located,
    };
  }

  try {
    // Lifecycle replaces the graph patches' exception boundary. Validate the
    // complete final candidate before normalizing those upstream anchors.
    patchedClient = streamLifecyclePatch.normalizeClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "streaming-lifecycle", error: error.message, ...located };
  }

  try {
    patchedClient = bulkCachePatch.normalizeClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "bulk-cache", error: error.message, ...located };
  }

  try {
    const graphPatched = graphTaskDrainPatch.patchClient(patchedClient);
    if (graphPatched !== patchedClient) {
      patchedClient = graphPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "graph-task-drain", error: error.message, ...located };
  }

  try {
    const errorsPatched = graphErrorPatch.patchClient(patchedClient);
    if (errorsPatched !== patchedClient) {
      patchedClient = errorsPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "graph-error-propagation", error: error.message, ...located };
  }

  try {
    const inventoryPatched = graphInventoryPatch.patchClient(patchedClient);
    if (inventoryPatched !== patchedClient) {
      patchedClient = inventoryPatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "graph-inventory-state", error: error.message, ...located };
  }

  try {
    const lifecyclePatched = streamLifecyclePatch.patchClient(patchedClient);
    if (lifecyclePatched !== patchedClient) {
      patchedClient = lifecyclePatched;
      clientStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "streaming-lifecycle", error: error.message, ...located };
  }
  try {
    patchedClient = helpStatePatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "help-state", error: error.message, ...located };
  }
  // Only final bytes determine whether the normalized composition changed.
  try {
    patchedClient = cacheTransactionPatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "cache-transaction", error: error.message, ...located };
  }
  try {
    patchedClient = exportStatePatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "export-state", error: error.message, ...located };
  }
  try {
    patchedClient = storedResultsPatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "stored-results", error: error.message, ...located };
  }
  try {
    patchedClient = startupStatePatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "startup-state", error: error.message, ...located };
  }
  try {
    patchedClient = bulkCachePatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "bulk-cache", error: error.message, ...located };
  }
  try {
    patchedClient = logQueryPatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "owned-log-query", error: error.message, ...located };
  }
  try {
    patchedClient = graphNameBoundaryPatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "graph-name-boundary", error: error.message, ...located };
  }
  try {
    patchedClient = preflightTimeoutPatch.patchClient(patchedClient);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "preflight-timeout", error: error.message, ...located };
  }
  // Check the final composition, after every subsidiary transform. A later
  // patch must not leave the completion drain without its local state.
  if (patchedClient.split(PATCHED_POST_DONE_DRAIN).length - 1 !== 1 ||
      patchedClient.split(PATCHED_STREAM_HELPER).length - 1 !== 1) {
    return { ok: false, status: "unsupported-source", component: "client",
      anchor: "final-completion-tail-composition", ...located };
  }
  clientStatus = patchedClient === clientSource ? "already-applied"
    : (options.dryRun ? "would-apply" : "applied");

  const graphDetectorBytes = fs.readFileSync(located.graphDetectorPath);
  const graphDetectorSource = lfSource(graphDetectorBytes);
  let patchedGraphDetector = graphDetectorSource;
  let graphDetectorStatus = "already-applied";
  if (!graphDetectorSource.includes(GRAPH_PROBE_PATCH_MARKER)) {
    const dirCount = patchedGraphDetector.split(ORIGINAL_DETECTOR_GRAPH_DIR).length - 1;
    const describeCount = patchedGraphDetector.split(ORIGINAL_DETECTOR_GRAPH_DESCRIBE).length - 1;
    if (dirCount !== 2 || describeCount !== 1) {
      return {
        ok: false,
        status: "unsupported-source",
        component: "graph-detector",
        anchor: "quiet-graph-probes",
        ...located,
        dirAnchorCount: dirCount,
        describeAnchorCount: describeCount,
      };
    }
    patchedGraphDetector = patchedGraphDetector
      .replaceAll(ORIGINAL_DETECTOR_GRAPH_DIR, PATCHED_DETECTOR_GRAPH_DIR)
      .replace(ORIGINAL_DETECTOR_GRAPH_DESCRIBE, PATCHED_DETECTOR_GRAPH_DESCRIBE)
      .replace(
        "class GraphCreationDetector:",
        `# ${GRAPH_PROBE_PATCH_MARKER}\nclass GraphCreationDetector:`
      );
    graphDetectorStatus = options.dryRun ? "would-apply" : "applied";
  }

  try {
    patchedGraphDetector = cacheTransactionPatch.normalizeDetector(patchedGraphDetector);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "graph-detector",
      anchor: "cache-transaction", error: error.message, ...located };
  }
  try {
    const drainedDetector = graphTaskDrainPatch.patchDetector(patchedGraphDetector);
    if (drainedDetector !== patchedGraphDetector) {
      patchedGraphDetector = drainedDetector;
      graphDetectorStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "graph-detector",
      anchor: "graph-thread-drain", error: error.message, ...located };
  }

  try {
    const callbacksPatched = graphCallbackPatch.patchDetector(patchedGraphDetector);
    if (callbacksPatched !== patchedGraphDetector) {
      patchedGraphDetector = callbacksPatched;
      graphDetectorStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "graph-detector",
      anchor: "graph-callback-errors", error: error.message, ...located };
  }

  try {
    // Normalize only exact state candidates for the upstream SHA-bound transform.
    // Compare the complete final candidate so repeated application is a no-op.
    const normalizedDetector = detectorStatePatch.normalizeDetector(
      detectorSreturnPatch.normalizeDetector(patchedGraphDetector));
    const detectorErrorsPatched = detectorSreturnPatch.patchDetector(detectorStatePatch.patchDetector(
      detectorErrorPatch.patchDetector(normalizedDetector)));
    if (detectorErrorsPatched !== patchedGraphDetector) {
      patchedGraphDetector = detectorErrorsPatched;
      graphDetectorStatus = options.dryRun ? "would-apply" : "applied";
    }
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "graph-detector",
      anchor: "detector-error-propagation", error: error.message, ...located };
  }

  try {
    patchedGraphDetector = cacheTransactionPatch.patchDetector(patchedGraphDetector);
  } catch (error) {
    return { ok: false, status: "unsupported-source", component: "graph-detector",
      anchor: "cache-transaction", error: error.message, ...located };
  }
  graphDetectorStatus = patchedGraphDetector === graphDetectorSource ? "already-applied"
    : (options.dryRun ? "would-apply" : "applied");

  const changed = serverStatus !== "already-applied" ||
    clientStatus !== "already-applied" ||
    graphDetectorStatus !== "already-applied" ||
    sessionStatus !== "already-applied";
  const files = [
    {
      component: "server",
      path: located.serverPath,
      original: serverBytes,
      source: patchedServer,
    },
    {
      component: "client",
      path: located.clientPath,
      original: clientBytes,
      source: patchedClient,
    },
    {
      component: "graph-detector",
      path: located.graphDetectorPath,
      original: graphDetectorBytes,
      source: patchedGraphDetector,
    },
    {
      component: "session",
      path: located.sessionPath,
      original: sessionBytes,
      source: patchedSession,
    },
  ];
  for (const file of files) file.source = withOriginalEol(file.original, file.source);
  const preWriteCompile = compilePythonSources(
    located.root,
    files.map((file) => ({ path: file.path, source: file.source })),
    options
  );
  if (!preWriteCompile.ok) {
    return {
      ok: false,
      status: "pre-write-compile-failed",
      compile: preWriteCompile,
      changed,
      serverStatus,
      clientStatus,
      graphDetectorStatus,
      sessionStatus,
      ...located,
    };
  }

  if (!options.dryRun && changed) {
    // Runtime patch writes are one transaction: any failure restores every original byte.
    const write = options.atomicWrite || atomicWrite;
    const changedFiles = files.filter(
      (file) => !file.original.equals(Buffer.from(file.source, "utf8"))
    );
    let transactionError = null;
    try {
      for (const file of changedFiles) write(file.path, file.source);
      for (const file of files) {
        const actual = fs.readFileSync(file.path);
        const expected = Buffer.from(file.source, "utf8");
        if (!actual.equals(expected)) {
          throw new Error(`post-write byte mismatch: ${file.component}`);
        }
      }
      const postWriteCompile = compilePythonSources(
        located.root,
        files.map((file) => ({
          path: file.path,
          source: fs.readFileSync(file.path, "utf8"),
        })),
        options
      );
      if (!postWriteCompile.ok) {
        const error = new Error("post-write Python compilation failed");
        error.compile = postWriteCompile;
        throw error;
      }
    } catch (error) {
      transactionError = error;
    }
    if (transactionError) {
      const rollbackErrors = [];
      for (const file of files) {
        try {
          write(file.path, file.original);
        } catch (error) {
          rollbackErrors.push({
            component: file.component,
            path: file.path,
            error: error && error.message ? error.message : String(error),
          });
        }
      }
      for (const file of files) {
        try {
          if (!fs.readFileSync(file.path).equals(file.original)) {
            rollbackErrors.push({
              component: file.component,
              path: file.path,
              error: "rollback byte mismatch",
            });
          }
        } catch (error) {
          rollbackErrors.push({
            component: file.component,
            path: file.path,
            error: error && error.message ? error.message : String(error),
          });
        }
      }
      return {
        ok: false,
        status: rollbackErrors.length
          ? "write-transaction-rollback-failed"
          : "write-transaction-rolled-back",
        error: transactionError && transactionError.message
          ? transactionError.message
          : String(transactionError),
        compile: transactionError && transactionError.compile
          ? transactionError.compile
          : null,
        rollbackOk: rollbackErrors.length === 0,
        rollbackErrors,
        changed,
        serverStatus,
        clientStatus,
        graphDetectorStatus,
        sessionStatus,
        ...located,
      };
    }
  }
  return {
    ok: true,
    status: changed ? (options.dryRun ? "would-apply" : "applied") : "already-applied",
    compile: preWriteCompile,
    serverStatus,
    clientStatus,
    graphDetectorStatus,
    sessionStatus,
    ...located,
  };
}

module.exports = {
  ORIGINAL_CALL_SYNC,
  ORIGINAL_BACKGROUND_NOTIFY_HEAD,
  ORIGINAL_BACKGROUND_NOTIFY_SEND,
  ORIGINAL_BACKGROUND_GRAPH_CACHE_COMMAND,
  ORIGINAL_BACKGROUND_GRAPH_CACHE_DOFILE,
  ORIGINAL_BACKGROUND_GRAPH_READY_OPTION,
  ORIGINAL_COMMAND_BACKGROUND_SIGNATURE,
  ORIGINAL_DOFILE_BACKGROUND_SIGNATURE,
  ORIGINAL_CLIENT_GRAPH_INVENTORY,
  ORIGINAL_DETECTOR_GRAPH_DESCRIBE,
  ORIGINAL_DETECTOR_GRAPH_DIR,
  ORIGINAL_FINAL_STREAM_NOTIFY,
  ORIGINAL_POST_DONE_DRAIN,
  ORIGINAL_STREAM_CALL_TAIL,
  ORIGINAL_STREAM_HELPER,
  ORIGINAL_STREAM_NOTIFY,
  ORIGINAL_STREAM_TAIL_SIGNATURE,
  ORIGINAL_TASK_DONE_NOTIFY,
  ORIGINAL_SESSION_CALL,
  ORIGINAL_STATA_BREAK_REQUEST,
  PATCHED_CALL_SYNC,
  PATCHED_BACKGROUND_NOTIFY_HEAD,
  PATCHED_BACKGROUND_NOTIFY_HEAD_V1,
  PATCHED_BACKGROUND_NOTIFY_SEND,
  PATCHED_BACKGROUND_GRAPH_CACHE_COMMAND,
  PATCHED_BACKGROUND_GRAPH_CACHE_DOFILE,
  PATCHED_BACKGROUND_GRAPH_READY_OPTION,
  PATCHED_COMMAND_BACKGROUND_SIGNATURE,
  PATCHED_DOFILE_BACKGROUND_SIGNATURE,
  PATCHED_RESPECT_BACKGROUND_GRAPH_READY_OPTION,
  PATCHED_CLIENT_GRAPH_INVENTORY,
  PATCHED_DETECTOR_GRAPH_DESCRIBE,
  PATCHED_DETECTOR_GRAPH_DIR,
  PATCHED_FINAL_STREAM_NOTIFY,
  PATCHED_POST_DONE_DRAIN,
  PATCHED_STREAM_CALL_TAIL_COMMAND,
  PATCHED_STREAM_CALL_TAIL_DOFILE,
  PATCHED_STREAM_HELPER,
  PATCHED_STREAM_HELPER_WITH_SEPARATORS,
  LEGACY_STREAM_HELPER_WITHOUT_TAIL,
  PATCHED_STREAM_HELPER_V17,
  PATCHED_STREAM_HELPER_V18,
  PATCHED_STREAM_HELPER_V19,
  PATCHED_STREAM_NOTIFY,
  PATCHED_STREAM_TAIL_SIGNATURE,
  PATCHED_TASK_DONE_NOTIFY,
  PATCHED_SESSION_CALL,
  PATCHED_STATA_BREAK_REQUEST,
  PATCH_MARKER,
  GRAPH_PROBE_PATCH_MARKER,
  GRAPH_CACHE_DRAIN_PATCH_MARKER,
  CHECKPOINT_GRAPH_CACHE_PATCH_MARKER,
  RESPECT_BACKGROUND_GRAPH_READY_PATCH_MARKER,
  INTERNAL_SILENT_PATCH_MARKER,
  CHECKPOINT_NOTIFY_PATCH_MARKER,
  LOG_PATH_NOTIFY_PATCH_MARKER,
  ORIGINAL_INTERNAL_SILENT_EXEC,
  PATCHED_INTERNAL_SILENT_EXEC,
  STREAM_PATCH_MARKER,
  STREAM_TAIL_PATCH_MARKER,
  STREAM_PATCH_MARKER_V17,
  STREAM_PATCH_MARKER_V18,
  STREAM_PATCH_MARKER_V19,
  TASK_DONE_PATCH_MARKER,
  SESSION_BREAK_DRAIN_PATCH_MARKER,
  STATA_SET_BREAK_PATCH_MARKER,
  atomicWrite,
  candidateRuntimeRoots,
  clientPathForRoot,
  compilePythonSources,
  graphDetectorPathForRoot,
  hasExplicitRuntime,
  patchRuntime,
  pythonCommandForRoot,
  pythonSitePackageRoots,
  runtimeRootFromCommand,
  runtimeOptionsFromConfig,
  runtimeRootFromUvCommand,
  sessionPathForRoot,
  serverPathForRoot,
};
