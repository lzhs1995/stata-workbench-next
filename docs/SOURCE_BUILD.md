# Reference source build and migration

`npm run build:reference` verifies and builds the 27 upstream files pinned in
`upstream/SOURCE-MANIFEST.json`. It compiles the extension host and both webview
entry points twice, compares all output hashes, checks that the maintained
`dist/` tree stayed unchanged, and writes only under `out/reference-source/`.
Install the locked dependencies with `npm ci --ignore-scripts` first. Run this
locally or in GitHub Actions; never build on a VPS.

The upstream revision is
`tmonk/stata-workbench@d36f7be03711fe47eb5c7cecc0048f0fa49ab825` (1.1.1).
Its original source, build description and AGPL license are retained without
editing. The reference build uses the root npm lockfile, Node 22, and esbuild;
it does not execute upstream lifecycle scripts or the upstream Sentry uploader.
It makes no upload or release calls. Upstream runtime telemetry and remote icon
references still exist in this reference source; the output is not installed or
packaged as the maintained extension.

The output manifest records source hashes, tool versions, dependency-lock and
builder hashes, repeated-build equality and every output hash. This proves a
build of the pinned reference. It does not prove correspondence with the local
maintained bundle or preservation of the local execution/graph fixes.

The dependency lock is checked out byte-for-byte on every platform. The first
stage-1 Windows build produced the same 15 reference and 17 migration outputs
as both Mac runners, but Git's CRLF conversion changed the raw lockfile hash.
The checkout rule now preserves that input identity too; do not discard or
normalize a mismatching hash in a saved build manifest.

Migration proceeds in bounded steps:

1. Map the maintained bridge, execution guard, finalizers, state patches and
   manual graph-preview behavior to their source components. Keep the existing
   byte-equality patch-replay checks and failure fixtures.
2. Move one behavior at a time into readable source, requiring its existing
   behavioral regression to pass against the source-built output. Document any
   intentional difference instead of forcing a byte match to an unrelated
   upstream build.
3. Run the shared OS matrix and package-resource checks on the migrated tree.
   Bind source revision, dependency lock, build outputs and final VSIX together.
4. Repeat licensed Mac and Windows desktop acceptance before changing the
   package entry point or the working research installation.

Until those steps pass, `dist/extension.js` remains the maintained runtime.

## Stage 1: Terminal preview and restoration

`npm run test:source-migration` builds a separate candidate from the pinned
upstream source plus readable source changes, tests its compiled Terminal,
execution lifecycle and localhost bridge boundary, and runs the maintained
bundle's existing preview/replay regression. Outputs stay
under `out/migrated-source/`; they are excluded from the VSIX. The maintained
runtime version, entry point and installed research profile remain unchanged.

The first migrated module is
[`src/shared-session/manual-graph-preview.js`](../src/shared-session/manual-graph-preview.js).
It uses explicit callbacks for resolving an existing image and delivering a
preview. Its per-instance sequence creates independent preview IDs; it makes no
Stata call. The Terminal receives that callback through its handler factory, so
normal display and serializer restoration both keep the route across module
boundaries. Help, non-image and missing-file handling retain their original path.

[`src/migrations/terminal-preview.js`](../src/migrations/terminal-preview.js)
applies the corresponding source edits before esbuild. Each edit requires the
expected original source anchor and count. It preserves the artifact container
when clearing/restoring Terminal and adapts the upstream Graphs image URI/resource
roots for the explicit preview. It does not consume or edit the maintained
bundle, alter the 27 upstream originals, or recover missing lifecycle behavior.

The builder compares two complete migration builds, verifies upstream/source
hashes and checks that maintained `dist` stayed unchanged. Its manifest records
the source changes, builder, lockfile and 17 outputs, including a test-only
compiled Terminal and an unmodified-upstream control. The behavior report runs
the actual compiled Terminal message handler and its emitted HTML. It covers
SVG/PNG paths with Unicode/apostrophes, help and ordinary-file fallback, missing
files, independent IDs, serializer callback rebinding, and two clear/restore
cycles with a connected artifact element. The original upstream control must
reproduce ordinary-editor fallback and the detached element. These are offline
host/DOM tests; the source-built Graphs window has not had native UI acceptance.

