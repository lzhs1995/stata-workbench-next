"use strict";
const crypto = require("node:crypto");

const INIT_ORIGINAL = `    def init(self):
        """Initializes usage of pystata using cached discovery results."""
        if self._initialized:
            return

`;
const INIT = String.raw`    def init(self):
        """Serialize initialization and retain any partial-startup failure.

        A failed startup may already have changed the engine. Subsequent requests
        must not skip that failure or replay startup against the partial state.
        """
        with self._exec_lock:
            failure = getattr(self, '_initialization_error', None)
            if failure is not None:
                raise RuntimeError('Stata initialization previously failed; automatic retry is disabled') from failure
            if self._initialized:
                return
            try:
                self._initialize_stata_once()
            except BaseException as error:
                self._initialization_error = error
                self._initialized = False
                raise

    def _initialize_stata_once(self):
        """Initialize the engine once under the public init() failure latch."""

`;
const LOAD = String.raw`    def _load_startup_do_file(self) -> None:
        """Run explicitly configured startup files in order, exposing failures.

        Startup files intentionally change the session. This is not rollback of
        their data/program effects; only the internal probes preserve results.
        """
        with self._exec_lock:
            if self._initialized is not True:
                raise RuntimeError('Startup backend is not initialized')
            loaded = set()

            def load(path):
                # Stata expands macros even inside quoted paths.
                if (not isinstance(path, str) or not path
                        or any(char in path for char in ('\x00', '\n', '\r', '"', '$', chr(96)))):
                    raise ValueError('Unsupported startup path: ' + repr(path))
                normalized = self._normalize_startup_path(path)
                if normalized in loaded:
                    return
                if not os.path.isfile(path):
                    raise FileNotFoundError('Startup file is missing: ' + path)
                logger.info('Loading startup do file from %s', path)
                # No capture: PyStata must propagate a native do-file failure.
                self.stata.run('noisily do ' + self._stata_quote(path), echo=False)
                loaded.add(normalized)

            raw = os.getenv('MCP_STATA_STARTUP_DO_FILE')
            if raw:
                paths, _ = self._parse_startup_do_files(raw)
                for path in paths:
                    load(path)
            # Configured startup may change adopath, so resolve profiles afterwards.
            self._prime_profile_do_cache()
            for path in (self._sysprofile_do_path, self._profile_do_path):
                if path:
                    load(path)
            if self._reload_startup_on_clear:
                self._install_startup_sentinel()

`;
const PROBES = String.raw`    def _probe_global_macro(self, name: str) -> Optional[str]:
        if not name:
            return None
        with self._exec_lock:
            from sfi import Macro
            value = Macro.getGlobal(name)
            if not isinstance(value, str):
                raise RuntimeError('Cannot read startup global macro: ' + name)
            value = self._normalize_macro_value(value)
            if value is None:
                self._global_macro_cache.pop(name, None)
            else:
                self._global_macro_cache[name] = value
            return value

    def _probe_local_macro(self, name: str) -> Optional[str]:
        if not name:
            return None
        with self._exec_lock:
            from sfi import Macro
            value = Macro.getLocal(name)
            if not isinstance(value, str):
                raise RuntimeError('Cannot read startup local macro: ' + name)
            return self._normalize_macro_value(value)

`;
const SENTINEL = String.raw`    def _install_startup_sentinel(self) -> None:
        """Install a session-owned program without dropping caller programs."""
        import uuid
        with self._exec_lock:
            name = getattr(self, '_startup_sentinel_name', None)
            if name is not None and self._startup_sentinel_alive():
                return
            name = '_wb_start_' + uuid.uuid4().hex[:22]

            def query(Macro, run):
                try:
                    run('program list ' + name)
                except RuntimeError as error:
                    if getattr(error, 'stata_rc', None) != 111:
                        raise
                else:
                    raise RuntimeError('Startup sentinel name already exists')
                # The guard's run() captures one statement. A program body is a
                # multiline input unit; send it directly so PyStata reports its
                # failure instead of capturing only the program header.
                self.stata.run('program define ' + name + '\n    version 16\nend', echo=False)
                # Track a successful definition even if guard restoration fails.
                self._startup_sentinel_name = name
                run('program list ' + name)

            self._startup_state_guard(query)

    def _startup_sentinel_alive(self) -> bool:
        """Only native r(111) means absent; probe/restoration failures propagate."""
        import re
        with self._exec_lock:
            name = getattr(self, '_startup_sentinel_name', None)
            if name is None:
                return False
            if not isinstance(name, str) or re.fullmatch(r'_wb_start_[a-f0-9]{22}', name) is None:
                raise RuntimeError('Invalid startup sentinel identity')

            def query(Macro, run):
                try:
                    run('program list ' + name)
                except RuntimeError as error:
                    if getattr(error, 'stata_rc', None) == 111:
                        return False
                    raise
                return True

            return self._startup_state_guard(query)

    def _reload_startup_do_files(self) -> None:
        """Replay configured startup while preserving the user's return code.

        Deliberate startup data/program/result changes are retained. Do not wrap
        the do files in a results guard which would hide their intended effects.
        """
        with self._exec_lock:
            if self._initialized is not True:
                raise RuntimeError('Startup backend is not initialized')
            from sfi import Scalar

            def read_rc():
                value = Scalar.getValue('c(rc)')
                if (type(value) not in (int, float) or not 0 <= value <= 2147483647
                        or (type(value) is float and not value.is_integer())):
                    raise RuntimeError('Cannot read startup return code')
                return int(value)

            entry_rc = read_rc()
            errors = []
            try:
                self._load_startup_do_file()
            except BaseException as error:
                errors.append(error)
            finally:
                try:
                    self.stata.run('nobreak {\ncapture error ' + str(entry_rc) + '\n}', echo=False)
                    if read_rc() != entry_rc:
                        raise RuntimeError('Startup entry return code was not restored')
                except BaseException as error:
                    errors.append(error)
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Startup and return-code restoration failed', errors)

    def _startup_state_guard(self, query):
        detector = self._graph_detector
        if detector is None or detector._stata_client is not self:
            raise RuntimeError('Startup state guard is unavailable')
        return detector._with_graph_probe_state(query)

`;
const MAYBE = String.raw`    def _maybe_reload_startup_after_command(self, code: str) -> None:
        if not self._reload_startup_on_clear:
            return
        with self._exec_lock:
            if self._code_drops_programs(code):
                self._reload_startup_do_files()
                return
            # Macro contents can change inside do files. Cached/inline expansion
            # cannot establish whether programs actually survived the command.
            if (self._should_probe_startup_sentinel_after_command(code)
                    and not self._startup_sentinel_alive()):
                self._reload_startup_do_files()

`;
const PROFILES = String.raw`    def _prime_profile_do_cache(self) -> None:
        """Publish profile resolution only after the complete search succeeds."""
        import stat
        with self._exec_lock:
            if self._profile_do_checked:
                return
            dirs = self._collect_profile_do_dirs()
            def is_file(path):
                try:
                    return stat.S_ISREG(os.stat(path).st_mode)
                except FileNotFoundError:
                    return False

            found = []
            for filename in ('sysprofile.do', 'profile.do'):
                found.append(next((os.path.join(directory, filename) for directory in dirs
                                   if is_file(os.path.join(directory, filename))), None))
            self._profile_do_dirs = list(dirs)
            self._sysprofile_do_path, self._profile_do_path = found
            self._profile_do_checked = True

    def _collect_profile_do_dirs(self) -> List[str]:
        """Read c() strings directly; never overwrite mcp_* globals."""
        with self._exec_lock:
            if self._initialized is not True:
                raise RuntimeError('Startup backend is not initialized')
            from sfi import Macro
            values = {}
            for key in ('sysdir_stata', 'pwd', 'sysdir_personal', 'sysdir_site',
                        'sysdir_plus', 'sysdir_oldplace', 'adopath'):
                value = Macro.getGlobal('c(' + key + ')')
                if not isinstance(value, str) or '\x00' in value:
                    raise RuntimeError('Cannot read startup directory: ' + key)
                values[key] = value
            dirs = []
            for value in [values[key] for key in ('sysdir_stata', 'pwd', 'sysdir_personal',
                                                  'sysdir_site', 'sysdir_plus', 'sysdir_oldplace')] + values['adopath'].split(';'):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] == '"':
                    value = value[1:-1]
                if value and value not in dirs:
                    dirs.append(value)
            return dirs

`;
const BLOCKS = [
  { name: "init", start: "    def init(self):\n", end: "        # Suppress any non-UTF8 banner output",
    sha256: crypto.createHash("sha256").update(INIT_ORIGINAL).digest("hex"), replacement: INIT },
  { name: "load", start: "    def _load_startup_do_file(", end: "    # Patterns that drop user programs",
    sha256: "079c6187a721cb93c1a67a3e8bdcdaa3cea3c3f1c7fd20b51387e47a2bc323f8", replacement: LOAD },
  { name: "probes", start: "    def _probe_global_macro(", end: "    def _resolve_indirect_macro_command(",
    sha256: "2e9096fec31b4cca84e0d6f96c2d868c843a6b1a3c4f8f90b65458e166087452", replacement: PROBES },
  { name: "sentinel", start: "    def _install_startup_sentinel(", end: "    def _maybe_reload_startup_after_do_file(",
    sha256: "6678776a3f81f3ea9487367982462c950dca9db842296dc9bdc0ec115e3bcc61", replacement: SENTINEL },
  { name: "maybe", start: "    def _maybe_reload_startup_after_command(", end: "    def _parse_startup_do_files(",
    sha256: "d6c5480cc5c2924c555e0fee6e7be4eeba7be2b39850da003782de03b24764d4", replacement: MAYBE },
  { name: "profiles", start: "    def _prime_profile_do_cache(", end: "    def _make_valid_stata_name(",
    sha256: "07432a17d2496605d9da66c666614252f28ae6f24c6bdafb3ae5ae9556ad7cdd", replacement: PROFILES },
];
function patchClient(source) {
  for (const block of BLOCKS) {
    if (source.split(block.start).length !== 2 || source.split(block.end).length !== 2)
      throw new Error("missing or ambiguous startup boundary: " + block.name);
    const start = source.indexOf(block.start), end = source.indexOf(block.end, start);
    if (end <= start) throw new Error("missing startup boundary: " + block.name);
    const body = source.slice(start, end);
    if (body === block.replacement) continue;
    if (crypto.createHash("sha256").update(body).digest("hex") !== block.sha256)
      throw new Error("unsupported startup source: " + block.name);
    source = source.slice(0, start) + block.replacement + source.slice(end);
  }
  return source;
}
module.exports = { BLOCKS, INIT_ORIGINAL, patchClient };
