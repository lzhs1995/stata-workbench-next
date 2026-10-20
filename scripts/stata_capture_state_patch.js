"use strict";

const crypto = require("node:crypto");
const START = "    def _exec_with_capture(";
const END = "        # Use SMCL as authoritative source";
const MARKER = "Workbench capture holds entry and result state across maintenance";
const ORIGINAL_SHA256 = "825052153b1df289d8b716af33789576fdd3fecc4fc8233239750c0063576b9b";
const REPLACEMENT = String.raw`    def _exec_with_capture(self, code: str, echo: bool = True, trace: bool = False, cwd: Optional[str] = None) -> CommandResponse:
        # Workbench capture holds entry and result state across maintenance.
        # Initialization and helpers that suppress their own errors need separate
        # acceptance. This guard covers r(), c(rc), more and requested trace.
        output_buffer, error_buffer = StringIO(), StringIO()
        rc, sys_error, failure = 1, None, None
        token = uuid.uuid4().hex[:24]
        entry_name, result_name = "_wb_ci_" + token, "_wb_co_" + token
        entry_rc = result_rc = old_more = old_trace = None
        entry_held = entry_restored = result_held = dispatched = False
        more_attempted = trace_attempted = log_attempted = False
        use_p, start_off, smcl_path, log_name, smcl_content = False, None, None, None, ""
        cleanup_errors = []

        def internal(statement):
            return self._run_internal("nobreak {\n" + statement + "\n}", echo=False)

        def attempt(action):
            try:
                return action()
            except BaseException as error:
                # A cleanup interruption must not skip the remaining cleanup.
                cleanup_errors.append(error)
                return None

        with self._exec_lock:
            if not self._initialized:
                self.init()
            self._is_executing = True
            self._last_results = None
            try:
                from sfi import Scalar, Macro
                value = self._get_rc_from_scalar(Scalar)
                if type(value) is not int or not 0 <= value <= 2147483647:
                    raise RuntimeError("Cannot read entry Stata return code")
                old_more = Macro.getGlobal("c(more)")
                old_trace = Macro.getGlobal("c(trace)") if trace else None
                if old_more not in ("on", "off") or (trace and old_trace not in ("on", "off")):
                    raise RuntimeError("Cannot read entry Stata pagination/trace")
                # Invalid entry reads permit zero Stata commands.
                entry_rc = value
                with self._temp_cwd(cwd), self._redirect_io(output_buffer, error_buffer):
                    try:
                        internal("_return hold " + entry_name)
                        entry_held = True
                        more_attempted = True
                        internal("set more off")
                        self._increment_command_idx()
                        code = self._maybe_rewrite_graph_name_in_command(code)
                        self._invalidate_macro_cache_if_needed(code)

                        use_p = bool(self._persistent_log_path and os.path.exists(self._persistent_log_path) and cwd is None)
                        smcl_path = self._persistent_log_path if use_p else self._create_smcl_log_path(prefix="mcp_", max_hex=16)
                        log_name = self._persistent_log_name if use_p else self._make_smcl_log_name()
                        # Also validate before our direct flush/close operations.
                        if not isinstance(log_name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,31}", log_name) or log_name == "_all":
                            raise RuntimeError("Invalid capture log name")
                        log_attempted = True
                        if not self._open_smcl_log(smcl_path, log_name, quiet=True, append=use_p):
                            raise RuntimeError("Failed to open capture SMCL log")
                        if use_p:
                            internal("quietly log flush " + log_name)
                        start_off = os.path.getsize(smcl_path) if use_p else 0
                        if trace:
                            trace_attempted = True
                            internal("set trace on")
                        internal("_return restore " + entry_name)
                        entry_held = False
                        entry_restored = True
                        internal("capture error " + str(entry_rc))
                        dispatched = True
                        try:
                            self.stata.run(code, echo=echo)
                        except BaseException as error:
                            failure = error
                        finally:
                            # Read even on failure/Break, before any Stata cleanup.
                            try:
                                value = self._get_rc_from_scalar(Scalar)
                            except BaseException as error:
                                value = None
                                if failure is None:
                                    failure = error
                                else:
                                    cleanup_errors.append(error)
                            if type(value) is int and 0 <= value <= 2147483647:
                                result_rc = value
                                rc = value if value or failure is None else 1
                            else:
                                rc = 1
                                if failure is None:
                                    failure = RuntimeError("Cannot read user Stata return code")
                            internal("_return hold " + result_name)
                            result_held = True
                    except BaseException as error:
                        if failure is None:
                            failure = error
                        else:
                            cleanup_errors.append(error)
                        if entry_restored and not dispatched:
                            # The entry holder was consumed immediately before
                            # restoring RC. Re-hold it if that last setup step
                            # failed, before log/setting cleanup can overwrite it.
                            try:
                                internal("_return hold " + entry_name)
                                entry_held = True
                            except BaseException as hold_error:
                                cleanup_errors.append(hold_error)
                    finally:
                        if log_attempted:
                            action = "flush " if use_p else "close "
                            attempt(lambda: internal("quietly log " + action + log_name))
                        # File reads and any retry flush remain inside the lock
                        # and the held results, before startup and final restore.
                        if start_off is not None:
                            def read_output():
                                return self._read_persistent_log_chunk(start_off) if use_p else self._read_smcl_file(smcl_path)
                            smcl_content = attempt(read_output) or ""
                            if use_p and not smcl_content:
                                attempt(lambda: internal("quietly log flush " + log_name))
                                smcl_content = attempt(read_output) or ""
                        if smcl_path and not use_p:
                            attempt(lambda: self._safe_unlink(smcl_path))
                        if dispatched and result_held:
                            attempt(lambda: self._maybe_reload_startup_after_command(code))
                        if trace_attempted:
                            attempt(lambda: internal("set trace " + old_trace))
                        if more_attempted:
                            attempt(lambda: internal("set more " + old_more))
                        if result_held:
                            attempt(lambda: internal("_return restore " + result_name))
                        elif entry_held:
                            attempt(lambda: internal("_return restore " + entry_name))
                        if entry_rc is not None:
                            # Unknown user RC is reported as failure, not invented
                            # as a successful native result.
                            final_rc = (result_rc if result_rc is not None else 1) if dispatched else entry_rc
                            attempt(lambda: internal("capture error " + str(final_rc)))
            except BaseException as error:
                if failure is None:
                    failure = error
                else:
                    cleanup_errors.append(error)
            finally:
                self._is_executing = False
                self._last_results = None

        errors = ([failure] if failure is not None else []) + cleanup_errors
        if errors:
            sys_error = "; ".join(str(error) for error in errors)
            for error in errors:
                if not isinstance(error, Exception):
                    error.add_note(sys_error)
                    raise error
            if rc == 0:
                rc = 1
            error_buffer.write(("\n" if error_buffer.getvalue() else "") + sys_error)

`;

function patchClient(source) {
  if (source.split(START).length !== 2) throw new Error("missing or ambiguous capture method");
  const start = source.indexOf(START);
  const following = source.slice(start + START.length).search(/^    (?:async )?def /m);
  const methodEnd = following < 0 ? source.length : start + START.length + following;
  const method = source.slice(start, methodEnd);
  if (method.split(END).length !== 2) throw new Error("missing or ambiguous capture boundary");
  const end = start + method.indexOf(END), original = source.slice(start, end);
  if (original === REPLACEMENT) return source;
  if (original.includes(MARKER) || crypto.createHash("sha256").update(original).digest("hex") !== ORIGINAL_SHA256) {
    throw new Error("unsupported capture source identity");
  }
  return source.slice(0, start) + REPLACEMENT + source.slice(end);
}

module.exports = { patchClient, REPLACEMENT, ORIGINAL_SHA256, START, END, MARKER };
