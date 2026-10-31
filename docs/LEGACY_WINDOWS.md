# Early Windows tooling: what happened to it

Before the cross-platform client, Stata Workbench was developed directly on one
Windows machine. The work lived in a research folder on the desktop (about 60
scripts and settings files), an older clone of this repository, and a shared
profile under `%USERPROFILE%\.stata-workbench`. None of that folder was under
version control. This page records, per file, whether its behavior is now in the
repository, was replaced, is no longer needed, or is still open.

The originals stay where they are. They are not copied into this public
repository because they contain personal paths and research notes; a private,
hashed archive of the text files is kept by the maintainer. Thirteen of the
scripts were already exported, with personal paths removed, by
`scripts/export_to_repo.ps1` (see [MAINTENANCE](MAINTENANCE.md)).

Status values:

- **Merged**: the behavior is in the named repository file.
- **Replaced**: a different mechanism in this repository does the job.
- **Not needed**: it served a retired approach or a different program.
- **Open**: possibly useful, not yet evaluated or ported.

## Startup tips from `open_stata_vscode_fast.ps1`

| Tip in the early launcher | Now |
| --- | --- |
| Shared `--extensions-dir` plus `--disable-extension` for 27 unrelated extensions | Replaced: each profile has its own `extensions` folder that contains only this extension, so nothing else loads (checked on the rc.7.44 macOS and Windows test profiles) |
| `--disable-workspace-trust` on every launch | Merged as an opt-in: `tools/verified_workbench.py --open --disable-workspace-trust` (also `acceptance.py open --disable-workspace-trust`). New launches only. Default behavior is unchanged: VS Code shows its trust prompt. With the option, every extension in the private profile runs with full trust, so use it only for a folder you trust |
| Return without a new window when the bridge is already online (`STATA_FAST_FORCE_NEW_WINDOW=1` to force one) | Replaced: `--open` reuses the running instance of the same profile and reports `REUSED`; it never opens a second window or restarts an unready one. The early check looked only at the port; the current one also requires the exact profile, launcher process and bundle identity |
| Skip the full patch verification and visible smoke run after startup (`STATA_FAST_SKIP_VERIFY`, `STATA_FAST_FULL_VERIFY`, `STATA_FAST_FORCE_SMOKE`) | Not needed: `--open` runs no patch verifier and no Stata command. It checks two SHA-256 pins and polls `/status` until the bridge identity matches |
| Per-workspace `MCP_STATA_TEMP` | Replaced: the private profile sets `MCP_STATA_TEMP` |
| Workspace settings that turn off Git, minimap, breadcrumbs and auto-update | Partly replaced: the private profile turns off extension auto-update, `update.mode` and telemetry. Git, minimap and breadcrumbs are **open** |

## Per file

Launchers and sessions:

| File | What it did | Status |
| --- | --- | --- |
| `open_stata_vscode_fast.cmd`, `open_stata_vscode_fast_hidden.vbs`, `open_stata_vscode_fast.ps1` | Fast Stata-focused VS Code window (tips above) | Replaced by `tools/verified_workbench.py --open`; the path-neutral copies remain in `scripts/` |
| `open_stata_vscode_hosted.ps1` | Hosted variant of the same window | Replaced by `tools/verified_workbench.py --open`; copy in `scripts/` |
| `open_stata_vscode_session.cmd`, `_hidden.vbs`, `.ps1` | New window per named session, recorded in `sessions.json` | Replaced: one profile and port per instance (`STATA_WORKBENCH_PROFILE`, `STATA_WORKBENCH_PORT`) |
| `stata_session_registry.ps1`, `stata_workbench_sessions.ps1`, `stata_bridge_common.ps1`, `multi_workbench_watchdog.ps1` | Multi-session registry, CLI and health watchdog | Open: multi-instance scheduling is a stated limitation (see README) |
| `open_hanlulong_stata_vscode_fast.*`, `hanlulong_bridge.ps1`, `hanlulong_terminal_bridge.ps1`, `invoke_hanlulong_*.ps1`, `hanlulong_terminal_patch_manager.js`, `HANLULONG_PHASE2_SHARED_TERMINAL_DESIGN.md`, `.vscode/mcp.hanlulong.json` | Comparison stack on another Stata extension | Not needed: this project builds on Stata Workbench; the comparison is credited in NOTICE |

Running code:

