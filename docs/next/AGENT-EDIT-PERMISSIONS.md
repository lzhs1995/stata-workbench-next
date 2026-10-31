# Agent `.do` edit permissions

The Next line requires an explicit diff decision before an agent can change a
Stata source file. The bridge endpoint is `POST /propose-edit`; it verifies the
current SHA-256, opens a VS Code diff, waits for **Accept** or **Reject**, and
writes a timestamped pre-edit snapshot only after acceptance. A changed file,
rejection, timeout, invalid extension, or SHA mismatch never writes the file.

## Claude Code

Put this project-level `.claude/settings.json` in the Next worktree (or merge
the equivalent rules into an existing project settings file):

```json
{
  "permissions": {
    "deny": [
      "Edit(**/*.do)",
      "Edit(**/*.ado)",
      "Edit(**/*.mata)",
      "Write(**/*.do)",
      "Write(**/*.ado)",
      "Write(**/*.mata)"
    ]
  }
}
```

This is an agent-host guard. It does not replace the bridge SHA check and
acceptance gate; both layers are required.

## Codex

The installed Codex 0.164.0 configuration was inspected for a per-glob
`Edit`/`Write` deny rule. No equivalent project setting was found. Therefore
this repository does not claim that Codex has a native `.do` deny rule.

Codex must use the bridge proposal flow for `.do`, `.ado`, and `.mata` changes.
The extension-side gate is authoritative: direct agent writes are detected by
the pre-write SHA comparison when a proposal is accepted, and unapproved edits
remain outside the supported workflow. A future Codex permission API can be
added only after a local versioned test proves its behavior.

## Verification

The unit tests cover SHA mismatch, rejection, timeout, acceptance with
snapshot, concurrent human modification, and append-only event records:

```text
npm run test:edit-gate
```

The Claude deny file must be tested in a fresh worktree with a harmless `.do`
fixture. That host-level test is separate from the bridge unit tests.
