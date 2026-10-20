"use strict";

const errors = require("./stata_detector_error_patch");
const drain = require("./stata_graph_task_drain_patch");
const crypto = require("node:crypto");

const DETECT = String.raw`    def _detect_graphs_via_pystata(self) -> List[str]:
        """Observe graphs while retaining unsuccessful cache work across requests."""
        # Keep the same lock order as cache commit: execution, then detector.
        with self._graph_probe_lock():
            enabled = self._inventory_cache_enabled
            self._inventory_cache_enabled = False
            try:
                current = self._get_graph_state_from_pystata()
            finally:
                self._inventory_cache_enabled = enabled
            with self._lock:
                return self._record_cache_observation(current)

    def _record_cache_observation(self, current):
        # Caller holds _lock. Observation is separate from cache completion.
        pending = getattr(self, '_pending_cache_states', {})
        for name in list(pending):
            if name not in current or name in self._removed_graphs:
                del pending[name]
        for name, state in current.items():
            previous = self._last_graph_state.get(name)
            if previous is None or previous.get('signature') != state.get('signature'):
                self._removed_graphs.discard(name)
            if name not in self._removed_graphs and (
                    previous is None or previous.get('signature') != state.get('signature')):
                pending[name] = object()
        self._last_graph_state = {name: dict(state) for name, state in current.items()}
        self._pending_cache_states = pending
        return list(pending)

    def _pending_cache_names(self):
        with self._lock:
            return [name for name in getattr(self, '_pending_cache_states', {})
                    if name not in self._removed_graphs]

    def _cache_observed_graph(self, name):
        # Commit in the owned worker, even when its async waiter is cancelled.
        # The execution lock prevents a second worker exporting the same entry.
        with self._graph_probe_lock():
            client = self._stata_client
            if client._initialized is not True or client._is_executing:
                raise RuntimeError('Graph cache is unavailable during execution or initialization')
            with self._lock:
                token = getattr(self, '_pending_cache_states', {}).get(name)
                if token is None or name in self._removed_graphs:
                    return False
            success = client.cache_graph_on_creation(name)
            if success is not True:
                raise RuntimeError('Graph cache did not succeed: ' + name)
            with self._lock:
                if self._pending_cache_states.get(name) is token:
                    del self._pending_cache_states[name]
            return True

`;

const MODIFICATIONS = String.raw`    def detect_graph_modifications(self, text: str = None) -> dict:
        """Observe removals without consuming graphs that still need caching."""
        with self._graph_probe_lock():
            enabled = self._inventory_cache_enabled
            self._inventory_cache_enabled = False
            try:
                current = self._get_graph_state_from_pystata()
            finally:
                self._inventory_cache_enabled = enabled
            with self._lock:
                previous = set(self._last_graph_state)
                modifications = {'dropped': sorted(previous - set(current)),
                                 'renamed': [], 'cleared': bool(previous and not current)}
                self._record_cache_observation(current)
                return modifications

`;

// Native timestamps take precedence even within one command/request.
const STATE = errors.BLOCKS[4].replacement.replace(
  "if prev and prev.get('cmd_idx') == cmd_idx:\n                        sig = prev.get('signature')\n                    elif timestamp:\n                        sig = f'{graph_name}_{timestamp}'",
  "if timestamp:\n                        sig = f'{graph_name}_{timestamp}'\n                    elif prev and prev.get('cmd_idx') == cmd_idx:\n                        sig = prev.get('signature')"
);