| File | What it did | Status |
| --- | --- | --- |
| `invoke_stata_visible.ps1`, `invoke_stata_visible_safe.ps1` | Send code to the visible Terminal | Merged: `scripts/` wrappers delegate to the single-POST client `tools/shared_stata.py`; unsafe modes are refused |
| `invoke_stata_segmented_visible.ps1`, `write_stata_run_ledger.ps1`, `verify_stata_execution.ps1` | Segmented long runs, run ledger, audit of real execution | Merged: `scripts/` |
| `invoke_stata_isolated.ps1` (+ backup) | Separate batch Stata process | Not needed: work runs in the visible shared session |
| `run_mcp_stata_py311_server.py`, `add_mcp_stata.js` | Start the service on Python 3.11; register it | Replaced: the profile's `runtime` venv (uv, Python 3.11) and its `mcp.json` |
| `tools/generate_stata_segments.py`, `tools/scan_brace_boundaries.py`, `tools/generate_standalone_runners.py` | Make the `segments.json` that the segmented runner reads | Open: the runner is in `scripts/`, its generator is not |
| `tools/generate_taught_task5_6.py` | Generate stress do-files | Not needed: the generated files are in `examples/taught-tasks/` |

Patching, recovery and settings:

| File | What it did | Status |
| --- | --- | --- |
| `patch_manager.js`, `stata_patch.ps1` | Anchor patches on the bundle; status/apply/verify | Merged: `scripts/` |
| `apply_patch*.js`, `apply_force_stop_v5.js`, `apply_single_flight_v4.js`, `apply_force_reset_v6_cleanup.js`, `apply_panic_kill_v10.js`, `graph_panel_v7*_patch.js` | One-off edits of an installed extension | Replaced by the replayed patch chain (`scripts/apply_*_patch.js`, `scripts/later_bundle_patches.js`) and `dist/extension.js` |
| `codex_patch_stata_workbench.ps1`, `inspect_workbench_patch_anchors.ps1` | Edit or inspect the installed extension in place | Not needed: releases ship a verified VSIX |
| `stata_workbench_patch_manifest.json` | Record of applied patches | Replaced: `release/runtime-manifest.json` and `tools/verify_release.py` |
| `tools/mcp_stata_local_patch_manager.py`, `tools/test_mcp_stata_local_patches.py` | Local patches to the installed service (session recycling, failing pending requests, IPC payload cap) | Open: compare with `scripts/mcp_stata_runtime_patch.js` |
| `cleanup_mcp_stata_processes.ps1`, `panic_kill_stata_chain.ps1`, `unblock_stata_terminal.ps1` | Orphan cleanup, emergency stop, Terminal recovery | Merged: `scripts/` |
| `cleanup_stata_workbench_artifacts.ps1`, `cleanup_old_7temp_tooling.ps1` | Archive and remove old backup folders | Not needed: those folders came from in-place patching |
| `codex_finalize_workbench_settings.ps1` | Turn off the extension's agent auto-configuration | Merged: `acceptance.py` writes these settings as `false` into the private profile |
| `configure_claude_code_permissions.ps1`, `inspect_claude_permissions.ps1` | Agent host permissions | Not needed: agent host, not the extension |
| `inspect_stata_extensions.ps1` | List installed Stata extensions | Not needed: the private profile holds one extension; `--doctor` reports its identity |
| `.vscode/settings.json`, `.vscode/tasks.json`, `.mcp.json`, `.vscode/mcp.json` | Workspace settings, patch tasks, service registration | Replaced: `examples/minimal-workspace` and the private profile |
| `.github/*`, `.claude/*`, `CLAUDE.md`, `AGENTS.md`, `MEMORY.md` | Agent instructions and notes for the research folder | Not needed: private notes |
| Bug reports, `RUN_STATA_VISIBLE_EXAMPLES.md`, `STATA_WORKBENCH_BRIDGE_TOOLKIT.md`, `Stata_Workbench_协作执行与补丁说明.md` | Development notes | Replaced by `docs/`; originals kept privately |
| `docs/` folder in the research folder | Migration notes and per-version history | Open: may hold history not yet in `docs/` |
| `tools/stata-native-folding/` | A separate folding extension | Not needed here: a different extension |

Other locations: the older desktop clone of this repository (at 0.1.1, May 2026)
is replaced by current `main`. The shared profile `%USERPROFILE%\.stata-workbench`
belongs to the early launchers and may still be in use, so it is left alone. The
desktop backup archive (zip files from in-place patching) is kept privately.

## 中文说明

跨平台客户端之前，Stata Workbench 直接在一台 Windows 机器上开发。东西散在三处：桌面上的研究文件夹，约 60 个脚本和设置文件，不在版本控制里；本仓库的一份旧克隆；`%USERPROFILE%\.stata-workbench` 下的共享 profile。下表逐个说明每个文件的去向。原文件都没有动，也不放进这个公开仓库，因为里面有个人路径和研究笔记。维护者另存了一份带哈希的私有归档。其中 13 个脚本早先已经由 `scripts/export_to_repo.ps1` 去掉个人路径后导出到 `scripts/`。

