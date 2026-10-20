# macOS / cmux recovery: signature, terminal and permissions

Incident date: 2026-10-16 UTC / 2026-10-17 Asia/Taipei.
This is a recovery record and an operating procedure, not a new Stata release.
Read it before diagnosing a cmux-hosted Workbench that cannot be reached.

The observed chain had three separate failures:

1. The running Codex executable was locally built and ad-hoc signed. The
   Computer Use broker rejected its immediate parent with OSStatus -67050.
2. The official signed replacement could not start interactively through
   `rtk proxy`: its standard output and error were pipes, even inside a PTY.
3. After correcting the launcher and resuming the original conversation,
   cmux Computer Use still needed its own permission/setup flow completed.

Actual desktop app enumeration and a VS Code screenshot/accessibility read then
succeeded. At the first documentation cutoff the original Workbench was still
pending. The later original-profile bootstrap passed at 23:57 UTC: see section 12
for new lock/generation binding, the one real display run and its exact limits.
The cause of the earlier Workbench exit remains unknown.

## 1. Keep the layers separate

| Layer | Required observation | What it does not establish |
|---|---|---|
| Conversation | Original session ID, journal, surface/workspace identity | Old in-memory Stata state |
| Caller trust | Executable actually running; explicit broker signing requirement passes | Helper permission or a successful desktop call |
| Interactive launch | Child fd 0, 1 and 2 are terminals; original session actually starts | A proxy attachment message is not sufficient |
| Helper setup | Current cmux Computer Use onboarding completed | Automation consent for an unrelated Apple Events tool |
| Desktop operation | A real namespaced cmux-cua call returns usable app state | Original Workbench selected or backend ready |
| Workbench binding | Exact profile, Code/extension-host identity, listener owner and loaded version | Stata execution or restored memory |
| Stata generation | Current backend PID/birth/identity, ready and idle, matching client | Previous generation's one-use restoration remains valid |
| Research acceptance | Submitted source, native log, outputs and historical comparison | Merely opening an editor or getting HTTP 200 |

Do not collapse these into a single “fixed” status. Save each result with its
time, process identity, request identity where applicable, and unresolved limits.

## 2. What failed, in order

All times below are UTC. Local Asia/Taipei dates are eight hours later.

| Time | Observed event | Correct conclusion |
|---|---|---|
| 21:41 | Official and locally built Codex binaries compared against the broker requirement | Same version number, different signing identity |
| 22:13 | Existing TCC rows and related skills inspected | Rows and Apple Events guidance could not fix caller trust |
| 22:18 | A restart created a new process still using the local build | Restart happened; the required executable had not changed |
| 22:27:59 and 22:28:33 | User ran the supplied recovery command twice; both attempts created backups, printed attachment=attached, then failed with stdout is not a terminal | Both user attempts were real; attachment was not successful resume |
| 22:36–22:38 | PTY test exposed piped output; controlling-terminal repair and refusal cases passed | Launcher repaired; desktop acceptance still pending |
| 22:51 | A new original-session backup preceded successful official-binary resume | New caller/MCP process generation; original conversation retained |
| 22:59 | One verification command omitted the leading equals sign in the -R argument | Invalid probe syntax, not a new signature failure |
| 23:00 | Correct explicit requirement verification returned zero | Official caller signature verified |
| After setup completion | Real list_apps and get_app_state returned apps, VS Code screenshot and accessibility tree | Desktop reading recovered; original profile/17525 still pending |

Private originals include failed attempts, signature output, launcher backups,
TTY controls, journal snapshot manifests, resumed-process checks and desktop
results. Public documentation contains the technical findings, not private
conversation logs, screenshots, research data, Stata licenses or credentials.

## 3. Diagnose -67050 before changing macOS permissions

Observed broker error:

```text
Computer Use approval broker authentication failed:
immediate parent pid <current-pid> is not signed OpenAI Codex (OSStatus -67050).
```

The rejected executable reported Codex 0.160.0, but had:

```text
Signature=adhoc
TeamIdentifier=not set
Identifier=codex-2836886ddd9c2fc9
```

A local build's valid on-disk signature and its own Designated Requirement do
not satisfy another component's explicit publisher requirement. Version output,
the filename “codex”, and an earlier successful startup cannot substitute for
that check. Inspect the actual current executable and process ancestry, not
only `which codex`, a symlink destination, an old PID, or a file newly downloaded.

For this installed broker, the explicit requirement was:

```text
anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"
```

An example for an already verified official installation is:

```sh
rtk proxy /usr/bin/codesign --verify --strict \
  -R '=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"' \
  /absolute/recovery/official-0.160.0/bin/codex
```

The leading `=` in the `-R` argument is intentional: it supplies requirement
text. The incident's omitted-equals probe returned
`invalid requirement specification`; retain that failed probe and the corrected
result separately. Do not interpret a malformed verification command as
evidence that the binary failed publisher verification.

This is an observed requirement for the installed broker, not authority to
hard-code every future publisher identity. Inspect the current installed
contract before choosing a future release.

### Official artifact used in this recovery

Source:
https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-aarch64-apple-darwin.tar.gz

| Item | Observed value |
|---|---|
| Archive size | 129976298 bytes |
| Archive SHA256 | 007df41b607dbbc8d204b9746ce7fed2d4ce6c813f44c32ceee54175ca796525 |
| Extracted executable size | 241555024 bytes |
| Extracted executable SHA256 | 112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b |
| Signing team / identifier | 2DC432GLL2 / codex |
| Explicit requirement result | exit 0 |
| Local build explicit requirement result | exit 3 |

The archive digest was checked against GitHub release metadata, and the
executable's signature was verified independently. Keep the complete package;
do not mix helper binaries from another release. Installation was isolated to
the task recovery directory and did not change other agents' global CLI route.

Replacing a file on disk does not change the signature of an already loaded
process. A controlled original-session resume was needed; the agent did not
kill itself, start a second copy of its session, or impersonate the old PID.

## 4. Why “stdout is not a terminal” survived a PTY

The user's actual command went through `rtk proxy /bin/bash <recovery-script>`.
A real PTY probe measured the child:

```text
stdin isatty:  true
stdout isatty: false
stderr isatty: false
```

Requesting a PTY outside a proxy does not guarantee that the proxy leaves all
three child descriptors attached to it. The proxy could print
`cmux-cua: codex attachment=attached` before interactive Codex checked stdout.

The repaired local launcher first rejects noninteractive stdin and an attempt
to resume from inside an active agent. When output descriptors are pipes, it
reconnects **only its own controlling terminal**, then verifies all three:

```bash
# Excerpt, not a complete session-recovery launcher.
# The full launcher also checks caller/session identity and backs up the journal.
if [[ ! -t 0 ]]; then
    printf '%s\n' 'Interactive input required; no session started.' >&2
    exit 2
fi
if [[ ! -t 1 || ! -t 2 ]]; then
    if ! { exec 3<>/dev/tty; } 2>/dev/null; then
        printf '%s\n' 'No controlling terminal; no session started.' >&2
        exit 2
    fi
    exec 1>&3 2>&3
    exec 3>&-
fi
if [[ ! -t 0 || ! -t 1 || ! -t 2 ]]; then
    printf '%s\n' 'Terminal verification failed; no session started.' >&2
    exit 2
fi
```

This does not allocate a replacement PTY, select another surface, submit input
to another agent, or relax caller authentication. It belongs in an interactive
operator launcher, not a way to start a duplicate conversation from a tool call.

The already implemented local launcher also has a `--check-terminal` mode
that exits after these checks without starting Codex. Controls established:

| Control | Result |
|---|---|
| Bash syntax | PASS |
| Original RTK command path in a PTY | fd 0/1/2 all TTY; no session launched |
| Already attached terminal | PASS without reconnecting output |
| Noninteractive stdin | Refused, exit 2 |
| Actual resume attempted inside an agent | Refused, exit 2 |
| Official binary strict signing requirement | PASS |

