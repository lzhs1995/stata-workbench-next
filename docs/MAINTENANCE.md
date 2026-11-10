# Maintenance Workflow

This project has two local roles. The paths below are generic examples; choose
your own project roots:

- `C:\work\stata-development` is the live Stata Workbench development and pressure-test workspace.
- `C:\work\stata-workbench-shared-session` is the public source, packaging, release, and Open VSX repository.

The normal flow is simple: develop and verify runtime patches in the live workspace, then export stable runtime scripts to this repository before packaging a release.

## Daily Development

Keep using the live workspace for runtime work:

- patching the installed Workbench bundle
- testing the visible Stata Terminal bridge
- testing `Stata Graphs`
- debugging queue, status, reset, log, and graph lifecycle behavior
- running large taught-task or real research pressure tests

Do not package or publish directly from the live workspace. It contains private research files, temp outputs, logs, and local-only operational documents.

## Public Repository Work

Use this repository for public-facing work:

- README and docs
- examples intended for the community
- package metadata and version bumps
- VSIX packaging
- GitHub Releases
- Open VSX publication

Docs, examples, and package metadata are repo-first. Runtime patch scripts are workspace-first, then exported into the repo.

## Export Runtime Scripts

Use `scripts/export_to_repo.ps1` from this repository. Set the source root
explicitly so the example does not depend on the script's historical default:

```powershell
$workspaceRoot = "C:\work\stata-development"  # Replace with your project root
```

Preview only:

```powershell
.\scripts\export_to_repo.ps1 -WorkspaceRoot $workspaceRoot
```

or explicitly:

```powershell
.\scripts\export_to_repo.ps1 -WorkspaceRoot $workspaceRoot -Preview
```

Apply the whitelist copy:

```powershell
.\scripts\export_to_repo.ps1 -WorkspaceRoot $workspaceRoot -Apply
```

The preview prints SHA256 hashes for the workspace source and repository target, with a status of `same`, `changed`, `missing-in-repo`, or `missing-source`.

The script only copies whitelisted runtime scripts. It does not copy data, logs, `7_temp`, `AGENTS.md`, `MEMORY.md`, taught-task source files, or the extension bundle.

## Whitelisted Runtime Scripts

The export whitelist is intentionally narrow:

- `cleanup_mcp_stata_processes.ps1`
- `invoke_stata_segmented_visible.ps1`
- `invoke_stata_visible.ps1`
- `invoke_stata_visible_safe.ps1`
- `open_stata_vscode_fast.cmd`
- `open_stata_vscode_fast.ps1`
- `open_stata_vscode_hosted.ps1`
- `panic_kill_stata_chain.ps1`
- `patch_manager.js`
- `stata_patch.ps1`
- `unblock_stata_terminal.ps1`
- `verify_stata_execution.ps1`
- `write_stata_run_ledger.ps1`

If a file is not on this list, do not export it by default. Add it to the whitelist only after deciding it is public runtime tooling.

## Extension Bundle Check

The extension bundle is a special case and is not copied by the export script.

Before release, compare:

- workspace bundle: `<workspaceRoot>\extension.patched-baseline.js`
- repo bundle: `dist\extension.js`

Run these checks:

```powershell
$workspaceRoot = "C:\work\stata-development"  # Replace with your project root
$workspaceBundle = Join-Path $workspaceRoot "extension.patched-baseline.js"

Get-FileHash -Algorithm SHA256 $workspaceBundle, ".\dist\extension.js"

Get-Item $workspaceBundle, ".\dist\extension.js" |
  Select-Object FullName, Length, LastWriteTime
```

Then run patch verification in the live workspace:

```powershell
$workspaceRoot = "C:\work\stata-development"  # Replace with your project root
& (Join-Path $workspaceRoot "stata_patch.ps1") verify
```

Compare marker count and critical markers before release. Critical marker groups include:

- visible bridge
- display-only clear
- single-flight status
- force reset / cleanup
- graph panel and graph clear
- inline snapshot routing
- post-run readiness
- audit/logPath resolution
- terminal-input memory preservation

If the bundle hashes differ but marker count and critical markers match, continue only after runtime smoke tests pass. If marker count drops or a critical marker is missing, stop and fix bundle synchronization before publishing.

## Release Checklist

1. Finish live patch testing in the workspace.
2. Run `stata_patch.ps1 verify` and record marker count / critical marker summary.
3. Run `scripts/export_to_repo.ps1 -WorkspaceRoot $workspaceRoot -Preview` and inspect hash differences.
4. Run `scripts/export_to_repo.ps1 -WorkspaceRoot $workspaceRoot -Apply` if only whitelisted runtime scripts should change.
5. Check the extension bundle separately.
6. Update `CHANGELOG.md` with patch provenance, marker summary, smoke tests, and VSIX hash.
7. Bump `package.json` and `package-lock.json` when publishing a new package.
8. Run `npm run check`.
9. Run `npm run package`.
10. Run `npx vsce ls --tree`.
11. Scan the VSIX for private paths, tokens, license files, data, logs, and generated outputs.
12. Install the VSIX into a clean VS Code profile.
13. Run a visible minimal smoke test.
14. Run a graph smoke test.
15. Install or test the release in the live workspace.
16. Commit and push.
17. Create the GitHub Release.
18. Publish to Open VSX.

## Changelog Provenance

Do not maintain a separate patch-state file. For each release, put provenance in `CHANGELOG.md`:

- workspace bundle hash
- repo bundle hash
- marker summary from `stata_patch.ps1 verify`
- exported script summary
- smoke-test evidence
- VSIX SHA256