状态说明：**已并入** 指功能已经在仓库的某个文件里；**已被取代** 指仓库里有别的机制做同一件事；**不再需要** 指它服务的是已退役的做法或别的程序；**待定** 指可能有用，还没评估或移植。

### `open_stata_vscode_fast.ps1` 里的提速办法

| 早期做法 | 现在 |
| --- | --- |
| 共用 `--extensions-dir`，再用 `--disable-extension` 关掉 27 个无关扩展 | 已被取代：每个 profile 有自己的 `extensions` 目录，里面只有这一个扩展，别的扩展根本不会加载。rc.7.44 的 macOS 和 Windows 测试 profile 都核过 |
| 每次启动都加 `--disable-workspace-trust` | 已并入，改成可选：`tools/verified_workbench.py --open --disable-workspace-trust`，`acceptance.py open` 也支持同一个开关。只对新启动生效。默认行为不变，VS Code 仍会弹出信任提示。打开这个开关后，私有 profile 里的扩展都按完全信任运行，所以只用于你信任的文件夹 |
| 桥已在线时不开新窗口直接返回（设 `STATA_FAST_FORCE_NEW_WINDOW=1` 才强制新开） | 已被取代：`--open` 会复用同一 profile 正在运行的实例，返回 `REUSED`；它不会开第二个窗口，也不会重启还没就绪的实例。早期只看端口，现在还要求 profile、启动进程和 bundle 身份都一致 |
| 启动后跳过完整补丁校验和可见冒烟运行（`STATA_FAST_SKIP_VERIFY` 等开关） | 不再需要：`--open` 本来就不跑补丁校验，也不发任何 Stata 命令。它只核两个 SHA-256，再轮询 `/status`，直到桥的身份对上 |
| 每个工作区单独设 `MCP_STATA_TEMP` | 已被取代：私有 profile 自己设置 `MCP_STATA_TEMP` |
| 工作区设置关掉 Git、minimap、breadcrumbs 和自动更新 | 部分取代：私有 profile 已关掉扩展自动更新、`update.mode` 和遥测；Git、minimap、breadcrumbs 这三项**待定** |

### 逐个文件

上面英文表逐行列出了每个文件的状态，这里只列结论：

- **已并入**：
  - `invoke_stata_visible*`、分段运行、运行台账、执行审计；
  - `patch_manager.js` 与 `stata_patch.ps1`；
  - 孤儿进程清理、紧急停止、Terminal 解锁；
  - 关掉扩展自动配置 agent 的设置。
  - 以上脚本都在 `scripts/`；最后一项由 `acceptance.py` 写进私有 profile。
- **已被取代**：
  - 各个启动器，由 `tools/verified_workbench.py --open` 取代；
  - 按会话开窗口，改为每个实例各用一个 profile 和端口；
  - Python 3.11 服务启动，改为 profile 自己的 `runtime`；
  - 一次性改已装扩展的补丁，改为可重放的补丁链加 `dist/extension.js`；
  - 补丁清单，改为 `release/runtime-manifest.json`；
  - 工作区设置，改为 `examples/minimal-workspace` 加私有 profile；
  - 开发笔记，改为 `docs/`。
- **不再需要**：
  - 对照用的另一套 Stata 扩展；
  - 独立批处理 Stata 进程；
  - 原地改扩展、查补丁锚点的脚本；
  - 旧备份目录的清理脚本；
  - agent 宿主的权限脚本；
  - 研究文件夹里的 agent 说明和私人笔记；
  - 另一个折叠扩展；
  - 生成压测 do 文件的脚本（产物已在 `examples/taught-tasks/`）。
- **待定**：
  - 多会话登记、命令行与看门狗（README 已写明没有多实例调度）；
  - `segments.json` 的生成脚本（`scripts/` 里有分段运行器，没有生成器）；
  - 早期对服务的本地补丁（会话回收、挂起请求快速失败、IPC 载荷上限），需要与 `scripts/mcp_stata_runtime_patch.js` 逐条对照；
  - 研究文件夹里的 `docs/` 历史记录。

其他位置：桌面上的旧克隆停在 0.1.1（2026 年 5 月），已由现在的 `main` 取代。`%USERPROFILE%\.stata-workbench` 是早期启动器用的共享 profile，可能还在用，所以不动。桌面上的备份压缩包来自原地改补丁那个阶段，私下保留。