## Maintained behavior to source map

This is a migration inventory, not a claim that every row has been ported.
The original byte-equality replay checks remain in `npm run check`.

| Maintained component | Source destination / upstream location | Current state |
| --- | --- | --- |
| `apply_manual_graph_preview_patch.js`: explicit image click and container retention | `src/shared-session/manual-graph-preview.js`; source edits to `src/terminal-panel.js` and `src/extension.js` | Stage 1 compiled Terminal regression; native source-built Graphs still pending |
| `apply_rc7_shared_execution_patch.js`, `execution_guard.js`, `execution_lifecycle_core.js` | `src/shared-session/execution-lifecycle.js` and `src/shared-session/bridge-http.js`, wired to source `extension.js` selection and `.do`-file paths | Stage 3 source boundary exposes localhost `/status` and `/run-command` with run ownership and terminal release; checkpoint/finalizer/output parity remains pending |
| `runfile_finalizer_core.js` and the finalizer return reader in `execution_lifecycle_core.js` | `src/shared-session/runfile-finalizer.js`; source edit to the upstream `runFile` call in `extension.js` | Stage 4: `.do` runs call a temporary product driver; one integer return record before one exact marker settles rc in both directions, and a missing or malformed record leaves completion unverified. No pre-run snapshot is saved yet |
| `data_browser_execution_gate.js`, `stop_checkpoint_core.js`, pre-run snapshot and continuity cleanup | Upstream data-browser dispatch and lifecycle integration | Not migrated; preserve cleanup, checkpoint ownership and cancellation semantics before adoption |
| `bridge_rebind_core.js` and request/prerun bridge patches | Upstream MCP status/transport callbacks plus shared-session bridge | Not migrated; original request identity and unknown outcomes require behavioral parity |
| `apply_terminal_memory_patch.js` and maintained Terminal history/log helpers | Upstream Terminal streaming log/history and webview restoration | Only artifact-container fix migrated; output bounds/history/log fairness remain pending |
| `stata_source_compat_core.js`, Darwin PNG/DOCX adapters, recursive DO scanner | Upstream source preparation with explicit platform adapters | Existing readable helpers retained; source-built execution integration remains pending |
| `mcp_stata_runtime_patch.js` and `stata_*_patch.js` backend state repairs | Runtime installer/MCP bootstrap, with versioned external Python patches | Not replaced by an upstream JS build; installation and state-regression gates still required |
| Windows MCP command probing | `src/shared-session/platform-process.js`; source edit to upstream `mcp-client.js` | Source migration now keeps real `uv/uvx(.exe)` probes shell-free and permits a shell only for an explicit `.cmd`/`.bat` shim; the maintained bundle and live Windows acceptance remain unchanged |
| Python shared client, native adapters and PowerShell wrappers | Existing `tools/` and `scripts/invoke_stata_visible*.ps1` | Already readable/shared across platforms; no source-entry migration is needed for these files |

## Stage 4: Run-file finalizer

`tests/source/test-runfile-finalizer.js` ports the maintained rc.7.40 cases to
the source module and checks each one against the maintained log reader:
author `exit` stays inside the body file, the record wins over a stale inner
`r(601)` or a transport `rc=0`, and echoed, duplicate, misordered, malformed or
foreign records are rejected. Only the last 256 KiB of the log are read. One
intentional difference: the source settlement marks completion unverified
when the driver ran but no record is found, instead of keeping a transport
flag. The driver writes no dataset snapshot until the stop-checkpoint and
pre-run snapshot owners move to source. These are offline tests; no Stata
interpreter is mocked.

The next source step is stop checkpoint/pre-run snapshot ownership and Terminal output behavior.
Complete package identity,
Mac FULL45 and Windows licensed desktop acceptance are required before changing
the running entry point. Stage 3 is useful migration progress, not full feature
parity or a release candidate to install.
