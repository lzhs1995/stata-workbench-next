"use strict";

const crypto = require("node:crypto");
const BLOCKS = [
  {
    "name": "_get_graph_inventory",
    "start": "    def _get_graph_inventory(",
    "end": "    def _get_graph_timestamp(",
    "sha256": "679e4a3113c524f490ef0fe09de291437815fb195d71e33642a2f10f97448510",
    "replacement": "    def _get_graph_inventory(self, *, need_timestamps: bool=True) -> tuple[List[str], Dict[str, str]]:\n        \"\"\"Get both the list of graphs and their timestamps in a single Stata call.\"\"\"\n        if not self._stata_client or not hasattr(self._stata_client, 'stata'):\n            raise RuntimeError('Graph detector backend is unavailable')\n        if self._inventory_cache_enabled:\n            now = time.monotonic()\n            cached = self._inventory_cache\n            if cached['graphs'] and now - cached['timestamp'] < self._inventory_cache_ttl:\n                if need_timestamps:\n                    if cached['timestamps']:\n                        return (list(cached['graphs']), dict(cached['timestamps']))\n                else:\n                    return (list(cached['graphs']), {})\n        try:\n            exec_lock = getattr(self._stata_client, '_exec_lock', None)\n            ctx = exec_lock if exec_lock else contextlib.nullcontext()\n            with ctx:\n                hold_name = f'_mcp_detector_inv_{int(time.time() * 1000 % 1000000)}'\n                from sfi import Macro\n                bundle = [f'capture _return hold {hold_name}', 'capture quietly graph dir, memory', \"local list `r(list)'\", 'macro define mcpinvlist \"`r(list)\\'\"', 'local i = 0']\n                if need_timestamps:\n                    bundle.extend(['foreach g of local list {', \"  capture quietly graph describe `g'\", '  macro define mcpinvts`i\\' \"`r(command_date)\\'_`r(command_time)\\'\"', \"  local i = `i' + 1\", '}'])\n                bundle.extend(['macro define mcpinvcount \"`i\\'\"', f'capture _return restore {hold_name}'])\n                self._stata_client.stata.run('\\n'.join(bundle), echo=False)\n                raw_list_str = Macro.getGlobal('mcpinvlist')\n                count_str = Macro.getGlobal('mcpinvcount')\n                if not raw_list_str:\n                    return ([], {})\n                try:\n                    graph_names = shlex.split(raw_list_str)\n                except Exception:\n                    raise\n                reverse = getattr(self._stata_client, '_graph_name_reverse', {})\n                user_names = [reverse.get(n, n) for n in graph_names]\n                count = int(float(count_str)) if count_str else 0\n                timestamps = {}\n                if need_timestamps:\n                    for i in range(count):\n                        ts = Macro.getGlobal(f'mcpinvts{i}')\n                        if ts and i < len(user_names):\n                            timestamps[user_names[i]] = ts\n                self._inventory_cache = {'timestamp': time.monotonic(), 'graphs': list(user_names), 'timestamps': dict(timestamps)}\n                return (user_names, timestamps)\n        except Exception as e:\n            raise\n\n"
  },
  {
    "name": "_get_graph_timestamps",
    "start": "    def _get_graph_timestamps(",
    "end": "    def _detect_graphs_via_pystata(",
    "sha256": "9dbe1e5929715deec3c96776e59e20f650c21e0e8f887ad45b5ce21987ebd8f3",
    "replacement": "    def _get_graph_timestamps(self, graph_names: List[str]) -> Dict[str, str]:\n        \"\"\"Get timestamps for multiple graphs in a single Stata call to minimize overhead.\"\"\"\n        if not graph_names:\n            return {}\n        if not self._stata_client or not hasattr(self._stata_client, 'stata'):\n            raise RuntimeError('Graph detector backend is unavailable')\n        try:\n            exec_lock = getattr(self._stata_client, '_exec_lock', None)\n            ctx = exec_lock if exec_lock else contextlib.nullcontext()\n            with ctx:\n                hold_name = f'_mcp_detector_thold_{int(time.time() * 1000 % 1000000)}'\n                self._stata_client.stata.run(f'capture _return hold {hold_name}', echo=False)\n                try:\n                    stata_cmd = ''\n                    for i, name in enumerate(graph_names):\n                        resolved = self._stata_client._resolve_graph_name_for_stata(name)\n                        stata_cmd += f'capture quietly graph describe {resolved}\\n'\n                        stata_cmd += f\"\"\"macro define mcp_ts_{i} \"`r(command_date)'_`r(command_time)'\"\\n\"\"\"\n                    self._stata_client.stata.run(stata_cmd, echo=False)\n                    from sfi import Macro\n                    results = {}\n                    for i, name in enumerate(graph_names):\n                        ts = Macro.getGlobal(f'mcp_ts_{i}')\n                        if ts:\n                            results[name] = ts\n                    return results\n                finally:\n                    self._stata_client.stata.run(f'capture _return restore {hold_name}', echo=False)\n        except Exception as e:\n            raise\n\n"
  },
  {
    "name": "_detect_graphs_via_pystata",
    "start": "    def _detect_graphs_via_pystata(",
    "end": "    def _get_current_graphs_from_pystata(",
    "sha256": "9fa6df59476f3235db3fcec8d48a69c308fc262672616899b42603c382648642",
    "replacement": "    def _detect_graphs_via_pystata(self) -> List[str]:\n        \"\"\"Detect newly created graphs using direct pystata state access.\"\"\"\n        if not self._stata_client:\n            raise RuntimeError('Graph detector backend is unavailable')\n        with self._lock:\n            try:\n                current_state = self._get_graph_state_from_pystata()\n                current_graphs = list(current_state.keys())\n                new_graphs = []\n                for graph_name in current_graphs:\n                    if graph_name not in self._last_graph_state and graph_name not in self._removed_graphs:\n                        new_graphs.append(graph_name)\n                for graph_name, state in current_state.items():\n                    if graph_name in self._last_graph_state:\n                        last_state = self._last_graph_state[graph_name]\n                        if state.get('signature') != last_state.get('signature'):\n                            if graph_name not in self._removed_graphs:\n                                new_graphs.append(graph_name)\n                self._last_graph_state = current_state.copy()\n                return new_graphs\n            except (ImportError, RuntimeError, ValueError, AttributeError) as e:\n                raise\n            except Exception as e:\n                raise\n\n"
  },
  {
    "name": "_get_current_graphs_from_pystata",
    "start": "    def _get_current_graphs_from_pystata(",
    "end": "    def _get_graph_state_from_pystata(",
    "sha256": "024fd1c40ed4f14127484211b4d1633b3c5e2cd2f9a807a44257b0b73c2dea60",
    "replacement": "    def _get_current_graphs_from_pystata(self) -> List[str]:\n        \"\"\"Read authoritative inventory; never fall back to stale or partial data.\"\"\"\n        graphs, _timestamps = self._get_graph_inventory(need_timestamps=False)\n        return graphs\n\n"
  },
  {
    "name": "_get_graph_state_from_pystata",
    "start": "    def _get_graph_state_from_pystata(",
    "end": "    def detect_graph_modifications(",
    "sha256": "42c014d5f9babd829ca8757f0d21ce10612eb8470115515ce1c7dab64c9c219b",
    "replacement": "    def _get_graph_state_from_pystata(self) -> Dict[str, Any]:\n        \"\"\"Get detailed graph state information using pystata's sfi interface.\"\"\"\n        graph_state = {}\n        try:\n            current_graphs, timestamps = self._get_graph_inventory()\n            cmd_idx = getattr(self._stata_client, '_command_idx', 0)\n            for graph_name in current_graphs:\n                try:\n                    fast_sig = self._describe_graph_signature(graph_name)\n                    prev = self._last_graph_state.get(graph_name)\n                    timestamp = timestamps.get(graph_name)\n                    if prev and prev.get('cmd_idx') == cmd_idx:\n                        sig = prev.get('signature')\n                    elif timestamp:\n                        sig = f'{graph_name}_{timestamp}'\n                    else:\n                        sig = fast_sig\n                    state_info = {'name': graph_name, 'exists': True, 'valid': bool(sig), 'signature': sig, 'cmd_idx': cmd_idx, 'timestamp_val': timestamp}\n                    if prev is None or prev.get('signature') != sig:\n                        state_info['timestamp'] = time.time()\n                    else:\n                        state_info['timestamp'] = prev.get('timestamp', time.time())\n                    graph_state[graph_name] = state_info\n                except Exception as e:\n                    raise\n        except Exception as e:\n            raise\n        return graph_state\n\n"
  },
  {
    "name": "detect_graph_modifications",
    "start": "    def detect_graph_modifications(",
    "end": "    def should_cache_graph(",
    "sha256": "05b2cf08e21637f51ec1ec3648fcdb8a0c8400f8fe32dab0d7438b4b2eff3851",
    "replacement": "    def detect_graph_modifications(self, text: str=None) -> dict:\n        \"\"\"Detect graph modification/removal using SFI state comparison.\"\"\"\n        modifications = {'dropped': [], 'renamed': [], 'cleared': False}\n        if not self._stata_client:\n            raise RuntimeError('Graph detector backend is unavailable')\n        try:\n            new_state = self._get_graph_state_from_pystata()\n            current_graphs = set(new_state.keys())\n            if self._last_graph_state:\n                last_graphs = set(self._last_graph_state.keys())\n                dropped_graphs = last_graphs - current_graphs\n                modifications['dropped'].extend(dropped_graphs)\n                if last_graphs and (not current_graphs):\n                    modifications['cleared'] = True\n            self._last_graph_state = new_state\n        except Exception as e:\n            raise\n        return modifications\n\n"
  }
];

function patchDetector(source) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    if (result.split(block.start).length !== 2 || result.split(block.end).length !== 2) {
      throw new Error("missing or ambiguous detector error boundary: " + block.name);
    }
    const start = result.indexOf(block.start), end = result.indexOf(block.end);
    if (end <= start) throw new Error("invalid detector error boundary order: " + block.name);
    const original = result.slice(start, end);
    if (original === block.replacement) { states.push("candidate"); continue; }
    if (crypto.createHash("sha256").update(original).digest("hex") !== block.sha256) {
      throw new Error("unsupported detector error source: " + block.name);
    }
    states.push("original");
    result = result.slice(0, start) + block.replacement + result.slice(end);
  }
  if (new Set(states).size !== 1) throw new Error("mixed detector error source");
  return result;
}
module.exports = { patchDetector, BLOCKS };
