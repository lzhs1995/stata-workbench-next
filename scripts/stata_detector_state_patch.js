"use strict";

const errorPatch = require("./stata_detector_error_patch");
const INVENTORY = String.raw`    def _get_graph_inventory(self, *, need_timestamps: bool = True) -> tuple[List[str], Dict[str, str]]:
        """Read graph metadata without using caller globals as scratch space."""
        def query(Macro, run):
            run('graph dir, memory')
            raw = Macro.getGlobal('r(list)')
            if not isinstance(raw, str):
                raise RuntimeError('Cannot read graph inventory')
            names = shlex.split(raw)
            # Validate every native name before describing any graph.
            for name in names:
                self._graph_probe_name(name)
            reverse = getattr(self._stata_client, '_graph_name_reverse', {})
            user_names = [reverse.get(name, name) for name in names]
            if (any(not isinstance(name, str) or not name for name in user_names)
                    or len(set(user_names)) != len(user_names)):
                raise RuntimeError('Ambiguous graph inventory aliases')
            timestamps = {}
            if need_timestamps:
                for native, user in zip(names, user_names):
                    run('graph describe ' + native)
                    timestamps[user] = self._graph_probe_timestamp(Macro)
            return (user_names, timestamps)

        # Publish only after query AND restoration succeed, including empty lists.
        with self._graph_probe_lock():
            if getattr(self._stata_client, '_initialized', False) is not True:
                raise RuntimeError('Graph detector backend is not initialized')
            if self._inventory_cache_enabled:
                cached = self._inventory_cache
                if cached['graphs'] and time.monotonic() - cached['timestamp'] < self._inventory_cache_ttl:
                    if not need_timestamps or len(cached['timestamps']) == len(cached['graphs']):
                        return (list(cached['graphs']), dict(cached['timestamps']) if need_timestamps else {})
            names, timestamps = self._with_graph_probe_state(query)
            self._inventory_cache = {'timestamp': time.monotonic(), 'graphs': list(names), 'timestamps': dict(timestamps)}
            return (names, timestamps)

    def _graph_probe_lock(self):
        client = self._stata_client
        if client is None or getattr(client, 'stata', None) is None:
            raise RuntimeError('Graph detector backend is unavailable')
        lock = getattr(client, '_exec_lock', None)
        if lock is None:
            raise RuntimeError('Graph detector execution lock is unavailable')
        return lock

    @staticmethod
    def _graph_probe_name(name):
        # graph describe "name" selects a disk file. Accept in-memory simple names
        # only; client aliases are resolved before this boundary. Fail closed for
        # unsupported names rather than interpolating macros, paths or commands.
        if not isinstance(name, str) or re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,31}', name) is None:
            raise ValueError('Unsupported in-memory graph name: ' + repr(name))
        return name

    @staticmethod
    def _graph_probe_timestamp(Macro):
        date, clock = Macro.getGlobal('r(command_date)'), Macro.getGlobal('r(command_time)')
        if not isinstance(date, str) or not isinstance(clock, str):
            raise RuntimeError('Cannot read graph timestamp')
        # Stata documents that these macros may be undefined. Empty timestamps
        # select the existing command-index signature; they are not read errors.
        return date + '_' + clock if date or clock else ''

    def _with_graph_probe_state(self, query):
        # Workbench graph probes preserve entry r() and c(rc) under the client lock.
        # This is a scoped guard, not a full e/s/frame/Mata/preserve checkpoint.
        with self._graph_probe_lock():
            client = self._stata_client
            if getattr(client, '_initialized', False) is not True:
                raise RuntimeError('Graph detector backend is not initialized')
            from sfi import Macro, Scalar
            token = uuid.uuid4().hex[:24]
            holder, scalar = '_wb_dh_' + token, '_wb_dr_' + token
            entry_rc = None
            held_attempted = scalar_attempted = False
            failure, cleanup_errors, result = None, [], None

            def read_rc(name):
                value = Scalar.getValue(name)
                if (type(value) not in (int, float) or not 0 <= value <= 2147483647
                        or (type(value) is float and not value.is_integer())):
                    raise RuntimeError('Cannot read graph probe return code: ' + name)
                return int(value)

            def internal(statement):
                # Do not call the client helper that can initialize before entry
                # capture. The already initialized client is pinned by this lock.
                client.stata.run('nobreak {\n' + statement + '\n}', echo=False)

            def run(statement):
                # Capture the native RC before the next Stata command resets it.
                # The scalar survives the PyStata call boundary; locals may not.
                internal('scalar ' + scalar + ' = .')
                client.stata.run('capture quietly ' + statement + '\nscalar ' + scalar + ' = _rc\n', echo=False)
                rc = read_rc(scalar)
                if rc:
                    error = RuntimeError('Graph probe failed with r(' + str(rc) + '): ' + statement)
                    error.stata_rc = rc
                    raise error

            def cleanup(statement, check_rc=None):
                try:
                    internal(statement)
                    if check_rc is not None and read_rc('c(rc)') != check_rc:
                        raise RuntimeError('Graph probe entry return code was not restored')
                except BaseException as error:
                    cleanup_errors.append(error)

            try:
                entry_rc = read_rc('c(rc)')
                # No Stata commands or implicit init before the entry read succeeds.
                held_attempted = True
                internal('_return hold ' + holder)
                scalar_attempted = True
                internal('scalar ' + scalar + ' = .')
                result = query(Macro, run)
            except BaseException as error:
                failure = error
            finally:
                if scalar_attempted:
                    cleanup('scalar drop ' + scalar)
                if held_attempted:
                    # An exception at the PyStata boundary may follow a completed
                    # hold. Attempt restoration and retain both failures if needed.
                    cleanup('_return restore ' + holder)
                if entry_rc is not None:
                    cleanup('capture error ' + str(entry_rc), check_rc=entry_rc)

            errors = ([failure] if failure is not None else []) + cleanup_errors
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Graph probe and state restoration failed', errors)
            return result

`;
const TIMESTAMPS = String.raw`    def _get_graph_timestamps(self, graph_names: List[str]) -> Dict[str, str]:
        """Describe a complete graph list within one saved caller state."""
        if not graph_names:
            return {}
        with self._graph_probe_lock():
            native_names = [self._graph_probe_name(self._stata_client._resolve_graph_name_for_stata(name))
                            for name in graph_names]
            if len(set(graph_names)) != len(graph_names):
                raise ValueError('Duplicate graph timestamp request')

            def query(Macro, run):
                results = {}
                for user, native in zip(graph_names, native_names):
                    run('graph describe ' + native)
                    results[user] = self._graph_probe_timestamp(Macro)
                return results

            return self._with_graph_probe_state(query)

`;
const BLOCKS = errorPatch.BLOCKS.slice(0, 2).map((block, index) => ({
  ...block, previous: block.replacement, replacement: index === 0 ? INVENTORY : TIMESTAMPS,
}));

function transform(source, normalize) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    if (result.split(block.start).length !== 2 || result.split(block.end).length !== 2) {
      throw new Error("missing or ambiguous detector state boundary: " + block.name);
    }
    const start = result.indexOf(block.start), end = result.indexOf(block.end);
    if (end <= start) throw new Error("invalid detector state boundary: " + block.name);
    const body = result.slice(start, end);
    if (body === block.replacement) {
      states.push("candidate");
      if (normalize) result = result.slice(0, start) + block.previous + result.slice(end);
    } else if (normalize) {
      states.push("upstream"); // The upstream SHA-bound error patch validates it.
    } else {
      if (body !== block.previous) throw new Error("unsupported detector state source: " + block.name);
      states.push("previous");
      result = result.slice(0, start) + block.replacement + result.slice(end);
    }
  }
  if (new Set(states).size !== 1) throw new Error("mixed detector state source");
  return result;
}

module.exports = { BLOCKS, patchDetector: source => transform(source, false),
  normalizeDetector: source => transform(source, true) };
