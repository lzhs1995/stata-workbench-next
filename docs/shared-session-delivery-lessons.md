# Shared-session execution and delivery lessons

This operating guidance does not claim that a candidate extension is installed, loaded, or accepted on a native backend. Record those states independently.

## Honor the current visibility agreement

Show the source and shared Stata Terminal together by default. When the user explicitly permits covering, hiding, or minimizing the original window, retain that permission across handoffs and continue authorized non-UI work on the same bound backend. Report physical visibility as unmeasured when appropriate. An unresponsive renderer, uncertain backend ownership, or an unsettled request is a separate condition; permission to cover the window does not resolve it.

## Preserve the author's DO file

Keep original filenames, variable names, comments, section structure, calculation order, and explanatory style. Make the smallest necessary correction and explain its cause near the changed line. Preserve the original and bind the actually executed revision to complete source hashes. Keep review-only annotations distinct from executable revisions. Do not remove meaningful author code merely to obtain a successful return code. If an adapter needs a transformed execution copy, retain the original and a source map.

## Serialize one backend

Human and AI execution share one serialized Stata backend. Offline review of frozen files may proceed in parallel; multiple agents or editor windows do not establish independent execution backends. Check the actual session binding and original request settlement before the next submission. Continue the first unfinished dependent stage and reuse accepted data and outputs.

## Build an actual data-output inventory

Derive expected outputs from the Stata save commands that actually executed. Preserve each source expression and resolve its filename using the command's effective working directory and macro values. When a save filename has no extension, record the effective `.dta` filename according to Stata's filename semantics. For example, `save "results/panel", replace` produces `results/panel.dta` under the effective working directory.

Do not split command arguments blindly at spaces or commas inside quotes. Account for ordinary and compound quotes, macro expansion, line continuations, and working-directory changes. Do not guess an unresolved dynamic path; bind it to the native log or a verified emitted output manifest. Preserve an explicit non-default extension if Stata accepted it. Deduplicate by resolved output identity while retaining all source references, and separately record repeated writes to one path.

For each final output, record its actual resolved path, source statement, originating request and stage, existence, bytes, hash, and appropriate data validation. A nonempty file alone does not establish a correct dataset. Missing output names caused by an omitted default extension require correcting the inventory, not rerunning successful cleaning or overwriting accepted data. This section specifies the required behavior; it does not assert that every client already implements a complete Stata parser.

## Separate provisional transport status from final execution

An accepted/running response, transport timeout, or rejected submission is not by itself the final Stata outcome. Persist the original requestId/runId and submission intent. Determine whether rejection occurred before dispatch or after execution became possible. An explicit zero-dispatch refusal differs from an uncertain submitted request.

After possible dispatch, reconcile the same request using its native log, completion marker, final return codes, restoration result, and actual output evidence. Keep HTTP status, plugin return code, wrapper/business return code, cleanup result, and final artifact acceptance separate. Do not resubmit because an interim response is inconvenient or because a terminal tool call timed out. A completed native calculation can coexist with a failed transport response. Preserve unknown and failed receipts; a necessary new diagnostic needs its own scope and identity.

## Label resource budgets by their actual source

A reserve or projected storage budget chosen by an agent is an implementation assumption, not a user requirement. Record who selected it, its units, its evidence, the expected peak output size, and when it was last checked. Do not convert historical task-local numbers into universal product rules or attribute them to the user without an explicit user instruction. Reassess assumptions against the real remaining work and current storage; preserve original datasets and accepted evidence. Publishing this guidance does not authorize deletion or change an existing live controller.

In the documented continuation, the original user instruction explicitly requires a **20 GB (20,000,000,000-byte) reserve**. Calling that reserve an agent assumption was incorrect. The **23 GB (23,000,000,000-byte) scientific-submission budget** is a historical implementation budget; the **new plugin acceptance budget is 20 GB plus 500 MB (20,500,000,000 bytes)**. None is a universal skill installation threshold. Below the user's reserve, actively back up eligible task files to the authorized Baidu folder, verify them before authorized reclamation, and continue independent work. Uploading alone frees no space; a shortfall must not halt the whole task.

## Preserve verified graph recovery and release boundaries

If data are already accepted and only a graph export failed, reuse the data and generate only missing outputs. Record the actual rendering route. A successful SVG-to-PNG conversion does not prove native bitmap export is repaired or every pixel equals a historical image. Decode images and review an appropriate visual preview. Keep native GPH save acceptance distinct from a separate GPH reload check and from scientific interpretation.

Do not reproduce a suspected native bitmap hang in a live research backend merely to reconfirm it. For a new candidate, preserve the existing error finalizer, bounded Terminal history, source/graph column routing, and log-tail fairness behavior. Check the actual modules and bundle inside the final package, not only the version string. Record source revision, offline checks, package hash, installed files, loaded host identity, and bounded native acceptance separately. Reuse completed checks while their inputs remain unchanged; test a changed boundary at the narrowest meaningful scope.
