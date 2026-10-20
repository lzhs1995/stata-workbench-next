# Native worker startup and Stata command validation

The October 2026 isolated macOS validation exposed errors that offline mocked Stata calls had accepted. Preserve the original request and its raw stderr; a successful Python compile or mock test does not establish valid Stata syntax.

## Preserve worker and event-loop ownership

The worker process must receive only its own multiprocessing connection endpoint. Close the unused child endpoint in the manager after spawn so worker death can produce EOF. Pipe writes must not block the async event loop. A failed worker settles every pending request as an error; it must not silently create a replacement Stata session.

Cancellation waits for the original worker acknowledgement or a proven worker exit. A command must not be reported cancelled while an abandoned writer can still submit it later. Explicit stop owns termination, pipe writers, listener shutdown and connection close.

Manager shutdown awaits every session even if one stop fails. Remove successfully stopped sessions, preserve failed sessions for inspection, and report the collected errors after all peers finish.

Start sessions and serve the MCP stdio transport in the **same event loop**. The previous sequence, `asyncio.run(init_sessions()); mcp.run()`, closes the initialization loop and cancels its listeners before the transport starts. The candidate calls `init_sessions()` and `mcp.run_stdio_async()` inside one coroutine and stops sessions in its `finally` block. This is specific to the inspected FastMCP stdio API; verify the installed API before adapting other transports.

## Validate Stata syntax against the actual engine

Stata rejected `global ... : s(macros)` with `r(198)`. Enumerate stored string results using the documented Mata category `st_dir("s()", "macro", "*")`; the category includes parentheses. Transpose the returned column vector before `invtokens()`. The same correction applies to the pre-run checkpoint. See the [official st_dir manual](https://www.stata.com/manuals/m-5st_dir.pdf).

After that correction, a real worker initialized successfully. Subsequent execution exposed another unsupported statement, `log flush _mcp_session`. The [official log manual](https://www.stata.com/manuals/rlog.pdf) documents query, using, close, off and on; it does not document a flush subcommand. Preserve the original failure and verify a proposed replacement's actual logging behavior. Do not silently swallow the error and call it a completed run.

The candidate uses `log query` at all six owned-log call sites, including the dynamically assembled action. Query checks log availability; it is not a flush guarantee. Completion still requires the actual request's log and completion evidence.

## Preserve code and migrate complete helpers

The graph-name regex previously matched `name(` inside `st_isname()` and `varname()`. A native checkpoint failed with `r(3000)`, and its sample-variable macro was silently rewritten. Require a left identifier boundary in both graph-name patterns and leave macro-dependent names for Stata to expand. Tests reproduce the original transformation and preserve ordinary quoted graph aliases. This is a targeted correction, not a claim that the regex parses all Stata syntax.

A deployed notification helper shared the current comment marker but lacked the completion-tail variables. The patch installed its drain without upgrading its helper, causing `NameError: saw_required_tail`. Upgrade the exact legacy helper body, reject unknown or duplicate bodies, and verify idempotence. Preserve text continuity across chunks so a split completion marker remains recognizable. The regression now executes the complete deployed method after the production patch pipeline; isolated drain fragments had concealed the missing initialization.

Agent command and human-file completion protocols differ. Agent commands emit their exact DONE marker and return the captured rc in the response. The human-file finalizer also prints a numeric RC marker with padding. A verifier must check the protocol actually emitted by its route, including whitespace in the formatted number. Preserve an incorrect verifier's original receipt and reconcile the same successful request without resending it.

## Evidence boundaries

The session tests use spawned stub workers and cover death, startup failure, cancellation and full pipes. A separate negative control reproduces the split-event-loop listener loss. Neither test suite is native graph acceptance.

The corrected private worker and its agent bootstrap complete with HTTP 200, rc 0 and the exact DONE marker. One real Workbench Run Current File then generated PNG, saved/reloaded GPH and exported the reloaded image. Both PNGs decoded as 800×480, had identical pixels and were visually inspected. The body, frame restoration, private object cleanup and log close all returned zero.

Both PNG exports used the existing macOS SVG+sips compatibility path. This establishes that bounded Workbench export/reload workflow, **not native Stata bitmap recovery**. The fixture deleted its private graphs during cleanup, so no retained graph-panel display was accepted. The only changed shared sentinel was Claude's metadata; its attribution remains unknown, while all shared Stata/MCP sentinels were unchanged. Source checks, package identity, actual loading and these limited live results remain separate claims.
