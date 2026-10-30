> Historical document: current public release instructions and scope are in [QUICKSTART](QUICKSTART.md), [ACCEPTANCE](ACCEPTANCE.md) and [RELEASE](RELEASE.md). Older platform/version claims below do not certify the current version.

# Dependencies and Packaging Boundary

## Tested Target

This project is tested for the following environment:

- Windows 10/11.
- VS Code or an Open VSX-compatible editor.
- Licensed Stata 18 MP installed locally.
- PowerShell 5.1+ or PowerShell 7.
- Python/uv for the upstream `mcp-stata` runtime used by Stata Workbench.

Other environments are not rejected by the package, but they are not the supported baseline yet. If you use Stata 17, Stata SE/BE, macOS, Linux, VSCodium, Cursor, or Windsurf, please report your exact setup when opening issues.

## What Is Included

The VSIX includes:

- The patched extension runtime under `dist/`.
- Helper scripts under `scripts/` for local setup, visible execution, recovery, and verification.
- Public documentation under `docs/`.
- Minimal smoke-test workspace under `examples/minimal-workspace/`.
- Nine public taught-task do-files under `examples/taught-tasks/`.
- Extension icon and repository metadata.

## What Is Not Included

The VSIX and repository intentionally exclude:

- Stata itself.
- Stata license files such as `STATA.LIC`.
- Private `.dta`, `.csv`, `.xlsx`, `.docx`, `.pdf`, logs, SMCL files, graph outputs, and run evidence.
- Local `7_temp` outputs.
- Marketplace/Open VSX tokens, Azure DevOps PATs, and other credentials.
- User-specific Stata installation paths.

## Runtime Dependencies

Users must provide their own local Stata installation and configure `stataMcp.stataPath` in VS Code settings.

For the tested local setup, the Stata version is Stata 18 MP. The extension is designed around long-running research workflows and the local shared-session bridge, so Stata 18 MP is the recommended baseline for issue reproduction.

## Development Dependencies

Developers need Node.js and npm to install dev dependencies and create VSIX packages:

```powershell
npm install
npm run check
npm run package
```

The package uses `@vscode/vsce` for packaging. Do not vendor `node_modules` into the repository or release artifacts.

## Example Output Locations

The taught-task examples write outputs relative to the current Stata working directory:

- `7_temp/` for temporary graphs and intermediate outputs.
- `4_tables/` for document/table examples.

For a portable run, open `examples/taught-tasks/` as a workspace or set:

```json
{
  "stataMcp.runFileWorkingDirectory": "${fileDir}"
}
```

A ready-to-copy example is provided at `examples/taught-tasks/.vscode/settings.example.json`.

The packaging tool pins `@azure/identity` 4.13.0 through an npm override. Newer
4.13.1–4.14.0 releases select MSAL Node 5/6 affected by GHSA-xcx6-jx8p-x3h5;
4.13.0 retains the compatible MSAL 3 line. This is a development/packaging
dependency, not a claim about embedded runtime libraries. Recheck before removing
the pin; no Azure credentials or publishing are exercised by CI.
The legacy MSAL dependency also pins `uuid` 11.1.1 (the CommonJS-compatible fixed
line) for GHSA-w5hq-g745-h8pq. These explicit overrides are checked by package
loading, VSIX creation and npm audit; live Azure publishing remains untested.
