# Release Maintenance

This is a patched upstream distribution. `dist/extension.js` is a versioned
maintenance input, not reproducibly generated from a complete unbundled
TypeScript tree. Readable local patches, helpers and UI sources are included.
Do not claim a clean upstream rebuild is byte-identical. Restoring that build
pipeline is future work, not a completed gate.

The existing maintained-baseline patch replay is still checked byte for byte.
Bundle edits must update that patch chain; it is separate from a complete
upstream TypeScript rebuild. Never weaken its equality tests to accept drift.

1. Make scoped commits, preserving upstream attribution and Git history.
2. Run `npm ci --ignore-scripts`, `npm run check`, Python tests and secret scan.
3. Runtime edits need a package/lock version bump, fresh identities, targeted
   regressions and licensed Mac full acceptance.
4. `npm run package` packages maintained input without rewriting the bundle.
5. Publish an immutable tag, VSIX, SHA256SUMS and scope notes; download again and
   verify with `python3 tools/verify_release.py --vsix <file>`.

`check:legacy` retains the old mutating development pipeline. Never run it
against a sealed candidate. CI runs read-only tests without Stata, GUI or private
credentials. Untrusted pull requests never use licensed/self-hosted environments.

The old private VSIX is not public because it contained a local helper token.
The public revision has a separate tag/hash. npm audit covers the developer
lockfile, not all embedded upstream libraries; zero production npm dependencies
is not a complete runtime security audit.