The diagnostic mode may test descriptors from a tool; the real resume mode
must still reject an active-agent invocation. Do not remove that distinction.

## 5. Resume the original conversation without replacing its context

Before an operator performs a required resume:

1. Save any unsent composer text separately; it is not guaranteed to be in the
   conversation journal. Do not clear or press keys in another agent's composer.
2. Pin the original session, workspace/surface identity and task directory.
   Verify the original live cmux socket and explicit integration-disable flags.
3. Reject a second process for the same session. Verify the exact journal's
   identity and that the old process has stopped writing.
4. Verify the official package SHA and explicit code-signing requirement.
5. Check free space for the journal backup and research reserve. Make a full
   backup with bytes and SHA; compare the source inode, size and modification
   time before and after copying. Refuse a changed source.
6. Use the installed cmux wrapper's supported `CMUX_CUSTOM_CODEX_PATH`
   mechanism. Let that wrapper construct the new PID/MCP binding. Do not hand
   fill a stale parent PID, reuse an old broker process, or alter trust policy.
7. Resume the **same session ID** in its original terminal. Verify its actual
   executable, process birth and session identity after startup.
8. Perform a real, user-authorized namespaced cmux-cua read before declaring
   desktop authentication fixed.

The recovery used `/Applications/cmux.app/Contents/Resources/bin/cmux-codex-wrapper`.
The user's global Codex command, other agents' binaries and historical callback
ownership were not changed. A new signed caller does not inherit ownership of
unsettled callbacks merely by reading the original conversation.

Once this succeeds, do not repeatedly ask the user to exit, restart or rerun
the launcher. Advance to the next unverified layer.

## 6. Permission ownership after authentication succeeds

cmux Computer Use's two grants belong to the helper **cmux Computer Use**
(`com.cmuxterm.cua`):

- Accessibility: inspect/drive application UI.
- Screen Recording: capture screenshots.

They do not belong to the main cmux app simply because its terminal launched
the agent. Apple Events Automation is another API and permission domain.
An empty Automation list is not a diagnosis of the broker's -67050 error.

After successful signed resume, the actual MCP response was:

```text
cmux Computer Use onboarding is still in progress. Finish setup in cmux, then retry.
```

At the user's explicit request, cmux → Settings → cmux Computer Use →
Finish Setup guided the user through the remaining grants. On macOS Tahoe,
Screen Recording can be followed by the system prompt that the helper
“is attempting to bypass the system private window picker”. The user allowed
that direct-capture consent in the system UI. Do not suppress or simulate it.

Follow the installed cmux-cua skill and cmux-owned lifecycle. Do not launch a
standalone helper, call a prompting permission tool beside the onboarding flow,
edit/reset TCC, disable SIP, re-sign the caller to impersonate OpenAI, or enable
an unverified-caller override. cmux can refresh its helper without restarting
all terminals or the research session.

Existing TCC database rows are historical evidence, not proof of current
helper identity, completed onboarding or successful capture. The incident
already had “allowed” rows before live setup completed. Require a real tool
read; a settings screenshot alone is not the final functional check.

Related skills' Apple Events -1743 guidance did not cover this caller-signature
error. In the incident, an exact skill named officecli-review was not found;
a Word-revision skill and a dissertation-writing skill had Apple Events advice.
Do not claim that reading those instructions fixed a different authentication
layer. Refer collaboration issues to their designated maintainer separately.

## 7. Restore only the original Workbench profile

After caller trust and actual desktop reading pass, inventory the original
profile and its real process arguments. For the observed task these were an
isolated user-data directory, its extensions directory, the existing task
workspace and loopback port 17525. Substitute paths only from the task's
persisted binding; do not invent a new profile to get a green status.

A read of a default Code window does not establish the research profile.
Two extension versions on disk do not identify the version loaded by the
current extension host. Recheck, and persist:

