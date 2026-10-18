"use strict";

const crypto = require("node:crypto");
const MARKER = "Workbench response RC comes from execution, never log text";
const BLOCKS = [
  { name: "_exec_with_capture", errorVar: "sys_error",
    start: "        # If RC looks wrong",
    sha256: "35d9e2027e4c85c118670dad947c97723d34d4be91b2c5bcbf9857b4ddbc9ed0",
    success: "        success = rc == 0 and sys_error is None\n" },
  { name: "run_command_streaming", errorVar: "exc",
    start: "        # Use SMCL content as primary source",
    sha256: "29709b5f6b6b1242195c8213cbe887c3519711f43ad642948c7152e501871490",
    success: "        success = (rc == 0 and exc is None)\n" },
  { name: "run_do_file_streaming", errorVar: "exc",
    start: "        # Use SMCL content as primary source",
    sha256: "49213aa5de7755569dc59bbc70d4424523e4cab6cf2f017f0792807c708efcc4",
    success: "        success = (rc == 0 and exc is None)\n" },
  { name: "run_do_file", errorVar: "exc",
    start: "        # Use SMCL content as primary source",
    sha256: "bc02a6d419485e85c1872a0dfc11c7b4aafe27ba6348e1dc27a4bd55951c4e0b",
    success: "        success = (rc == 0 and exc is None)\n" },
];

function replacement(block) {
  return `        # ${MARKER}.
        # Missing/invalid RC and exceptions must not produce a successful response.
        # The worker returns an int; bool, floats and strings are not valid RCs.
        if type(rc) is not int or rc < 0:
            rc = 1
        if ${block.errorVar} is not None and rc == 0:
            rc = 1

`;
}

function patchClient(source) {
  // Limit each decision block to its own method. Equal comments in other methods
  // are not an anchor, and duplicate definitions must not hide an unpatched path.
  const methods = [...source.matchAll(/^    (?:async )?def ([A-Za-z_][A-Za-z0-9_]*)\(/gm)];
  const edits = [];
  for (const block of BLOCKS) {
    const matches = methods.filter(method => method[1] === block.name);
    if (matches.length !== 1) throw new Error(`missing or ambiguous RC method: ${block.name}`);
    const method = matches[0];
    const end = methods[methods.indexOf(method) + 1]?.index ?? source.length;
    const body = source.slice(method.index, end);
    const candidate = replacement(block);
    const marker = `        # ${MARKER}.\n`;
    if (body.includes(marker) && body.includes(block.start)) {
      throw new Error(`mixed old and candidate RC decision: ${block.name}`);
    }
    const startAnchor = body.includes(marker) ? marker : block.start;
    if (body.split(startAnchor).length !== 2 || body.split(block.success).length !== 2) {
      throw new Error(`missing or ambiguous RC decision: ${block.name}`);
    }
    const start = body.indexOf(startAnchor), finish = body.indexOf(block.success);
    if (finish <= start) throw new Error(`invalid RC boundary order: ${block.name}`);
    const original = body.slice(start, finish);
    if (original === candidate) continue;
    if (body.includes(MARKER) || crypto.createHash("sha256").update(original).digest("hex") !== block.sha256) {
      throw new Error(`unsupported RC source identity: ${block.name}`);
    }
    edits.push({ start: method.index + start, end: method.index + finish, candidate });
  }
  // Validate all paths before returning any changed source.
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.candidate + source.slice(edit.end);
  }
  return source;
}

module.exports = { patchClient, replacement, MARKER, BLOCKS };
