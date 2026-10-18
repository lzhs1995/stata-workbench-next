"use strict";

// Each invocation owns its graph checks. No helper task may outlive the request.
const POLL = String.raw`        graph_poll_state = [0.0]
        graph_poll_interval = 0.75
        graph_poll_pending = False
        graph_poll_errors = []

        async def owned_graph_check() -> None:
            nonlocal graph_poll_pending
            try:
                await self._maybe_cache_graphs_on_chunk(
                    graph_cache=graph_cache,
                    emit_graph_ready=emit_graph_ready,
                    notify_log=notify_log,
                    graph_ready_task_id=graph_ready_task_id,
                    graph_ready_format=graph_ready_format,
                    graph_ready_initial=graph_ready_initial,
                    last_check=graph_poll_state,
                )
            except Exception as error:
                # Preserve the user command; report graph failures after it drains.
                graph_poll_errors.append(error)
            finally:
                graph_poll_pending = False

        async def on_chunk_for_graphs(_chunk: str) -> None:
            nonlocal graph_poll_pending
            now = time.monotonic()
            if graph_poll_pending or (graph_poll_state and now - graph_poll_state[0] < graph_poll_interval):
                return
            # Workbench request owns graph polling until task-group exit.
            graph_poll_pending = True
            try:
                tg.start_soon(owned_graph_check)
            except BaseException:
                graph_poll_pending = False
                raise

`;

const EXIT = String.raw`        except* Exception as exc_group:
            logger.debug("SMCL streaming task group failed: %s", exc_group)
            graph_poll_errors.append(exc_group)
        finally:
            tee.close()

        if graph_poll_errors:
            failures = ([exc] if exc is not None else []) + graph_poll_errors
            exc = ExceptionGroup("Streaming maintenance failed", failures)
            if rc in (-1, 0):
                rc = 1

        # Re-run startup .do files when programs have been dropped.`;

const OWNED_CALL = String.raw`    async def _run_owned_graph_call(self, function, *args):
        # Workbench graph threads drain under both AnyIO and asyncio cancellation.
        # asyncio.to_thread alone abandons its real thread when its waiter cancels.
        import anyio
        cancellation = None
        with anyio.CancelScope(shield=True):
            worker = asyncio.create_task(asyncio.to_thread(function, *args))
            while not worker.done():
                try:
                    # wait() cancellation never cancels its input tasks and does
                    # not create abandoned shield futures that report worker errors.
                    await asyncio.wait({worker})
                except asyncio.CancelledError as error:
                    cancellation = error
        if cancellation is not None:
            # Retrieve any worker error before propagating the caller's cancel.
            if not worker.cancelled():
                worker.exception()
            raise cancellation
        # Deliver deferred AnyIO cancellation even when the drained worker failed.
        try:
            await anyio.lowlevel.checkpoint()
        except asyncio.CancelledError:
            # Cancellation wins, but the worker's exception must still be consumed.
            if not worker.cancelled():
                worker.exception()
            raise
        return worker.result()

`;