- Code process executable, birth time, exact user-data/extensions directories.
- Extension-host process and actually loaded extension version/source identity.
- Listener address/port and owner; HTTP status plus the returned owner identity.
- Stata backend PID, process birth, generation and ready/idle/recovery state.
- Matching client paths, generation pins and state-preservation plan.
- User's current visibility policy and the actual source/Terminal observation.

A dead old PID may have been reused by another process. Never act on a cached
PID alone. Confirm that the old instance really exited before launching the
authorized original profile. Preserve ordinary Code windows and unsaved buffers.

If the backend has disappeared, its transient memory is not continuous with a
new generation. Rebind the client to the new identity and restore only the
explicitly backed-up, authorized state. Do not replay a consumed one-use
restore/reload operation or certify unbacked Mata objects as preserved.

A free port does not show why Workbench exited. Keep that cause UNPROVEN until
logs or other actual evidence establish it. Desktop authentication failure
must not be used as an invented cause of the backend's disappearance.

## 8. Continue research from its verified completed prefix

Before the first productive POST, inspect existing request identities, native
logs and actual output acceptance. Do not rerun completed chapters because a
new agent, client or desktop process started. A failed HTTP response may coexist
with successful native computation and requires original-request reconciliation.

At this incident's cutoff, a four-stage chapter 4/5 chain had already produced
44 checked data outputs; a chapter 6/7 upstream stage had also completed a real
shared Workbench run. The remaining chapter 7 downstream stages had only been
prepared. Those are separate states; offline code review is not a Stata rerun.

Resume only the first unsubmitted dependent stage after new-generation checks.
Use isolated outputs, read actual DTA/CSV/log artifacts, and compare with the
historical chapter entry files. Keep upstream reproducibility, historical
agreement, explained corrections and unproven source relationships separate.

Correction (2026-10-18): the user's original instruction explicitly requires
at least 20 GB (20,000,000,000 bytes) of free space for this task. The earlier
correction incorrectly called that reserve an agent assumption. The controller's
23 GB (23,000,000,000 bytes) scientific-submission budget is a historical
implementation budget, not the user's stated reserve or a universal skill
installation threshold. The new plugin acceptance plan budgets the 20 GB reserve
plus 500 MB, totaling 20,500,000,000 bytes. Record each budget's source and
projected peak separately. Below 20 GB, actively back up eligible task files to
the authorized Baidu folder, verify them before authorized reclamation, and
continue independent work; do not halt the whole task. Uploading alone frees no
local space. This documentation correction does not change a live controller or
authorize deleting original data or evidence.
See [shared-session execution and delivery lessons](shared-session-delivery-lessons.md).

One backend remains serial. Frozen-file analysis can proceed in parallel when
the original executors are reachable. Desktop success does not repair native
collaboration authentication. Do not replay UNKNOWN task delivery, invent a
callback receipt, replace the designated Claude session, or let a collaboration
fault block already authorized independent work.

## 9. Mistakes that prolonged this incident

- Treating “cmux missing from Automation” as the explanation before classifying
  the exact -67050 error. This conflated caller trust with OS permission.
- Testing a launcher without the user's actual RTK descriptor topology.
  The user then hit the same avoidable interactive-start failure twice.
- Saying attachment would restore desktop tools before a real tool call passed.
- Treating a restart or absence of a particular backup at an earlier moment as
  evidence that the user had not followed instructions. Later real backup
  manifests prove both attempts; preserve that correction.
- Letting historical “please exit and rerun” instructions look current after
  successful recovery. Latest-state notes must explicitly supersede them.
- Confusing a malformed codesign probe with a failed binary verification.
- Leaving the trusted desktop, default Code window, original profile, backend
  listener and Stata execution statuses mixed together.

These are specific diagnostic and reporting errors. More prompt retries,
another profile, broader permissions or repeated research runs would not
resolve them. Record the next missing observation and advance one layer.

## 10. Required prevention checklist

Before suggesting a restart or new permission request:

- [ ] Read HANDOFF and the latest recovery state; reuse verified baselines.
- [ ] Classify the exact error: caller signature, terminal, onboarding,
      Apple Events, Accessibility, capture, profile, listener or Stata.
