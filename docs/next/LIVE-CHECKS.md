# Stage C live checks

The following checks require a licensed host and are intentionally pending in this PR:

1. Start one isolated Next profile on a free port in `17601–17620`; confirm a session JSON is created under `~/.stata-workbench-next/sessions/` with mode 0600 and a 32-byte (64-hex-character) bearer token.
2. Confirm `/status`, `/run-command`, `/soft-stop`, and `/force-reset` reject missing or incorrect Bearer tokens with 401, reject a wrong Host or any Origin header with 403, and leave Stata generation unchanged.
3. Confirm the matching token and exact `Host: 127.0.0.1:<port>` allow the request, and that a rejected request appends a `bridge_rejected` event without source code.
4. Repeat on Windows and verify the registry ACL grants the current user read/write only. This PR contains the `icacls` implementation; Windows hardware validation remains pending.

No VS Code or Stata process was started during the source-level tests.