const ORIGINAL_POLL = "        graph_poll_state = [0.0]\n        graph_poll_interval = 0.75\n\n        async def on_chunk_for_graphs(_chunk: str) -> None:\n            now = time.monotonic()\n            if graph_poll_state and now - graph_poll_state[0] < graph_poll_interval:\n                return\n            # Background the graph check so we don't block SMCL streaming or task completion\n            asyncio.create_task(\n                self._maybe_cache_graphs_on_chunk(\n                    graph_cache=graph_cache,\n                    emit_graph_ready=emit_graph_ready,\n                    notify_log=notify_log,\n                    graph_ready_task_id=graph_ready_task_id,\n                    graph_ready_format=graph_ready_format,\n                    graph_ready_initial=graph_ready_initial,\n                    last_check=graph_poll_state,\n                )\n            )\n\n";
const ORIGINAL_EXIT = "        except* Exception as exc_group:\n            logger.debug(\"SMCL streaming task group failed: %s\", exc_group)\n        finally:\n            tee.close()\n\n        # Re-run startup .do files when programs have been dropped.";
const ORIGINAL_DETECTOR = "    async def cache_detected_graphs_with_pystata(self) -> List[str]:\n        \"\"\"Enhanced caching method that uses pystata for real-time graph detection.\"\"\"\n        if not self.auto_cache:\n            return []\n        \n        cached_names = []\n        \n        # First, try to get any newly detected graphs via pystata state\n        if self.stata_client:\n            try:\n                # Get current state and check for new graphs\n                # _detect_graphs_via_pystata is sync and uses _exec_lock, must run in thread\n                import anyio\n                self.detector._inventory_cache_enabled = True\n                try:\n                    pystata_detected = await anyio.to_thread.run_sync(self.detector._detect_graphs_via_pystata)\n                finally:\n                    self.detector._inventory_cache_enabled = False\n                \n                # Add any newly detected graphs to cache queue\n                for graph_name in pystata_detected:\n                    if graph_name not in self._cached_graphs and graph_name not in self._removed_graphs:\n                        self._graphs_to_cache.append(graph_name)\n                        \n            except Exception as e:\n                logger.warning(f\"Failed to get pystata graph updates: {e}\")\n        \n        # Process the cache queue\n        with self._lock:\n            graphs_to_process = self._graphs_to_cache.copy()\n            self._graphs_to_cache.clear()\n\n        if not graphs_to_process:\n            return cached_names\n        \n        # Get current graph list for verification\n        try:\n            # list_graphs is sync and uses _exec_lock, must run in thread\n            import anyio\n            current_graphs = await anyio.to_thread.run_sync(self.stata_client.list_graphs)\n        except Exception as e:\n            logger.warning(f\"Failed to get current graph list: {e}\")\n            return cached_names\n        \n        for graph_name in graphs_to_process:\n            if graph_name in current_graphs and graph_name not in self._cached_graphs:\n                try:\n                    success = await asyncio.to_thread(self.stata_client.cache_graph_on_creation, graph_name)\n                    if success:\n                        cached_names.append(graph_name)\n                        with self._lock:\n                            self._cached_graphs.add(graph_name)\n                    \n                    # Notify callbacks\n                    await self._notify_cache_callbacks(graph_name, success)\n                \n                except Exception as e:\n                    logger.warning(f\"Failed to cache graph {graph_name}: {e}\")\n                    # Still notify callbacks of failure\n                    await self._notify_cache_callbacks(graph_name, False)\n        \n        return cached_names\n    \n    async def cache_detected_graphs(self) -> List[str]:\n        \"\"\"Cache all detected graphs.\"\"\"\n        if not self.auto_cache:\n            return []\n        \n        cached_names = []\n        \n        with self._lock:\n            graphs_to_process = self._graphs_to_cache.copy()\n            self._graphs_to_cache.clear()\n        \n        # Get current graph list for verification\n        try:\n            # list_graphs is sync and uses _exec_lock, must run in thread\n            import anyio\n            current_graphs = await anyio.to_thread.run_sync(self.stata_client.list_graphs)\n        except Exception as e:\n            logger.warning(f\"Failed to get current graph list: {e}\")\n            return cached_names\n        \n        for graph_name in graphs_to_process:\n            if graph_name in current_graphs and graph_name not in self._cached_graphs:\n                try:\n                    success = await asyncio.to_thread(self.stata_client.cache_graph_on_creation, graph_name)\n                    if success:\n                        cached_names.append(graph_name)\n                        with self._lock:\n                            self._cached_graphs.add(graph_name)\n                    \n                    # Notify callbacks\n                    await self._notify_cache_callbacks(graph_name, success)\n                \n                except Exception as e:\n                    logger.warning(f\"Failed to cache graph {graph_name}: {e}\")\n                    # Still notify callbacks of failure\n                    await self._notify_cache_callbacks(graph_name, False)\n        \n        return cached_names\n    \n";