- [ ] Verify the running executable and explicit publisher requirement.
- [ ] Test the actual user-facing launcher route, including fd 0/1/2.
- [ ] Preserve original session/journal and pending delivery evidence.
- [ ] Ask only for an actually required human action that existing authority
      and automation cannot complete; do not ask again after it is done.
- [ ] Verify live desktop reading after setup, then original profile/backend.
- [ ] Create a fresh generation binding; do not recycle stale restore tokens.
- [ ] Report installed, loaded, desktop-tested and research-tested separately.
- [ ] Archive failures and add corrections instead of editing frozen receipts.
- [ ] Stop credential/authentication bypasses; continue independent authorized work.
- [ ] Return to the user's remaining research task as soon as its gates pass.

These checks reduce recurrence; they do not promise permanent macOS consent,
unchanging third-party behavior or immunity from later runtime failures.

## 11. Maintenance, validation and publication boundary

The launcher repair was tested locally as listed above. Desktop enumeration
and one default VS Code read were live-tested. Section 12 additionally records
the subsequent original-profile launch and one actual Stata display control.
Publishing these records does not install/reload an extension, change
collaboration transport, grant OS permission or rerun research.

Update the operating skill, runtime permission/troubleshooting guides and
their existing review branches together. Back up user-owned skill entries
before adding the guidance; do not mutate an immutable installed release or
replace older runtime pins. File installation is not proof an active Claude
has read or loaded the new guidance.

Keep private full evidence in the task's recovery archive with complete hashes.
Publish a technical account and safe examples here; never publish raw journal
backups, researcher paths, screenshots, licenses or research outputs. Reference
existing PRs and preserve their previous functional changes, test limits and
unresolved live-runtime acceptance. Do not silently merge an unrelated runtime
upgrade as part of documenting a recovery.

Further contracts:
- cmux's installed cmux-cua skill owns helper lifecycle and permission UI.
- The task's current Stata execution policy owns shared/visible execution.
- The collaboration skill owns executor identity, dispatch and native receipts.
- The current user instructions determine authorized recovery and remaining work.

## 12. Original-profile bootstrap actually passed (23:57 UTC)

This later observation supersedes only the earlier pending profile/backend
status. It does not erase the signature, terminal or onboarding failures, or
turn the control run into scientific acceptance.

| Observation | Actual result |
|---|---|
| Original profile launch | One launch with the persisted user-data/extensions directories and original workspace |
| Loaded extension | 0.1.3-rc.7.44-dev.1; actual host/listener and complete runtime disk identity checked |
| Extension activation | 2026-10-16T23:43:49.383Z |
| First bootstrap attempt | Missing old lock paths; BLOCKED_NO_POST, postCount=0 |
| Second bootstrap | One plugin POST, retryCount=0, HTTP 200, rc=0 |
| Code | A single display command with a fresh recovery marker; no research code |
| Request / run | codex_1792195018017_2cs5clow46d / run_mvbmn292_yql32crb |
| Completion | Native display output plus per-run completion marker; terminal settlement and ready state passed |
| Research posts in recovery | 0 |
| Memory continuity | New backend generation; no claim of old transient memory preservation |
| Physical window visibility | Not measured: two running Code instances made bundle-name UI addressing ambiguous |

### Lazy backend initialization is not a new authentication failure

The original extension host and shared Terminal were ready before an owned
backend process existed. The backend is initialized lazily by the first actual
Stata request. A precondition requiring an already-existing backend would
deadlock recovery at this point; do not loop on it or invent a connect endpoint.

Instead, after confirming the exact unused original host/profile, zero owned
backends, idle request state, complete runtime manifest and ready Terminal,
persist a one-request intent and submit a harmless display through the installed
plugin's supported run-command route. Allow only that expected zero-to-one
backend transition. Then verify the new process's executable, parent, birth,
owner and generation against the unchanged launcher/host/extension activation.
Do not adopt an unrelated backend or silently accept a second one.

