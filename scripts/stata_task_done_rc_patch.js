"use strict";

// rc.7.85 follow-up (V3-M M5): mcp-stata 1.26.1's task_done event carries no
// return code, so the extension cannot tell "Stata ran and stopped at r(111)"
// from an unknown outcome. Both background _run paths now record the rc of
// the CommandResponse they just validated for this task, and _notify_task_done
// sends it as "rc". The source is that validated model's rc, an int >= 0
// (Pydantic may have coerced the raw value; the check runs after validation).
// If the call raised before returning a response (cancelled, worker error),
// nothing is recorded and task_done carries no "rc", so the run still reads as
// unknown. An exception after the assignment (result formatting, UI notify)
// can still send the rc of the response this task already received.
// Strict: unpatched, patched, partially patched and unknown sources are told
// apart by exact anchor counts; anything else throws (unsupported-source).
const MARKER = "Workbench task_done carries this run's Stata rc";

const RUN_ORIGINAL = `            result = CommandResponse.model_validate(result_dict)
            if not task_info.log_path and result.log_path:
                task_info.log_path = result.log_path
            if result.error:
                task_info.error = result.error.message
`;
const RUN_PATCHED = `            result = CommandResponse.model_validate(result_dict)
            if not task_info.log_path and result.log_path:
                task_info.log_path = result.log_path
            if result.error:
                task_info.error = result.error.message
            # ${MARKER}.
            task_info.wb_rc = result.rc if type(result.rc) is int and result.rc >= 0 else None
`;
// Present only after the task_done transport patch (mcp_stata_runtime_patch).
const NOTIFY_ORIGINAL = `        "error": task_info.error,
    }
    try:
        # Workbench task_done notification must not retain the MCP transport
`;
const NOTIFY_PATCHED = `        "error": task_info.error,
    }
    # ${MARKER}.
    _wb_rc = getattr(task_info, "wb_rc", None)
    if type(_wb_rc) is int:
        payload["rc"] = _wb_rc
    try:
        # Workbench task_done notification must not retain the MCP transport
`;
const EDITS = [
  { name: "background-run", original: RUN_ORIGINAL, patched: RUN_PATCHED, count: 2 },
  { name: "task-done-payload", original: NOTIFY_ORIGINAL, patched: NOTIFY_PATCHED, count: 1 },
];

const occurrences = (source, needle) => source.split(needle).length - 1;

// Removes every exact patched block; what remains must hold no anchor or marker.
// RUN_ORIGINAL is a prefix of RUN_PATCHED, so original counts are only
// meaningful after the patched blocks are gone.
function withoutPatchedBlocks(source) {
  let rest = source;
  for (const edit of EDITS) rest = rest.split(edit.patched).join("");
  return rest;
}

function state(source) {
  const marks = occurrences(source, MARKER);
  const counts = EDITS.map((edit) => ({ edit, original: occurrences(source, edit.original),
    patched: occurrences(source, edit.patched) }));
  if (marks === 0 && counts.every((c) => c.original === c.edit.count && c.patched === 0)) return "unpatched";
  if (marks === 3 && counts.every((c) => c.patched === c.edit.count)) {
    const rest = withoutPatchedBlocks(source);
    if (!rest.includes(MARKER) && EDITS.every((edit) => occurrences(rest, edit.original) === 0)) return "patched";
  }
  return "unsupported";
}

// Input and output are LF source (mcp_stata_runtime_patch normalizes EOLs).
function patchServer(source) {
  const current = state(source);
  if (current === "patched") return source;
  if (current !== "unpatched") {
    throw new Error("unsupported task_done rc source (" + EDITS.map((edit) => edit.name + ": original "
      + occurrences(source, edit.original) + ", patched " + occurrences(source, edit.patched)).join("; ")
      + ", markers " + occurrences(source, MARKER) + ")");
  }
  let next = source;
  for (const edit of EDITS) next = next.split(edit.original).join(edit.patched);
  return next;
}

// Exact inverse; refuses anything that is not exactly this patch's output.
function revertServer(source) {
  if (state(source) !== "patched") throw new Error("not a task_done rc patched source");
  let next = source;
  for (const edit of [...EDITS].reverse()) next = next.split(edit.patched).join(edit.original);
  if (state(next) !== "unpatched") throw new Error("task_done rc revert did not give an unpatched source");
  return next;
}

module.exports = { MARKER, RUN_ORIGINAL, RUN_PATCHED, NOTIFY_ORIGINAL, NOTIFY_PATCHED, EDITS, state, patchServer, revertServer };
