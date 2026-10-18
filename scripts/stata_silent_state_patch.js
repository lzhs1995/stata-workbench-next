"use strict";

const crypto = require("node:crypto");
const MARKER = "Workbench silent maintenance captures state under the execution lock";
const BLOCKS = [
  {
    start: "    def _get_preserved_rc(", end: "    def _restore_state(",
    sha256: "642fb9ac0ecdb90cfbd58f6fb8655d053a4fe96ab8a0903bd9e9b05efbf0c6a7",
    replacement: `    def _get_preserved_rc(self) -> int:
        # Use the strict, read-only reader; unknown is never successful RC 0.
        return self._get_rc_from_scalar()

`,
  },
  {
    start: "    def _exec_no_capture_silent(", end: "    def exec_lightweight(",
    sha256: "6c2bd6debb0a4ef27f2ed3ed1e87d37129cdbfccd28c89910705d69be2f8ed0c",
    replacement: String.raw`    def _exec_no_capture_silent(self, code: str, echo: bool = False, trace: bool = False) -> CommandResponse:
        # Workbench silent maintenance captures state under the execution lock.
        # This guard covers r(), c(rc), and requested trace, not all Stata state.
        # Workbench internal no-capture commands must stay out of the visible log.
        output_buffer, error_buffer = StringIO(), StringIO()
        token = uuid.uuid4().hex[:24]
        hold_name, rc_name = "_wb_sh_" + token, "_wb_sr_" + token
        rc, preserved_rc, old_trace = 1, None, None
        held = scalar_attempted = trace_attempted = False
        failure = None
        cleanup_errors = []

        def internal(statement):
            return self._run_internal("nobreak {\n" + statement + "\n}", echo=False)

        def cleanup(statement):
            try:
                internal(statement)
            except Exception as error:
                cleanup_errors.append(error)

        with self._exec_lock, self._redirect_io(output_buffer, error_buffer):
            try:
                from sfi import Scalar, Macro
                value = self._get_preserved_rc()
                if type(value) is not int or not 0 <= value <= 2147483647:
                    raise RuntimeError("Cannot read entry Stata return code")
                if trace:
                    old_trace = Macro.getGlobal("c(trace)")
                    if old_trace not in ("on", "off"):
                        raise RuntimeError("Cannot read entry Stata trace setting")
                # No Stata command is permitted until all entry reads pass.
                preserved_rc = value
                internal("_return hold " + hold_name)
                held = True
                scalar_attempted = True
                internal("scalar " + rc_name + " = .")
                if trace:
                    trace_attempted = True
                    internal("set trace on")
                inner_code = "{\n" + code + "\n}" if "\n" in code.strip() else code
                # A scalar survives the PyStata call boundary; a local may not.
                self.stata.run("capture quietly " + inner_code + "\nscalar " + rc_name + " = _rc\n", echo=echo)
                value = Scalar.getValue(rc_name)
                if (type(value) not in (int, float) or not 0 <= value <= 2147483647
                        or (type(value) is float and not value.is_integer())):
                    raise RuntimeError("Cannot read internal Stata return code")
                rc = int(value)
            except BaseException as error:
                # Interruptions still run cleanup and are re-raised below.
                failure = error
                parsed = self._parse_rc_from_text(str(error))
                rc = parsed if type(parsed) is int and 0 < parsed <= 2147483647 else 1
            finally:
                if scalar_attempted:
                    cleanup("scalar drop " + rc_name)
                if trace_attempted:
                    cleanup("set trace " + old_trace)
                if held:
                    cleanup("_return restore " + hold_name)
                if preserved_rc is not None:
                    cleanup("capture error " + str(preserved_rc))
                self._last_results = None

        messages = ([str(failure)] if failure is not None else [])
        messages.extend("cleanup: " + str(error) for error in cleanup_errors)
        if failure is not None and not isinstance(failure, Exception):
            if cleanup_errors:
                failure.add_note("; ".join(messages))
            raise failure
        if cleanup_errors and rc == 0:
            rc = 1
        diagnostic = "; ".join(messages)
        stderr = error_buffer.getvalue()
        if diagnostic:
            stderr += ("\n" if stderr else "") + diagnostic
        return CommandResponse(
            command=code, rc=rc, stdout=output_buffer.getvalue(), stderr=stderr,
            success=rc == 0 and failure is None and not cleanup_errors,
        )

`,
  },
];

function patchClient(source) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    if (result.split(block.start).length !== 2 || result.split(block.end).length !== 2) {
      throw new Error("missing or ambiguous silent state boundary");
    }
    const start = result.indexOf(block.start), end = result.indexOf(block.end);
    if (end <= start) throw new Error("invalid silent state boundary order");
    const original = result.slice(start, end);
    if (original === block.replacement) { states.push("candidate"); continue; }
    if (crypto.createHash("sha256").update(original).digest("hex") !== block.sha256) {
      throw new Error("unsupported silent state source identity");
    }
    states.push("original");
    result = result.slice(0, start) + block.replacement + result.slice(end);
  }
  if (new Set(states).size !== 1) throw new Error("mixed silent state source identity");
  return result;
}

module.exports = { patchClient, BLOCKS, MARKER };
