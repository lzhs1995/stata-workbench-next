# Acceptance Scope

`release/acceptance-summary.json` is a sanitized projection of retained local
evidence, with the original record SHA256. It is not a public replay dataset.
Private research paths and logs are omitted. Readers can verify package/runtime
hashes and run offline tests, but cannot replay private logs from a summary alone.

- Runtime 0.1.3-rc.7.39 on one licensed local Mac environment.
- FULL45 45/45 scenarios, 632/632 steps: 575 assertions and 57 observations.
- One full invocation, zero automatic full-run retries. 110 lease-creating steps
  produced 111 receipts because S29 step21 had one bounded zero-ACK product retry.
- Six native runs retained evidence; S41 closed its own log, so retained source
  and completion proof are not a full transcript.
- Original replay failed; separate replay-contract correction passed 795 manifest
  members and 44 negative controls. Failed evidence was preserved.
- Human Run File handler -> AI client -> Human Run File handler used the same
  backend. Automated handler invocation is not a claim of human keypresses.
- Final isolation 17/17, zero leases, eight protected originals unchanged.

## Public Packaging

The private accepted VSIX contained a local maintenance token in a helper and
document; it is not uploaded. The public VSIX removes the token and updates docs
and tools. Executable extension runtime/JS helpers/UI are checked against the
accepted package. New portable tools have separate tests, not inherited FULL45.

The extension version remains 0.1.3-rc.7.39 because its runtime is unchanged;
the immutable GitHub tag adds `-public.1` to distinguish packaging. Future runtime
changes must increment the extension version. Never replace a published asset.
This is not Windows/Linux or universal Stata/editor certification.

## Recursive DO candidate

The 0.1.3-rc.7.44-dev.1 candidate changes the runtime source-compatibility and
Darwin helpers and adds a shared static DO-reference scanner. Its maintained
extension bundle is unchanged, but its helper set is a new runtime identity.
`release/runtime-manifest.json` pins the candidate. The prior manifest is retained
byte-for-byte in `release/history/runtime-manifest-0.1.3-rc.7.39.json`; the
historical acceptance summary remains evidence for that earlier runtime only.

Offline request replay reached 24 raster exports missed in nested DO files.
A saved research GPH and 23 remaining graph pairs were exported through
preconverted SVG in the existing Workbench. All 24 PNGs decoded and were
visually inspected; the 23-pair run's state-restoration assertions passed.
This is a limited recovery-route test, not installation or full live acceptance
of the candidate.
The existing fixed-instance client still targets its documented accepted runtime;
this change does not silently retarget or restart it. Candidate installation and
licensed Mac full acceptance remain pending. Do not publish a release/tag or
claim that all macOS native graph initialization failures are eliminated.


## Saved-graph preview candidate

Version `0.1.3-rc.7.44-dev.2` adds an explicit Terminal image-artifact click route to
Stata Graphs, with independent preview identifiers and no Stata execution. Help,
non-image artifacts and missing files retain their existing handlers. Automatic
batch delivery still does not create or reveal a new graph panel.
An explicit image click replaces the displayed batch with a single-image preview;
it does not remove exported files or rewrite the original run's artifacts.

The new behavioral regression extracts the production message branch and graph
functions, and stubs VS Code panel creation. It verifies routing and preserves the
automatic-batch regression; it does not establish native panel rendering. Prior
PNG/GPH evidence belongs to the earlier private runtime. Final loaded-runtime,
native UI and full licensed acceptance remain pending; no public release or
research-instance upgrade is established by these source changes.

## Cross-platform candidates, 2026-10-27

The later candidates have bounded native evidence; the earlier FULL45 result is
not inherited as a new full-suite certification. The public projection is
[cross-platform-acceptance-20261027.json](../release/cross-platform-acceptance-20261027.json).

- dev.3 on a licensed private Mac: actual Run File generated 6-row/4-variable
  CSV/DTA, native GPH save/reload, and two fully decoded equal 800×480 PNGs through
  SVG+sips. Data Browser displayed 6×4. Run File → installed Python client → Run
  Selection shared scalar state 40 → 42. Two clients dispatched once each in
  order. Soft Stop drained the original task and transport and restored the
  declared state on the same backend; its original HTTP 500 remains recorded.
  Cleanup verified the empty original frame and removed only private objects.
- dev.3 graph **Open** incorrectly used the default file viewer: the test had
  flattened sibling module scopes. dev.4 explicitly exported the callback.
  Subsequent native reload testing found a detached artifact DOM container;
  exported files and render counters existed while no thumbnail was visible.
  dev.5 preserves that container through clear/restore. Both failures remain.
- dev.5 reused the saved GPH and passed the real Terminal thumbnail → modal
  **Open** → Stata Graphs route after reload. The image loaded visibly and all
  ten route/identity/no-execution checks passed. The source and execution copies
  are archived separately. dev.5 did not rerun the dev.3 full shared-state suite.
- dev.5 source/package checks: 193 JS commands, 52 Python tests (3 Windows-only
  skips on Mac), 90 runtime identity checks, and successful Mac ARM, Mac Intel
  and Windows Server CI. Package resources and actual installed/loaded runtime
  identity were checked separately. These counts are different test units.

Limits: author source was observed beside Terminal while a request was active;
the compatibility-transformed executed bytes were separately archived, so exact
displayed/executed equality is not certified. The dev.4 saved-graph observation
was after completion with older source on the left; it is not a live visibility
pass. New files can follow the focused Terminal group until arranged explicitly.
`graph use` alone is not currently recognized as a graph-producing command by
the artifact scanner. A top-level Code window count is not code/Terminal proof.

Windows 11 x64 licensed execution and desktop checks (runbook steps 1–10,
including lock/unlock and a cancelled UAC prompt) were run on 2026-10-28/29;
see [SYNC](../SYNC.md) and the [README platform status](../README.md#platform-status).
New FULL45 coverage, native Mac bitmap recovery, Windows 10, Windows on ARM and
source-built feature parity remain pending. The research instance and
scientific acceptance are unchanged.
