> Historical document: current public release instructions and scope are in [QUICKSTART](QUICKSTART.md), [ACCEPTANCE](ACCEPTANCE.md) and [RELEASE](RELEASE.md). Older platform/version claims below do not certify the current version.

# Installation

## Install from Open VSX

The extension is published on Open VSX:

https://open-vsx.org/extension/lzhs1995/stata-workbench-shared-session

Use this route for Open VSX-compatible editors such as VSCodium, Cursor, and Windsurf when their extension UI can read Open VSX.

## Install from GitHub Release VSIX

Download the latest VSIX from:

https://github.com/lzhs1995/stata-workbench-shared-session/releases

Then install it:

```powershell
code --install-extension .\stata-workbench-shared-session-0.1.1.vsix
```

If the `code` command is unavailable, open VS Code and use:

```text
Extensions: Install from VSIX...
```

## Visual Studio Marketplace

The extension is not currently published on the Visual Studio Marketplace. Marketplace publication is deferred because it requires the Microsoft Marketplace publisher/PAT flow. Use Open VSX or the GitHub Release VSIX instead.

## Install from Source

```powershell
git clone https://github.com/lzhs1995/stata-workbench-shared-session.git
cd stata-workbench-shared-session
npm install
npm run package
code --install-extension .\stata-workbench-shared-session-0.1.1.vsix
```

## Configure Stata

Set `stataMcp.stataPath` to your local Stata executable path in VS Code settings.

Tested environments are listed in the README [platform status](../README.md#platform-status): Windows 11 x64 with Stata 18 MP and macOS 26.5 arm64 with StataNow. Windows 10, Windows on ARM and Linux are not verified. Do not commit your local path, license files, or local data into the repository.

## Minimal Smoke Test

1. Open `examples/minimal-workspace/smoke.do`.
2. Run `Stata: Open Interactive Terminal`.
3. Run `Stata: Run Current File` or select the file contents and run `Stata: Run Selection/Current Line`.
4. Confirm the Stata Terminal prints `STATA_WORKBENCH_SMOKE_OK`.

## Taught Task Smoke Test

After the minimal smoke test, open:

```text
examples/taught-tasks/taught_task1.do
```

Run it through `Stata: Run Current File`. It uses Stata's built-in `auto` data and writes outputs relative to the current working directory. For portable behavior, set:

```json
{
  "stataMcp.runFileWorkingDirectory": "${fileDir}"
}
```

See `examples/taught-tasks/README.md` before running the larger stress fixtures.
