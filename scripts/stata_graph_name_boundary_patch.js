"use strict";
// Do not mistake st_isname(), varname(), or .name() for graph name().
// Keep the existing alias behavior for an actual name() option.
const BLOCKS = [
  {
    "name": "_GRAPH_NAME_PATTERN",
    "original": "_GRAPH_NAME_PATTERN = re.compile(r\"name\\(\\s*(\\\"[^\\\"]+\\\"|'[^']+'|[^,\\)\\s]+)\", re.IGNORECASE)\n",
    "replacement": "_GRAPH_NAME_PATTERN = re.compile(r\"(?<![\\w.])name\\(\\s*(\\\"[^\\\"]+\\\"|'[^']+'|[^,\\)\\s]+)\", re.IGNORECASE)\n"
  },
  {
    "name": "_GRAPH_REWRITE_RE",
    "original": "_GRAPH_REWRITE_RE = re.compile(\n    r\"name\\(\\s*(?:`\\\"(?P<cq>[^\\\"]*)\\\"'|\\\"(?P<dq>[^\\\"]*)\\\"|(?P<uq>[^,\\s\\)]+))\\s*(?P<rest>[^)]*)\\)\"\n)\n",
    "replacement": "_GRAPH_REWRITE_RE = re.compile(\n    r\"(?<![\\w.])name\\(\\s*(?:`\\\"(?P<cq>[^\\\"]*)\\\"'|\\\"(?P<dq>[^\\\"]*)\\\"|(?P<uq>[^,\\s\\)]+))\\s*(?P<rest>[^)]*)\\)\"\n)\n"
  }
];
const macroAnchor = '            original = (original or "").strip()\n';
BLOCKS.push({ name: "preserve-stata-macro-name", original: macroAnchor,
  replacement: macroAnchor +
    '            # Let Stata expand dynamic names; never alias the macro syntax.\n' +
    '            if "`" in original or "$" in original:\n' +
    '                return m.group(0)\n' });
function patchClient(source) {
  for (const block of BLOCKS) {
    const newCount = source.split(block.replacement).length - 1;
    const oldCount = source.split(block.original).length - 1
      - newCount * (block.replacement.split(block.original).length - 1);
    if (oldCount === 1 && newCount === 0) {
      source = source.replace(block.original, () => block.replacement);
    } else if (oldCount !== 0 || newCount !== 1) {
      throw new Error("unsupported graph name boundary: " + block.name);
    }
  }
  return source;
}
module.exports = { BLOCKS, patchClient };