const LIFECYCLE = String.raw`    def mark_graph_removed(self, graph_name: str) -> None:
        with self._graph_probe_lock(), self._lock:
            self._mark_graph_removed_unlocked(graph_name)

    def _mark_graph_removed_unlocked(self, graph_name):
        self._removed_graphs.add(graph_name)
        self._detected_graphs.discard(graph_name)
        self._last_graph_state.pop(graph_name, None)
        getattr(self, '_pending_cache_states', {}).pop(graph_name, None)

    def mark_all_cleared(self) -> None:
        with self._graph_probe_lock(), self._lock:
            self._detected_graphs.clear()
            self._removed_graphs.clear()
            self._last_graph_state.clear()
            getattr(self, '_pending_cache_states', {}).clear()

    def clear_detection_state(self) -> None:
        # Request boundaries reset transient tracking, never unfinished exports.
        with self._lock:
            self._detected_graphs.clear()
            self._removed_graphs.clear()
            self._unnamed_graph_counter = 0

    def process_modifications(self, modifications: dict) -> None:
        # Do not recursively acquire the non-reentrant detector lock.
        with self._graph_probe_lock(), self._lock:
            for name in modifications.get('dropped', []):
                self._mark_graph_removed_unlocked(name)
            for old_name, new_name in modifications.get('renamed', []):
                self._mark_graph_removed_unlocked(old_name)
                self._detected_graphs.discard(new_name)
            if modifications.get('cleared', False):
                self._detected_graphs.clear()
                self._removed_graphs.clear()
                self._last_graph_state.clear()
                getattr(self, '_pending_cache_states', {}).clear()


`;

const NOTIFICATION = String.raw`    @staticmethod
    def _create_graph_cache_callback(on_graph_cached, notify_log, task_id=None):
        """Attempt both notification channels and preserve their failures."""
        async def graph_cache_callback(graph_name: str, success: bool) -> None:
            errors = []
            try:
                if on_graph_cached:
                    await on_graph_cached(graph_name, success)
            except Exception as error:
                error.add_note('on_graph_cached: ' + graph_name)
                errors.append(error)
            try:
                await notify_log(json.dumps({
                    'event': 'graph_cached', 'graph': graph_name,
                    'success': success, 'task_id': task_id,
                }))
            except Exception as error:
                error.add_note('graph cache notify_log: ' + graph_name)
                errors.append(error)
            if errors:
                raise ExceptionGroup('Graph cache notification failed: ' + graph_name, errors)
        return graph_cache_callback

`;

const OWNED_CALL = drain.DETECTOR.slice(0, drain.DETECTOR.indexOf("    async def _cache_pending_graphs("));
const CACHE = OWNED_CALL + String.raw`    async def _cache_pending_graphs(self) -> List[str]:
        # The detector owns pending work; this request owns callbacks and workers.
        detector_pending = self.detector._pending_cache_names()
        with self._lock:
            pending = list(dict.fromkeys(self._graphs_to_cache + detector_pending))
            self._graphs_to_cache.clear()
        if not pending:
            return []
        cached_names = []
        try:
            current = await self._run_owned_graph_call(
                lambda: self.stata_client.list_graphs(force_refresh=True))
            for name in pending:
                if name not in current or name in self._removed_graphs:
                    continue
                try:
                    committed = await self._run_owned_graph_call(self.detector._cache_observed_graph, name)
                except Exception as error:
                    try:
                        await self._notify_cache_callbacks(name, False)
                    except Exception as callback_error:
                        raise ExceptionGroup('Graph cache and failure callbacks failed',
                                             [error, callback_error]) from None
                    raise
                if not committed:
                    continue
                with self._lock:
                    self._cached_graphs.add(name)
                cached_names.append(name)
                await self._notify_cache_callbacks(name, True)
            return cached_names
        except BaseException:
            # A completed export remains committed if notification/cancellation fails.
            remaining = self.detector._pending_cache_names()
            with self._lock:
                self._graphs_to_cache = list(dict.fromkeys(remaining + self._graphs_to_cache))
            raise

    async def cache_detected_graphs_with_pystata(self) -> List[str]:
        if not self.auto_cache:
            return []
        detected = await self._run_owned_graph_call(self.detector._detect_graphs_via_pystata)
        with self._lock:
            self._graphs_to_cache = list(dict.fromkeys(self._graphs_to_cache + detected))
        return await self._cache_pending_graphs()

    async def cache_detected_graphs(self) -> List[str]:
        if not self.auto_cache:
            return []
        return await self._cache_pending_graphs()

`;

