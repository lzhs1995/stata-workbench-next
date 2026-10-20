# Stata Workbench Shared Session

Toolchain guide revision **2026-10-01**: [explicit shared execution, permitted hiding and concurrency](docs/shared-execution-and-concurrency.md), plus [research handoff and archive lessons](docs/empirical-review-and-archive.md). The published public runtime remains **0.1.3-rc.7.39**. This branch is **0.1.3-rc.7.44-dev.2**, a candidate recursive DO/PNG compatibility and saved-graph preview fix, not installed or covered by historical FULL45 acceptance. See [candidate scope](docs/ACCEPTANCE.md#recursive-do-candidate).

A VS Code extension for a visible Stata session shared sequentially by a human
and AI agents. Human Run File/Selection and agent commands use the same backend,
with visible output, graphs, execution serialization and recovery diagnostics.

中文：让人与 AI 在 VS Code 中轮流操作同一个 Stata 会话，共享数据和结果。
同一 backend 内人机串行提交。用户允许时，现有共享窗口可遮挡、隐藏或最小化；
这不改变执行所属会话。多实例并发需各自隔离和验证，当前公共客户端不提供通用多实例调度。

Read [shared-session execution and delivery lessons](docs/shared-session-delivery-lessons.md)
for preserving author DO files, inventorying actual saved data, reconciling the
original request, and distinguishing task budgets from user requirements.
Graph recovery and candidate release evidence retain their stated limits.

In this candidate, click an existing image artifact in Stata Terminal to open it
in Stata Graphs. This previews the saved file without running Stata again.
The panel shows that image alone; other exported files remain available from
their Terminal links and on disk.
Automatic graph batches continue to leave Terminal visible when no Graphs panel
is open. Native acceptance of the new click route is still pending.

## Current Release

[Download v0.1.3-rc.7.39-public.2](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.39-public.2)

Public packaging revision of extension version `0.1.3-rc.7.39`. Runtime bundle
unchanged from the locally accepted Mac installation. This VSIX removes a local
maintenance token and updates documentation; it is **not byte-identical** to the
private acceptance VSIX. It is published as a prerelease, not cross-platform stable.

Revision 2 updates Mac tools and permission documentation: errors such as `-1743`
are no longer reported as zero windows. Use `--doctor` and explicit
`--request-permissions` in the actual agent host. This is a diagnostic/guard fix,
**not a claim that every host is authorized**; the observed local permission-service
failure still needs system recovery. [Permission guide](docs/MAC_PERMISSIONS.md).

The fixed runtime passed a local FULL45 run: 45 scenarios, 632 steps (575
assertions, 57 observations), independent replay and human-to-agent-to-human
same-backend proof. S29 had one bounded product zero-ACK retry. S41's native
self-log was incomplete. See [acceptance scope](docs/ACCEPTANCE.md).

## Install And Use

Requirements: licensed Stata, VS Code, Python/uv runtime dependencies. Stata,
licenses, credentials and private data are not included. Current validation is
Mac-specific; Windows/Linux do not inherit certification from older releases.

1. Download the VSIX and verify SHA256SUMS from the release.
2. Use VS Code **Extensions: Install from VSIX...**.
3. Configure `stataMcp.stataPath` and open **Stata: Open Interactive Terminal**.
4. Open a `.do` file; run **Stata: Run Current File** or **Stata: Run Selection/Current Line**.

[中文使用指南](docs/USAGE.zh-CN.md) | [English quick start](docs/QUICKSTART.md)

For the Mac launcher and AI client, clone this repository at the release tag and
configure the isolated profile described in the guide:

```sh
python3 tools/verified_workbench.py --status
python3 tools/shared_stata.py --code 'display 1+1' --cwd /absolute/workspace
```

The client refuses a wrong bundle/listener owner, duplicate launcher, busy or
recovering session, or changed backend. It never resets Stata or retries an
unconfirmed POST. Keep the bridge on loopback: it is not a remote multi-user service.

## Development

For macOS/cmux caller-signature errors, interactive-launch failures or permission
setup, read the [complete desktop recovery record](docs/desktop-auth-terminal-recovery.md)
and [permission guide](docs/MAC_PERMISSIONS.md) before requesting a restart.
The record separates actual desktop access from original-profile/backend recovery
and preserves completed research and original failed requests.

```sh
npm ci --ignore-scripts
npm run check
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
```

`check` is read-only with a runtime digest guard. Packaging uses the versioned
maintained bundle, readable patches/helpers and UI sources, not a claimed clean
reconstruction of upstream TypeScript. See [release maintenance](docs/RELEASE.md).
New runtime edits require a new version and fresh live acceptance. CI is offline:
no licensed Stata, GUI keys, extension installation, or live acceptance claims.

## Attribution

Derived from [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench),
AGPL-3.0-or-later. Design comparisons with
[hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp) are acknowledged in
[NOTICE](NOTICE), not a claim of runtime interchangeability.
See [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md).
GitHub is the current distribution channel; the older Open VSX release is not
this runtime. Visual Studio Marketplace publication is outside this release.
