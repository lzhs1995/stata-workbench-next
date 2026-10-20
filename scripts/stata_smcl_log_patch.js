"use strict";

const crypto = require("node:crypto");
const START = "    def _open_smcl_log(";
const END = "    def _restore_results_from_hold(";
const MARKER = "Workbench logs never close an unnamed user log";
const ORIGINAL_SHA256 = "756550578c078920ad07cebd98baccf7a442baebf4a19d1df52b4bd8ef40aff9";
const REPLACEMENT = String.raw`    def _open_smcl_log(self, smcl_path: str, log_name: str, *, quiet: bool = False, append: bool = False) -> bool:
        # Workbench logs never close an unnamed user log.
        # A failed named open is an error, not permission to close other logs.
        from sfi import Scalar
        if log_name == "_all" or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,31}", log_name):
            raise ValueError("Invalid internal log name")
        path_for_stata = smcl_path.replace("\\", "/")
        if any(char in path_for_stata for char in ('"', '\r', '\n', chr(96), chr(36))):
            raise ValueError("Unsupported internal log path")
        mode = "append" if append else "replace"
        rc_name = "_wb_log_rc_" + uuid.uuid4().hex[:20]
        opened = False
        try:
            bundle = (
                "nobreak {\n"
                f"capture quietly log close {log_name}\n"
                f"capture {'quietly ' if quiet else ''}log using \"{path_for_stata}\", {mode} smcl name({log_name})\n"
                f"scalar {rc_name} = _rc\n"
                "}"
            )
            self._run_internal(bundle, echo=False)
            opened = Scalar.getValue(rc_name) == 0
        except Exception as error:
            logger.warning("Named SMCL log open failed: %s", error)
        finally:
            try:
                self._run_internal("nobreak {\ncapture scalar drop " + rc_name + "\n}", echo=False)
            except Exception as error:
                # Do not report a clean open if its internal state leaked.
                logger.warning("SMCL log scalar cleanup failed: %s", error)
                opened = False
        if opened:
            self._last_smcl_log_named = True
        return opened

    def _close_smcl_log(self, log_name: str) -> None:
        if log_name == "_mcp_session":
            return
        if log_name == "_all" or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,31}", log_name):
            raise ValueError("Invalid internal log name")
        # A stale _last_smcl_log_named flag cannot select the user's log.
        self._run_internal("nobreak {\ncapture quietly log close " + log_name + "\n}", echo=False)

`;

function patchClient(source) {
  if (source.split(START).length !== 2 || source.split(END).length !== 2) {
    throw new Error("missing or ambiguous SMCL log boundary");
  }
  const start = source.indexOf(START), end = source.indexOf(END);
  if (end <= start) throw new Error("invalid SMCL log boundary order");
  const block = source.slice(start, end);
  if (block === REPLACEMENT) return source;
  if (source.includes(MARKER) || crypto.createHash("sha256").update(block).digest("hex") !== ORIGINAL_SHA256) {
    throw new Error("unsupported SMCL log source identity");
  }
  return source.slice(0, start) + REPLACEMENT + source.slice(end);
}

module.exports = { patchClient, REPLACEMENT, MARKER, ORIGINAL_SHA256 };