const PREVIOUS_DETECTOR = OWNED_CALL + ORIGINAL_DETECTOR
  .replaceAll("await anyio.to_thread.run_sync(self.detector._detect_graphs_via_pystata)", "await self._run_owned_graph_call(self.detector._detect_graphs_via_pystata)")
  .replaceAll("await anyio.to_thread.run_sync(self.stata_client.list_graphs)", "await self._run_owned_graph_call(self.stata_client.list_graphs)")
  .replaceAll("await asyncio.to_thread(self.stata_client.cache_graph_on_creation, graph_name)", "await self._run_owned_graph_call(self.stata_client.cache_graph_on_creation, graph_name)");

const DETECTOR = OWNED_CALL + String.raw`    async def _cache_pending_graphs(self) -> List[str]:
        # Workbench graph failures propagate; unfinished cache entries remain pending.
        with self._lock:
            pending = list(dict.fromkeys(self._graphs_to_cache))
            self._graphs_to_cache.clear()
        if not pending:
            return []
        cached_names = []
        try:
            current = await self._run_owned_graph_call(self.stata_client.list_graphs)
            for name in pending:
                if name not in current or name in self._cached_graphs or name in self._removed_graphs:
                    continue
                try:
                    success = await self._run_owned_graph_call(self.stata_client.cache_graph_on_creation, name)
                    if success is not True:
                        raise RuntimeError("Graph cache did not succeed: " + name)
                except Exception as error:
                    try:
                        await self._notify_cache_callbacks(name, False)
                    except Exception as callback_error:
                        raise ExceptionGroup("Graph cache and failure callbacks failed",
                                             [error, callback_error]) from None
                    raise
                with self._lock:
                    self._cached_graphs.add(name)
                cached_names.append(name)
                await self._notify_cache_callbacks(name, True)
            return cached_names
        except BaseException:
            # Keep pending work on failure/cancel without re-running the user command.
            with self._lock:
                remaining = [name for name in pending
                             if name not in self._cached_graphs and name not in self._removed_graphs]
                self._graphs_to_cache = list(dict.fromkeys(remaining + self._graphs_to_cache))
            raise

    async def cache_detected_graphs_with_pystata(self) -> List[str]:
        if not self.auto_cache:
            return []
        if self.stata_client:
            self.detector._inventory_cache_enabled = True
            try:
                detected = await self._run_owned_graph_call(self.detector._detect_graphs_via_pystata)
            finally:
                self.detector._inventory_cache_enabled = False
            with self._lock:
                for name in detected:
                    if name not in self._cached_graphs and name not in self._removed_graphs:
                        self._graphs_to_cache.append(name)
        return await self._cache_pending_graphs()

    async def cache_detected_graphs(self) -> List[str]:
        if not self.auto_cache:
            return []
        return await self._cache_pending_graphs()
    
`;

function replaceStrict(source, original, replacement, marker) {
  const oldCount = source.split(original).length - 1;
  const newCount = source.split(replacement).length - 1;
  if (!oldCount && newCount === 1 && source.split(marker).length === 2) return source;
  if (oldCount !== 1 || newCount || source.includes(marker)) throw new Error("unsupported graph drain source: " + marker);
  return source.replace(original, replacement);
}
function patchClient(source) {
  const poll = replaceStrict(source, ORIGINAL_POLL, POLL, "# Workbench request owns graph polling until task-group exit.");
  return replaceStrict(poll, ORIGINAL_EXIT, EXIT, 'ExceptionGroup("Streaming maintenance failed", failures)');
}
function patchDetector(source) {
  if (source.includes(PREVIOUS_DETECTOR)) {
    return replaceStrict(source, PREVIOUS_DETECTOR, DETECTOR,
      "# Workbench graph failures propagate; unfinished cache entries remain pending.");
  }
  return replaceStrict(source, ORIGINAL_DETECTOR, DETECTOR, "# Workbench graph threads drain under both AnyIO and asyncio cancellation.");
}
module.exports = { patchClient, patchDetector, ORIGINAL_POLL, POLL, ORIGINAL_EXIT, EXIT, ORIGINAL_DETECTOR, PREVIOUS_DETECTOR, DETECTOR };
