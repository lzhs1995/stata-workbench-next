# Agent entry point — Stata Workbench Next

These plain Markdown instructions apply to agents with shell access. They do
not prove that a particular agent product has discovered or tested this route.

## Choose the matching operating guide

Read this repository's [README](README.md) ([简体中文](README.zh-CN.md),
[繁體中文](README.zh-TW.md)), especially installation, quick start, platform
results and known limitations. Use this repository's `tools/` at the commit or
tag matching the installed Next VSIX; the tools reject a different bundle.

The [stable operating skill](https://github.com/lzhs1995/stata-workbench-shared-session-skill)
targets the stable runtime and its own compatibility record. It is **not a
Next-compatible operating skill**. Until a Next-specific skill exists, use the
Next README and tools; do not mix the stable rc.7.45 client or receipt checker
with Next. Next is a separate preview, not a replacement for a research session.

## Select and observe a Next session

Run commands from this repository's root. On Windows use the installed
`python.exe` as `python`, not the Microsoft Store alias.

```sh
python3 -B tools/stata_session.py list
python3 -B tools/shared_stata.py --list-sessions
python3 -B tools/verified_workbench.py --status --session s1
```

Use the person's intended session. `--session` accepts its name or id, or set
`STATA_WORKBENCH_SESSION`. It is required when several sessions are live;
`MULTIPLE_SESSIONS` dispatches nothing. Prefer explicit selection even with one.
The private registry under `~/.stata-workbench-next/sessions/` supplies the
authentication token. Let the matching tools read it; do not copy it into source
files, receipts intended for publication, or command examples. The client checks
registry, authenticated status and installed bundle identity before dispatch.
An identity mismatch is a refusal, not permission to bypass the check.

For a separately authorized new Next session, the launcher is:

```sh
python3 -B tools/stata_session.py open s1 --workspace /absolute/path/to/project
```

`LAUNCHED` alone does not mean the bridge or Stata worker is ready. Observe the
selected session's status and follow the README's startup/warm-up guidance.
Do not open a replacement session to evade a busy, locked or uncertain run.

## Execute once and reconcile the receipt

One backend runs one request at a time; people and agents take turns. A saved
file can be submitted as follows (choose an existing working directory and a
new receipt directory):

```sh
python3 -B tools/shared_stata.py --session s1 --agent-name codex \
  --file /absolute/path/to/project/stage01.do --cwd /absolute/path/to/project \
  --receipt-dir /absolute/path/to/receipts/stage01
```

The client sends one POST and never retries it. Exit 0 with
`PASS_VISIBLE_SHARED_RUN` certifies the checked execution; it does not certify
scientific correctness or that somebody watched. Read the receipt, raw output
and actual deliverables before continuing a dependent stage. Do not commit
`.stata-receipts/`, private registry files, research data, logs or credentials.

- `EXECUTION_UNCONFIRMED_NO_RETRY`: inspect the original request's receipt and
  events; a timeout is not proof that nothing ran. Never blindly resend it.
- `STATA_ERROR_CONFIRMED`: inspect `stataRc` and error text. Earlier commands
  may already have changed data; reconcile those effects before correcting code.
- `STOPPED_NO_RETRY`: honor the person's Stop. Do not restart automatically;
  verify the same run's restoration and readiness before further authorized work.
- `REFUSED_NOT_DISPATCHED`: inspect `reasonCode`, `retryable` and `retryAfterMs`.
  Only a documented retryable pre-dispatch refusal permits a later submission;
  refusal after Stop is not retryable.

Read events without executing Stata:

```sh
python3 -B tools/shared_stata.py --session s1 --events 0
```

Stop, KILL and recovery have different effects. KILL can lose in-memory data and
requires the person's informed confirmation; follow the README's platform
limitations. Preserve unsaved editor buffers and accepted outputs.

## Propose Stata source edits for acceptance

Changes to `.do`, `.ado` and `.mata` go through authenticated `POST /propose-edit`,
with path, new content, current file SHA-256 and reason. The extension opens a
diff and writes only after the person selects **Accept** and the source still
matches. Rejection, timeout, SHA mismatch or a change during review writes
nothing. Preserve the person's edits; submit a fresh proposal for a changed
source instead of overwriting it. Do not invent a `--propose-edit` CLI flag or
use direct file writes to bypass this flow. See
[agent edit permissions](docs/next/AGENT-EDIT-PERMISSIONS.md) for the endpoint
contract and the separately bounded host permission controls.

## Change this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [Development](README.md#development).
Use synthetic fixtures, preserve [upstream attribution](NOTICE), and keep
runtime, package version and manifests unchanged for a documentation-only task.
For documentation changes, inspect all translations, code examples, local links
and heading anchors, then run appropriate targeted existing checks:

```sh
git diff --check
python3 -B -m unittest discover -s tools -p 'test_public_release.py'
python3 -B tools/verify_release.py
```

Runtime changes require the full documented offline checks and separately
scoped live acceptance. Do not run mutating `check:legacy` against a sealed
candidate. Packaging, installation and live tests are separate actions, not
implicit parts of reading or updating these instructions.

## Tested and unverified limits

- [Platform results](README.md#platform-test-results) bind checks to actual
  build IDs, dates and routes. macOS Apple Silicon and Windows 11 have the
  listed synthetic live evidence; offline CI is not licensed live acceptance.
- The launcher has a five-session code limit, and historical macOS rows include
  five-session checks. The 2026-11-10 takeover's live acceptance is limited to
  **two simultaneous Stata sessions**; this documentation assignment runs none.
- A shell client working does not prove each agent product can discover an
  installed skill, load it or execute successfully. Per-product live acceptance
  and a Next-specific operating skill are not established here.
- Windows 10, Windows on ARM and Linux remain unverified. Preserve the README's
  narrower Stop, KILL, warm-up, process-cleanup and high-load limitations.
