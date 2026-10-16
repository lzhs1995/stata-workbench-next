# macOS permissions: Automation is not a window count

## Classify cmux caller trust and helper setup first

Read [the complete 2026-10-17 recovery record](desktop-auth-terminal-recovery.md)
for `not signed OpenAI Codex (OSStatus -67050)`,
`stdout is not a terminal`, or cmux Computer Use onboarding failures.
Those require separate checks of the running caller's publisher signature,
interactive child descriptors and the helper's Accessibility/Screen Recording.
They are not diagnosed by an empty Automation list. Follow cmux's installed
skill and helper-owned permission UI; never edit TCC or bypass broker trust.
After setup, verify an actual desktop read, then the original Workbench
profile, current listener owner, loaded extension and Stata generation.
Do not re-request completed grants or restart a successfully resumed conversation.

The Apple Events tooling and historical observations below have a different scope.
Applies to the Mac tools in `v0.1.3-rc.7.39-public.2` (tool version `1.1.0`).
The extension runtime is unchanged. Older tool copies do not gain this fix by
reinstalling the same VSIX: update the repository tools as well.

## First-time setup / 首次授权

Use the **same terminal or agent host** that will run `shared_stata.py`, with the
same profile and port settings as the [quick start](QUICKSTART.md):

```sh
python3 -B tools/verified_workbench.py --doctor
python3 -B tools/verified_workbench.py --request-permissions
python3 -B tools/verified_workbench.py --status
```

- `--doctor` does not request consent, launch Workbench or send Stata code. It
  reports process ancestry, candidate app IDs/signatures, a passive Apple Events
  check and (when already permitted) a read-only window query. Recent permission
  service errors are best-effort diagnostics, not proof of per-app permission.
  If System Events has exited while idle, observation can start only that
  background system app once and recheck consent without prompting. It never
  substitutes a new Workbench/Stata or treats successful app launch as consent.
- `--request-permissions` makes **one read-only System Events query**. If needed,
  macOS displays an Automation prompt; the human must click **Allow**. When no
  Workbench is running it can start **System Events only**, not Workbench/Stata;
  the result remains blocked for window readiness until Workbench is opened.
- Under **System Settings → Privacy & Security → Automation**, allow the app
  named by the prompt to control **System Events**. CLI agents launched inside
  cmux may be attributed to cmux, not to ChatGPT or Codex. Ancestry is a candidate
  list; the system prompt or correlated TCC log is the attribution authority.
- **Accessibility** is separate. A query can have Automation permission but fail
  when inspecting application windows. Enable Accessibility for the responsible
  host if the system reports that requirement. The native probe's trust value
  belongs to that probe process, not a universal permission grant to all agents.

中文：请在报错 agent 的同一宿主中申请；给 Terminal 授权不等于给 cmux、
ChatGPT 或另一个 Python 宿主授权。自动化列表为空时没有开关可点，先发起
上述显式申请；若仍然没有弹窗，检查宿主声明、签名及权限服务错误，别反复申请。

## Error meanings / 错误含义

| Result | Meaning / action |
|---|---|
| `AUTOMATION_DENIED`, `-1743` | macOS refused the event. This does **not** prove the user clicked Deny; host eligibility or a broken permission service can also cause it. |
| `AUTOMATION_CONSENT_REQUIRED`, `-1744` | Passive check says consent is needed; use the explicit request once. |
| `SYSTEM_EVENTS_NOT_RUNNING`, `-600` in passive check | Permission is unmeasured. Observation starts only System Events once and rechecks; if still unavailable, it stops. Never permission to start another Stata. |
| `ACCESSIBILITY_DENIED` | Inspect the raw error and Accessibility settings separately from Automation. |
| `WINDOW_QUERY_TIMEOUT`, `WINDOW_QUERY_FAILED`, `WINDOW_QUERY_INVALID_RESPONSE` | Window count is unknown, not zero. No automatic retry or replacement instance. |
| `ok: true, count: 0` | A successful window read returned zero. This alone does not diagnose Stata health. |

