"use strict";

const crypto = require("node:crypto");
const START = "    def _get_rc_from_scalar(";
const END = "    def _parse_rc_from_text(";
const MARKER = "Workbench RC reads never execute Stata or convert unknown to success";
const ORIGINAL_SHA256 = "2927279d9795867b95ecd2f2181ed656933a1e36030a50043fb98450541ddecc";
const REPLACEMENT = `    def _get_rc_from_scalar(self, Scalar=None) -> int:
        # Workbench RC reads never execute Stata or convert unknown to success.
        # SFI may expose a C return code as an integer-valued float.
        # Bound accepted codes to nonnegative signed 32-bit values; -1 is unknown.
        try:
            if Scalar is None:
                from sfi import Scalar
            value = Scalar.getValue("c(rc)")
            if type(value) not in (int, float) or not 0 <= value <= 2147483647:
                return -1
            if type(value) is float and not value.is_integer():
                return -1
            return int(value)
        except Exception:
            return -1

`;

function patchClient(source) {
  if (source.split(START).length !== 2 || source.split(END).length !== 2) {
    throw new Error("missing or ambiguous RC reader boundary");
  }
  const start = source.indexOf(START), end = source.indexOf(END);
  if (end <= start) throw new Error("invalid RC reader boundary order");
  const block = source.slice(start, end);
  if (block === REPLACEMENT) return source;
  if (source.includes(MARKER) || crypto.createHash("sha256").update(block).digest("hex") !== ORIGINAL_SHA256) {
    throw new Error("unsupported RC reader source identity");
  }
  return source.slice(0, start) + REPLACEMENT + source.slice(end);
}

module.exports = { patchClient, REPLACEMENT, MARKER, ORIGINAL_SHA256, START, END };
