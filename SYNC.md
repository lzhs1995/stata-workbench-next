# macOS / Windows capability and evidence ledger

Baseline: PR #7, `d63b230e5a02d5d2f3053bcc1d3184dcb2ad708e`, maintained runtime
`0.1.3-rc.7.44-dev.2`. Platform work is stacked on that draft; the research
profile has not been upgraded. This table is not a dual-OS certification.

| Capability | Shared implementation | macOS | Windows | Evidence / remaining check |
| --- | --- | --- | --- | --- |
| Execution identity, receipts, single POST | Python client and existing bridge | Existing logic retained | Same verifier | Python regressions; licensed candidate run pending |
| Stable process lock | OS adapter | flock plus existing controller locks | msvcrt byte-range lock | Real child-process contention/crash test; Windows CI pending |
| Code/profile/listener identity | OS adapter | ps/lsof, exact profile | CIM/TCP census, exact argv/profile, creation time | Windows OS tests pending; no process termination |
| Desktop/window observation | OS adapter | Existing passive permission protocol | Input desktop and EnumWindows | Top-level window count is not source/Terminal visibility |
| PowerShell dispatch | Shared Python client | Not applicable | 5.1/7 wrappers | Automatic reset/retry modes rejected before dispatch |
| Terminal / Graphs / Data Browser | Existing shared webview resources | Candidate GUI pending | Physical-machine GUI pending | PR #7 saved-image preview remains separately tracked |
| Build / package / audit | Versioned maintained bundle | ARM and Intel CI planned | x64 CI planned | Windows Server CI does not certify Windows 11 desktop/Stata |
| Clean extension source build | Separate migration | Pending | Pending | Current patch replay equality remains required |

Design source: the user's Tw93 clipping, https://x.com/HiTw93/status/2114702036264767748.
Apply its separation of common rules, native operations and UI, and its commit/evidence
tracking. VS Code remains the client; no Swift/WinUI rewrite or new VM dependency.

Only synthetic/public fixtures enter CI. Physical Windows target: Windows 11 x64
with licensed Stata 18 MP; record the actual versions before acceptance. Windows
ARM, Windows 10 and other Stata variants remain separately unverified.
