# Troubleshooting

## cmux rejects the caller, interactive resume fails, or setup repeats

Read [signature, terminal and permission recovery](desktop-auth-terminal-recovery.md).
Classify the exact error before suggesting another restart or grant. Verify the
actual executable and broker requirement for -67050; verify fd 0/1/2 through the
user's real proxy route for a TTY failure; complete the current helper's setup
for onboarding failures. A proxy attachment message is not a successful resume.
Keep the original session, pending receipts and already completed Stata runs.
Actual desktop reading, original Code profile and backend readiness need separate
evidence. Never start another profile or disable authentication to evade a failure.

## Stata Terminal appears busy forever

Check bridge status before running more code. Do not queue another long run into a busy shared session.

## Graphs do not appear

Check graph status and whether the command produces retained graph objects or transient unnamed graphs.

## Long script stalls

Use segmented execution, preserve logs under a run root, and verify output freshness.
First reconcile the original request, raw log and actual outputs. A timeout or
failed HTTP response is not proof that Stata did not run. Do not reset or resend
an unconfirmed request. Follow [storage and log recovery](storage-and-log-recovery.md)
and the task's existing state-preservation plan; continue only from its verified
completed prefix.

## Stata session is stopped

Confirm the exact process and its birth time, original profile and listener owner.
If the original backend exited, recover that authorized profile under its saved
plan, verify the new generation and rebind the matching client. Restore only
authorized backed-up state, never a consumed one-use restore. Verify true READY
and idle before productive work. A free port does not explain why Stata exited.

## The `code` command cannot install the VSIX

Confirm which executable PowerShell resolves:

```powershell
Get-Command code
code --version
```

If `code --version` fails, install from VSIX through the VS Code UI or fix your shell PATH so `code` points to the current VS Code `bin\code.cmd`.

## Marketplace or Open VSX cannot find the extension

For current releases, use Open VSX or the GitHub Release VSIX. The Visual Studio Marketplace package is not currently published.