Unknown counts are JSON `null`, with `windowObservation` retaining the original
return code, stdout/stderr and Apple Event error where available. `/status`
identity, owner, readiness and backend checks remain mandatory; they are not
replaced by a permission grant. The client still requires exactly one window.

Before a POST, denial produces `BLOCKED_NO_DISPATCH`, `postCount: 0`. If permission
is lost **after** a POST, the outcome is `EXECUTION_UNCONFIRMED_NO_RETRY` with
`postCount: 1`: inspect retained evidence; never claim no execution or repeat it.

## Empty Automation list and permission-service failure

An empty list plus `-1743` is not necessarily missing app metadata. In one local
2026-09-09 observation, a signed cmux 0.64.22 had both the Apple Events entitlement
and usage description, but the correlated user `tccd` log said **Database failed
to open during _doEval** and returned denial without a consent prompt. A read-only
database integrity check was OK; this did not prove the running service could
open the database. A service-reopen attempt was refused by SIP. No bypass was used.

If this exact service failure appears, stop prompt/retry loops. Save all work;
an operator-managed macOS logout/restart is a next recovery step to let system
services reopen their state, **not a guaranteed fix**. It ends in-memory sessions,
so never do it automatically during research. If the error persists after that,
retain logs and seek Apple/system-administrator diagnosis.

Do not delete or edit `TCC.db`, reset all permissions, disable SIP, re-sign other
apps, or give Full Disk Access as a substitute for Automation. These tools do
none of those things and do not restart system services.

## Persistence and acceptance boundary

### Verified recovery follow-up — 2026-09-09

The affected local Mac **subsequently recovered**. Reboot alone had not fixed it:
the new user `tccd` opened its version-32 database successfully, then logged
`database is locked`, invalid connection errors and repeated open failures.
Read-only `quick_check` was still OK. A scoped maintenance intervention ended
that stalled user service (normal termination did not complete; the exact
identity-checked process was then terminated), and macOS relaunched it. The
system service was not terminated. No TCC database edit/deletion, permission
reset, re-signing or SIP change was performed. The observed access-record count
was 1,223 before and after; this count alone is not proof of individual grants.

Actual subsequent checks established permission **GRANTED**, one correctly
bound Workbench window, and successful `display`-only runs through the existing
terminal-handler diagnostic API and the formal AI shared client. Both paths
used the same Stata backend; the AI client made one POST, zero retries, returned
`rc=0`, and its exact client/run completion markers were read from the raw log.
All 20 recovery readback checks passed; the final instance was idle/ready with
recovery not required. The accepted runtime bundle was unchanged.

This is a **local recovery observation, not a universal restart recipe**. The
tools do not automatically terminate permission services. Do not kill arbitrary
PIDs or alter privacy records. Diagnosing a confirmed service deadlock is
different from bypassing an actual permission denial. No new FULL45 or physical
human typing was claimed for this follow-up.

Normal macOS consent is saved by the system, but cannot be guaranteed forever:
user revocation, managed policy, a different host, changed signing identity or
system failure can change effective access. Use a stable signed host and the
same tools/profile; recheck permissions before execution rather than caching a
past success as a permanent grant.

At publication, this revision had offline failure-path tests and a real zero-dispatch denial
receipt. **The affected host's recovery and a post-grant Stata smoke run were not
completed at publication** because its permission service was blocked. The dated
follow-up above records subsequent recovery without rewriting that history; no fresh
FULL45 or new universal permission certification is claimed. Historical local
runtime acceptance remains scoped as described in [ACCEPTANCE](ACCEPTANCE.md).

Sources: [Apple Automation settings](https://support.apple.com/guide/mac-help/mchl108e1718/mac),
[Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events),
[Apple permission-check API discussion](https://developer.apple.com/videos/play/wwdc2019/701/).
