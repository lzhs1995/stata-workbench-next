"use strict";

// Pure source transform. patchRuntime owns compilation, write and rollback.
const crypto = require("node:crypto");
const START = "    def _run_streaming_blocking(";
const END = "    def _resolve_do_file_path(";
const MARKER = "Workbench streaming worker preserves entry returns and pagination";
const ORIGINAL_SHA256 = "d2ad5b6c550f605ecfacf2406ab523fba1aa73b7ef95dbc74289a8b41f52575b";
const REPLACEMENT = String.raw`    def _run_streaming_blocking(
        self,
        *,
        command: str,
        tee: FileTeeIO,
        cwd: Optional[str],
        trace: bool,
        echo: bool,
        smcl_path: str,
        smcl_log_name: str,
        hold_attr: str,
        require_smcl_log: bool = False,
    ) -> tuple[int, Optional[Exception]]:
        # Workbench streaming worker preserves entry returns and pagination.
        # This boundary excludes the outer async graph cache and startup hooks.
        # Holders belong to this invocation, never to a stale client attribute.
        rc = -1
        exc: Optional[Exception] = None
        token = uuid.uuid4().hex[:24]
        entry_name, result_name, rc_name = ("_wb_in_" + token,
                                           "_wb_out_" + token,
                                           "_wb_rc_" + token)
        entry_held = result_held = dispatched = log_attempted = False
        old_more = old_trace = None
        entry_rc = 0
        cleanup_errors = []

        def read_rc(Scalar, name):
            value = Scalar.getValue(name)
            if value is None or not float(value).is_integer() or not 0 <= float(value) <= 2147483647:
                raise RuntimeError("Invalid Stata return code: " + name)
            return int(value)

        def internal(code):
            # Cleanup must run after a Stata Break; never use capture to hide
            # failure of hold/restore or setting restoration from Python.
            return self._run_internal("nobreak {\n" + code + "\n}", echo=False)

        def cleanup(code):
            try:
                internal(code)
            except Exception as error:
                cleanup_errors.append(error)

        with self._exec_lock:
            self._is_executing = True
            self._last_results = None
            try:
                from sfi import Scalar, Macro
                # SFI reads do not execute a Stata command or overwrite r().
                old_more = Macro.getGlobal("c(more)")
                old_trace = Macro.getGlobal("c(trace)") if trace else None
                entry_rc = read_rc(Scalar, "c(rc)")
                if old_more not in ("on", "off") or (trace and old_trace not in ("on", "off")):
                    raise RuntimeError("Cannot read Stata pagination/trace state")
                with self._temp_cwd(cwd):
                    try:
                        internal("_return hold " + entry_name)
                        entry_held = True
                        internal("set more off")
                        log_attempted = True
                        log_opened = self._open_smcl_log(
                            smcl_path, smcl_log_name, quiet=True,
                            append=bool(self._persistent_log_path and smcl_path == self._persistent_log_path),
                        )
                        if require_smcl_log and not log_opened:
                            raise RuntimeError("Failed to open SMCL log")
                        if trace:
                            internal("set trace on")

                        direct_buf = io.StringIO()
                        with self._redirect_io_streaming(direct_buf, direct_buf):
                            # Last maintenance before user code. The entry holder
                            # is consumed here; final cleanup preserves USER results.
                            internal("_return restore " + entry_name)
                            entry_held = False
                            internal("capture error " + str(entry_rc))
                            is_multi_line = "\n" in command.strip()
                            dispatched = True
                            try:
                                if is_multi_line:
                                    bundle = (
                                        "capture noisily {\n"
                                        + ("noisily {\n" if echo else "")
                                        + command + "\n"
                                        + ("}\n" if echo else "")
                                        + "}\nscalar " + rc_name + " = _rc\n"
                                    )
                                    self.stata.run(bundle, echo=echo)
                                    rc = read_rc(Scalar, rc_name)
                                else:
                                    self.stata.run(command, echo=echo)
                                    rc = read_rc(Scalar, "c(rc)")
                            except Exception as error:
                                exc = error
                                # Read before ANY cleanup. A failed read never
                                # turns an exception into a successful response.
                                parsed = self._parse_rc_from_text(str(error))
                                if parsed is None:
                                    try:
                                        parsed = read_rc(Scalar, "c(rc)")
                                    except Exception:
                                        parsed = None
                                rc = parsed if parsed is not None and parsed > 0 else 1
                            finally:
                                # Also protect the partial results of failed or
                                # interrupted user code. Do not reuse the entry.
                                if rc < 0:
                                    try:
                                        rc = read_rc(Scalar, "c(rc)")
                                    except Exception:
                                        rc = 1
                                internal("_return hold " + result_name)
                                result_held = True
                    except Exception as error:
                        if exc is None:
                            exc = error
                        else:
                            cleanup_errors.append(error)
                        if rc <= 0:
                            rc = 1
                    finally:
                        if log_attempted:
                            # Close exactly this invocation's named log. The old
                            # helper could fall back to closing the user's log.
                            if self._persistent_log_name and smcl_log_name == self._persistent_log_name:
                                cleanup("capture quietly log flush " + smcl_log_name)
                            else:
                                cleanup("capture quietly log close " + smcl_log_name)
                        if dispatched and "\n" in command.strip():
                            cleanup("capture scalar drop " + rc_name)
                        if trace and old_trace in ("on", "off"):
                            cleanup("set trace " + old_trace)
                        if old_more in ("on", "off"):
                            cleanup("set more " + old_more)
                        if result_held:
                            cleanup("_return restore " + result_name)
                        elif entry_held:
                            cleanup("_return restore " + entry_name)
                        # Preserve entry c(rc) on a zero-dispatch failure. HTTP
                        # still reports the preparation error using its own rc.
                        cleanup("capture error " + str(rc if dispatched and rc >= 0 else entry_rc))
                if cleanup_errors:
                    message = "; ".join(str(error) for error in cleanup_errors)
                    exc = RuntimeError("Stata worker cleanup failed: " + message
                                       + ("; original: " + str(exc) if exc else ""))
                    if rc <= 0:
                        rc = 1
            except Exception as error:
                exc = error
                if rc <= 0:
                    rc = 1
            finally:
                self._is_executing = False
                self._last_results = None
        return rc, exc

`;

function patchClient(source) {
  if (source.split(START).length !== 2 || source.split(END).length !== 2) {
    throw new Error("missing or ambiguous streaming worker boundary");
  }
  const start = source.indexOf(START), end = source.indexOf(END);
  if (end <= start) throw new Error("invalid streaming worker boundary order");
  const block = source.slice(start, end);
  if (block === REPLACEMENT) return source;
  if (source.includes(MARKER) || crypto.createHash("sha256").update(block).digest("hex") !== ORIGINAL_SHA256) {
    throw new Error("unsupported streaming worker source identity");
  }
  return source.slice(0, start) + REPLACEMENT + source.slice(end);
}

module.exports = { patchClient, REPLACEMENT, MARKER, ORIGINAL_SHA256 };