The original-profile bootstrap used GET /status and POST /run-command.
Routes and behavior must come from the actual installed source. In this
version, /connect and /session-state were not supported routes. editor-focus
only focuses an already displayed, uniquely matched file; it does not open a
missing editor. A guessed endpoint or successful launcher exit proves nothing.

### Missing old lock files: observe, then bind a new generation

The preserved client pinned two lock paths to old device/inode pairs. Both
paths were absent after recovery, so the first attempt refused before any POST.
The reason for their disappearance remains UNPROVEN. Do not attribute it to
a reboot, cleanup program or filesystem change without supporting evidence.

An absent path alone is insufficient: a process can still hold an unlinked
inode. Before creating replacement paths, inspect deleted-open files with
lsof +L1, original runner processes, in-flight bridge requests and the original
host's idle/unused state. Refuse uncertain or active owners; retain their
original receipt and do not reset the retry budget.

In this bounded recovery, the checks found no deleted-open matching lock,
no old Stata runner and no active request. The controller saved an intent,
then used O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW|O_CLOEXEC and mode 0600 at each
original path. It held both nonblocking exclusive flocks through bootstrap,
checked regular-file/owner identity and matching fstat/stat device/inode,
then persisted a separate LOCK-GENERATION record. No old lock was unlinked
or overwritten; no historical inode or receipt was edited.

If creation of either path fails, stop before submission. Keep any created
path and its evidence; re-observe ownership rather than delete it for a retry.
A zero-submission refusal and an uncertain submitted request are different
states. Only the former permits a new, independently documented attempt
after correcting its precondition.

### Client rebinding must preserve execution and source checks

Persist the successful generation and lock-generation bytes with full SHA256.
A task-local client may bind its observations and lock identities to these new
records while reusing the already reviewed executor. It must keep:

- Full extension/backend disk manifest and loaded bundle/guard identity checks.
- Launcher, host and backend PID, parent, birth, executable and command checks.
- Exact activation, owner, reset generation and ready/idle checks.
- Shared Terminal panel/script/style readiness and no initialization error.
- A nonblocking exclusive lock throughout each scientific transaction.
- Complete source closure, before/after hashes and submitted-code binding.
- One POST intent, original request/run evidence, native output and restoration
  checks; no retry of UNKNOWN or failed requests with uncertain settlement.

Do not remove identity checks merely because they refer to the old process.
Replace only the stale binding in a new file; preserve the original client.
A top-level exit in submitted code can skip the plugin-appended RUN_DONE line.
Keep the reviewed wrapper that captures the DO return code and prints it,
letting the appended marker execute. Report plugin rc, wrapper rc, business rc
and restoration rc separately; plugin rc=0 cannot turn a failed DO into PASS.

### Two Code processes and two independent authentication domains

The normal Code process and the original research profile both remained open.
A bundle-name desktop error about ambiguity is different from -67050 or
onboarding. Do not close unrelated windows or discard their unsaved buffers.
Use an unambiguous supported UI target when available; never claim an observed
screenshot belongs to the original profile merely because it says Code.

For this task the user explicitly allowed covering/hiding. Original-profile
identity and shared Terminal readiness were checked; physical unobscured
visibility remained NOT_MEASURED. That narrower claim does not certify an
unseen editor or authorize arbitrary UI actions.

Separately, cmux-agent self still reported native_caller_verified=false.
Desktop Computer Use success does not establish authenticated collaboration
control. Preserve designated executor sessions and pending attempts, report
maintenance through the authorized channel when it becomes available, and
continue already-authorized solo work from the verified scientific baseline.

### Resume the remaining stages, without repeating the control

The one display run established the new original backend and runtime
settlement. It did not run chapter data, retest all graph/DOCX behavior, restore
unbacked state, settle Claude callbacks or establish historical data agreement.
Do not rerun that successful display on every handoff. Refresh current identity
and readiness, then execute the first genuinely unsubmitted scientific stage.
Keep documentation publication, loaded runtime, control acceptance and
scientific acceptance as separate records.
