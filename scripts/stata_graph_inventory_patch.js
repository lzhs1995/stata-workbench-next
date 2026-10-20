"use strict";

const crypto = require("node:crypto");
const LIST = String.raw`    def list_graphs(self, *, force_refresh: bool = False) -> List[str]:
        """Return a detached, successful graph inventory snapshot."""
        return [graph.name for graph in self._list_graphs_snapshot(force_refresh=force_refresh)]

    def _list_graphs_snapshot(self, *, force_refresh: bool = False):
        # Cache lookup and native query share the execution lock. A concurrent
        # command must finish before its graph metadata can be observed.
        import shlex
        import time
        with self._exec_lock:
            if self._initialized is not True:
                raise RuntimeError('Graph inventory backend is not initialized')
            if self._is_executing:
                raise RuntimeError('Graph inventory is unavailable during execution')
            with self._list_graphs_cache_lock:
                if (not force_refresh and self._list_graphs_cache is not None
                        and 0 <= time.monotonic() - self._list_graphs_cache_time < self.LIST_GRAPHS_TTL):
                    return [graph.model_copy() for graph in self._list_graphs_cache]

            detector = self._graph_detector
            if detector is None or detector._stata_client is not self:
                raise RuntimeError('Graph inventory detector is unavailable')

            def query(Macro, run):
                # Workbench internal graph inventory probes must be quiet.
                run('graph dir, memory')
                raw = Macro.getGlobal('r(list)')
                if not isinstance(raw, str):
                    raise RuntimeError('Cannot read graph inventory')
                native_names = shlex.split(raw)
                for name in native_names:
                    detector._graph_probe_name(name)
                reverse = getattr(self, '_graph_name_reverse', {})
                names = [reverse.get(name, name) for name in native_names]
                if (any(not isinstance(name, str) or not name for name in names)
                        or len(set(names)) != len(names)):
                    raise RuntimeError('Ambiguous graph inventory aliases')
                graphs = []
                for native, name in zip(native_names, names):
                    run('graph describe ' + native)
                    date = Macro.getGlobal('r(command_date)')
                    clock = Macro.getGlobal('r(command_time)')
                    if not isinstance(date, str) or not isinstance(clock, str):
                        raise RuntimeError('Cannot read graph timestamp')
                    graphs.append(GraphInfo(name=name, active=False, created=(date + ' ' + clock).strip()))
                return graphs

            # Bypass the detector TTL: force_refresh must reach native inventory.
            # Publish only when both query and caller-state restoration succeed.
            graphs = detector._with_graph_probe_state(query)
            with self._list_graphs_cache_lock:
                self._list_graphs_cache = graphs
                self._list_graphs_cache_time = time.monotonic()
                return [graph.model_copy() for graph in graphs]

    def list_graphs_structured(self) -> GraphListResponse:
        graphs = self._list_graphs_snapshot()
        if graphs:
            graphs[-1].active = True
        return GraphListResponse(graphs=graphs)

    def invalidate_list_graphs_cache(self) -> None:
        """Invalidate atomically with respect to query and cache publication."""
        with self._exec_lock:
            with self._list_graphs_cache_lock:
                self._list_graphs_cache = None
                self._list_graphs_cache_time = 0

`;
const CAPTURE = String.raw`    def _capture_graph_state(
        self,
        graph_cache: Optional[StreamingGraphCache],
        emit_graph_ready: bool,
    ) -> Optional[dict[str, str]]:
        # A failed pre-run inventory is not an empty starting graph set.
        with self._exec_lock:
            graphs = self._list_graphs_snapshot(force_refresh=True) if graph_cache or emit_graph_ready else []
            signatures = {g.name: self._graph_info_signature(g, self._command_idx) for g in graphs}
            if graph_cache:
                graph_cache.detector.clear_detection_state()
                graph_cache._initial_graphs = {g.name for g in graphs}
            self._graph_signature_cache = signatures
            self._graph_signature_cache_cmd_idx = self._command_idx
            return dict(signatures) if emit_graph_ready else None

`;
const SIGNATURE = String.raw`    def _get_graph_signature(self, graph_name: str) -> str:
        """Return metadata from a successful query; never invent a missing graph."""
        with self._exec_lock:
            if self._initialized is not True or self._is_executing:
                raise RuntimeError('Graph signature is unavailable during execution or initialization')
            if self._graph_signature_cache_cmd_idx == self._command_idx:
                cached = self._graph_signature_cache.get(graph_name)
                if cached is not None:
                    return cached
            graphs = self._list_graphs_snapshot(force_refresh=True)
            signatures = {g.name: self._graph_info_signature(g, self._command_idx) for g in graphs}
            if graph_name not in signatures:
                raise RuntimeError('Graph not found in inventory: ' + repr(graph_name))
            self._graph_signature_cache = signatures
            self._graph_signature_cache_cmd_idx = self._command_idx
            return signatures[graph_name]

    def _graph_info_signature(self, graph, command_idx):
        # Stata can omit creation time. Command index avoids treating a newly
        # created same-name graph as unchanged across commands in that case.
        return graph.name + '_' + (graph.created or ('command_' + str(command_idx)))

`;
const BLOCKS = [
  { name: "list_graphs", start: "    def list_graphs(", end: "    def export_graph(", sha256: "5d1884f314952087c0916e65bd8f83abfb2fc90aeac20c89120ca086721667f1", replacement: LIST },
  { name: "_capture_graph_state", start: "    def _capture_graph_state(", end: "    async def _cache_new_graphs(", sha256: "50ddfaabf081cadc4071139e1bd263c012fa3b72f5e6a87d8df0d3efb997af96", replacement: CAPTURE },
  { name: "_get_graph_signature", start: "    def _get_graph_signature(", end: "    @staticmethod\n    def _", sha256: "c1597335c7e59e728ee5695045dabf049ea629441464f8a3f3314cf1c69f5cb9", replacement: SIGNATURE },
];

function patchClient(source) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    if (result.split(block.start).length !== 2) throw new Error("missing or ambiguous graph inventory start: " + block.name);
    const start = result.indexOf(block.start), end = result.indexOf(block.end, start);
    if (end <= start) throw new Error("missing graph inventory end: " + block.name);
    const body = result.slice(start, end);
    if (body === block.replacement) { states.push("candidate"); continue; }
    if (crypto.createHash("sha256").update(body).digest("hex") !== block.sha256) {
      throw new Error("unsupported graph inventory source: " + block.name);
    }
    states.push("original");
    result = result.slice(0, start) + block.replacement + result.slice(end);
  }
  if (new Set(states).size !== 1) throw new Error("mixed graph inventory source");
  return result;
}
module.exports = { BLOCKS, patchClient };