const BLOCKS = [
  { name: "detect", start: errors.BLOCKS[2].start, end: errors.BLOCKS[2].end,
    previous: errors.BLOCKS[2].replacement, rawSHA: errors.BLOCKS[2].sha256, replacement: DETECT },
  { name: "modifications", start: errors.BLOCKS[5].start, end: errors.BLOCKS[5].end,
    previous: errors.BLOCKS[5].replacement, rawSHA: errors.BLOCKS[5].sha256, replacement: MODIFICATIONS },
  { name: "state", start: errors.BLOCKS[4].start, end: errors.BLOCKS[4].end,
    previous: errors.BLOCKS[4].replacement, rawSHA: errors.BLOCKS[4].sha256, replacement: STATE },
  { name: "cache", start: "    async def _run_owned_graph_call(", end: "    def get_cache_stats(",
    previous: drain.DETECTOR, replacement: CACHE },
];

function transform(source, normalize) {
  let result = source;
  for (const block of BLOCKS) {
    const count = result.split(block.start).length - 1;
    if (normalize && block.name === "cache" && !count
        && result.split(drain.ORIGINAL_DETECTOR).length === 2) continue;
    if (count !== 1 || result.split(block.end).length !== 2) throw new Error("missing or ambiguous cache transaction boundary: " + block.name);
    const start = result.indexOf(block.start), end = result.indexOf(block.end, start);
    if (end <= start) throw new Error("missing cache transaction end: " + block.name);
    const body = result.slice(start, end);
    if (normalize && (block.rawSHA === crypto.createHash("sha256").update(body).digest("hex")
        || block.name === "cache" && body === drain.PREVIOUS_DETECTOR)) continue;
    if (body !== block.previous && body !== block.replacement) {
      throw new Error("unsupported cache transaction source: " + block.name);
    }
    result = result.slice(0, start) + (normalize ? block.previous : block.replacement) + result.slice(end);
  }
  return result;
}

const NOTIFICATION_BLOCK = {name: 'notification', start: '    @staticmethod\n    def _create_graph_cache_callback(',
  end: '    def _get_cached_graph_path(', sha256: 'f788939c7c685d0fd6f51d5c7f21fdf806a7ae3b8c4bea7eff19724d69478983',
  replacement: NOTIFICATION};
const LIFECYCLE_BLOCK = {name: 'lifecycle', start: '    def mark_graph_removed(',
  end: 'class StreamingGraphCache:', sha256: 'df1bcacd959538be8e49c51af629a816175f5aa66014cfbcc2c42708cf8a14bf',
  replacement: LIFECYCLE};

function strictBlock(source, block, normalize = false) {
  const starts = [block.start, block.candidateStart].filter(Boolean);
  const count = starts.reduce((n, s) => n + source.split(s).length - 1, 0);
  if (count !== 1 || source.split(block.end).length !== 2) {
    throw new Error('missing or ambiguous cache transaction boundary: ' + block.name);
  }
  const start = Math.max(...starts.map(s => source.indexOf(s))), end = source.indexOf(block.end, start);
  if (end <= start) throw new Error('invalid cache transaction boundary: ' + block.name);
  const body = source.slice(start, end);
  if (body !== block.replacement && crypto.createHash('sha256').update(body).digest('hex') !== block.sha256) {
    throw new Error('unsupported cache transaction source: ' + block.name);
  }
  // Lifecycle is independent of the upstream transforms; normalization validates it.
  return normalize ? source : source.slice(0, start) + block.replacement + source.slice(end);
}

module.exports = { BLOCKS, NOTIFICATION_BLOCK, LIFECYCLE_BLOCK,
  patchClient: s => strictBlock(s, NOTIFICATION_BLOCK),
  patchDetector: s => strictBlock(transform(s, false), LIFECYCLE_BLOCK),
  normalizeDetector: s => strictBlock(transform(s, true), LIFECYCLE_BLOCK, true) };
