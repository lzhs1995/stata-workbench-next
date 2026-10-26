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
