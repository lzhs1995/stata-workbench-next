# Stata Workbench 共享会话（Next）

[English](README.md) | [中文](README.zh-CN.md)

> **开发线。** 本仓库（`stata-workbench-next`）用来开发和测试多会话、agent 身份、
> bridge 鉴权和经审阅的 agent 改稿。它不替换稳定版
> [stata-workbench-shared-session](https://github.com/lzhs1995/stata-workbench-shared-session)。
> 在某个 Next 构建正式转正之前，研究工作请继续用稳定版。

这是一个 VS Code 扩展，让人和 AI agent 共用同一个看得见的 Stata 会话。双方的代码在同一个
Stata 后端里运行，运行进度实时显示在 **Stata Terminal** 面板里：人可以看着 agent 跑，随时插话、
按 **Stop**、改完再跑。数据、宏、标量、估计结果和图在被清掉之前一直共享。

Next 线新增：

- **同时开多个会话。** 最多 5 个有名字的会话，每个都有自己的 VS Code 窗口、Stata 后端、端口和配置目录。
- **bridge 鉴权。** 每个本地 bridge 请求都要带该会话的 token。agent 客户端从会话自己的注册表文件里读取，不需要人手工复制 token。
- **agent 改稿要经人审阅。** agent 改 `.do`、`.ado`、`.mata` 文件时只能先提交提议，人在 diff 里点 **Accept** 之后才会写入。
- **Stop 和恢复如实报告。** 有运行前检查点时，Stop 会把它恢复回来；恢复不了时会话会锁住，不会在错误的数据上悄悄继续跑。

派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)
（AGPL-3.0-or-later），见[许可](#许可)。

## 目录

- [与稳定版的关系](#与稳定版的关系)
- [环境要求](#环境要求)
- [安装](#安装)（[macOS](#macos)、[Windows](#windows)）
- [快速上手](#快速上手)
- [功能](#功能)
- [平台实测结果](#平台实测结果)
- [已知限制](#已知限制)
- [排错](#排错)
- [配置](#配置)
- [开发](#开发)与[许可](#许可)

## 与稳定版的关系

Next 和稳定版可以装在同一台机器上并行使用，两者不共用任何东西，Next 的测试窗口不会干扰研究会话。

| | 稳定版 | Next |
| --- | --- | --- |
| 扩展 id | `lzhs1995.stata-workbench-shared-session` | `lzhs1995.stata-workbench-next` |
| bridge 端口 | `17485` | 默认 `17601`；启动器在 `17601`–`17620` 里挑空闲端口 |
| 状态目录 | `~/.stata-workbench-shared`（默认配置目录） | `~/.stata-workbench-next`（`STATA_WORKBENCH_NEXT_HOME`） |
| Stata 服务运行时 | 全机共用一份 | 每个会话一份私有副本（macOS 用 APFS 克隆，Windows 整份复制） |
| 会话数 | 一个配置目录加一个端口算一个 | 一台机器最多 5 个有名字的会话 |
| agent 工具 | 稳定版仓库的 `tools/` | 本仓库的 `tools/`；对不上 bundle 就拒绝 |

Next 启动器从不选用 `17485`、`17416`、`17497`、`17507` 这几个端口，所以 Next 会话不会占用稳定版工具在用的端口。

当前版本：`0.2.0-next.5`（见 `package.json`）；`main` 上已有[更新日志](CHANGELOG.md)里 `0.2.0-next.6`
一节列出的改动，尚未发布。只通过 GitHub Releases 分发，Next 的构建在那里以预发布版
（pre-release）发布；不发布到 Open VSX 或 Visual Studio Marketplace。

## 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | macOS（实测 Apple Silicon）或 Windows 11 x64 |
| VS Code | 1.75 或更高（实测：macOS 1.139.1，Windows 1.144.0） |
| Stata | 本机已授权的安装（实测：macOS 上 StataNow，Windows 上 Stata 18 MP） |
| `uv` | 建一次 Stata 服务运行时时用（Python 3.11 上的 `mcp-stata` 1.26.1） |
| Python 3 | 运行 `tools/` 里的启动器和 agent 工具。Windows 上用装好的 `python.exe`，不要用 Microsoft Store 的别名 |
| 内存 | 每个打开的会话各跑一份 VS Code 和 Stata，见[已知限制](#已知限制) |
| 磁盘 | macOS：可用空间低于 20 GB 时启动器拒绝开新会话。Windows：2 GB 加上运行时副本的大小 |

## 安装

扩展、Stata 服务运行时和 agent 工具是三样东西，每台机器各装一次。

1. **下载 VSIX 并核对，再取同一 tag 的工具。** 从预发布版
   [`v0.2.0-next.5`](https://github.com/lzhs1995/stata-workbench-next/releases/tag/v0.2.0-next.5)
   下载 `stata-workbench-next-0.2.0-next.5.vsix`，把它的 SHA-256
   和发布说明里的值对一下：macOS 用 `shasum -a 256 <文件>`，Windows 用
   `(Get-FileHash <文件> -Algorithm SHA256).Hash.ToLower()`。然后克隆本仓库，切到同一个 tag。
   工具钉了 bundle 的 SHA-256，遇到别的构建一律拒绝；`python3 -B tools/verify_release.py --vsix <文件>`
   可以拿克隆里的运行时清单核对 VSIX。自己打 VSIX 见[开发](#开发)。
2. **把 VSIX 装进 Next 共用的扩展目录。** 启动器把每个会话的 `extensions` 目录链接到
   `~/.stata-workbench-next/extensions-shared`，所以要装在这里，不要装进日常用的 VS Code 配置。
3. **建 Stata 服务运行时**，放在扩展和启动器最先查找的位置。同一台机器上已经装过稳定版的话，
   这份运行时一般已经有了；启动器只读它，给每个会话复制一份。

### macOS

```sh
git clone https://github.com/lzhs1995/stata-workbench-next.git
cd stata-workbench-next
git checkout v0.2.0-next.5   # 你的 VSIX 对应的 tag

CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --user-data-dir ~/.stata-workbench-next/install-user-data \
  --extensions-dir ~/.stata-workbench-next/extensions-shared \
  --install-extension ./stata-workbench-next-0.2.0-next.5.vsix

RT=~/.local/share/stata-workbench/mcp-stata-1.26.1
uv venv --python 3.11 "$RT"
uv pip install --python "$RT/bin/python3" \
  -c examples/platform-acceptance/service-constraints.txt mcp-stata==1.26.1
```

### Windows

在 PowerShell 里，于本仓库的克隆目录下执行：

```powershell
code --user-data-dir "$HOME\.stata-workbench-next\install-user-data" `
  --extensions-dir "$HOME\.stata-workbench-next\extensions-shared" `
  --install-extension .\stata-workbench-next-0.2.0-next.5.vsix

$rt = Join-Path $env:LOCALAPPDATA 'stata-workbench\mcp-stata-1.26.1'
uv venv --python 3.11 $rt
uv pip install --python "$rt\Scripts\python.exe" `
  -c examples\platform-acceptance\service-constraints.txt mcp-stata==1.26.1
```

`code` 指 VS Code 的 `bin\code.cmd`。如果它不在 `PATH` 里，先用 `Get-Command code` 查，
修好 `PATH`，或者直接用完整路径调用 `Code.exe`。下文所有命令在 Windows 上把 `python3` 换成 `python`。

约束文件把 MCP 钉在 2.x 以下（`mcp==1.28.1`）。不用它的话，`uv` 会解析到 MCP 2.x，服务导入失败。
运行时放在别处的，可以用 `--runtime-source` 或 `STATA_WORKBENCH_RUNTIME_SOURCE` 指定。

## 快速上手

以下命令都在仓库根目录执行，每个工具都输出一个 JSON 对象。

**1. 开会话。**

```sh
python3 -B tools/stata_session.py open s1 --workspace /absolute/path/to/project
```

这一步会建 `~/.stata-workbench-next/profiles/s1/`，挑一个空闲端口，写好会话设置，然后启动一个
VS Code 窗口。它最多等 60 s，看这个窗口的 VS Code 进程有没有出现，结果写在 `launchState` 里
（`visible`、`accepted-not-visible` 或 `prepare-only`）；不等 bridge、不激活窗口、不发任何 Stata 命令。
只看到 `LAUNCHED` 不代表 bridge 已就绪。不给 `--workspace` 时，会话用自己那个空的 `profiles/s1/workspace`。

之后 Stata 在开窗时后台加载（启动器会写 `stataMcp.loadStataOnStartup: true`，配置目录里已设过的值不动），
Windows 11 上 connect 用了 54–66 s，`open` 之后 97–108 s Stata 后端就绪。`trueReady` 不等这次加载。加载期间在 Terminal 交的命令或 agent 的提交都会先等 Stata worker 进入 running；等过 2 s，Terminal 显示「Waiting for Stata to finish loading…」。见[已知限制](#已知限制)。

新工作区会以 VS Code 的受限模式（Restricted Mode）打开，点一次 **Trust** 之后扩展才启动。
只有对你专门为这个会话建的工作区，才用 `--disable-workspace-trust`。找不到 Stata 时，在窗口里设置
`stataMcp.stataPath`。

**2. 核对会话。**

```sh
python3 -B tools/verified_workbench.py --status --session s1
python3 -B tools/stata_session.py list
```

`--status` 先核对装好的 bundle 和工具钉的值是否一致，再经过鉴权的 bridge 读 `/status`。
`list` 列出每个配置目录、它的端口、VS Code 进程和活着的注册表记录（不含 token）。

**3. 人来运行代码。** 在窗口里执行 **Stata: Open Interactive Terminal**，直接输入命令，
或者对 `.do` 文件用 **Stata: Run Current File**。每次运行的卡片抬头是 `You · <runId>`。

**4. agent 来运行代码。**

```sh
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --code 'display c(N)' --cwd /absolute/path/to/project
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --file analysis.do --cwd /absolute/path/to/project --busy-policy wait --max-wait 60
```

运行过程实时出现在同一个 Terminal 里，抬头是 `claude · <runId>`，人随时可以按 **Stop**。
退出码 0 表示 verdict 是 `PASS_VISIBLE_SHARED_RUN`，其他情况退出码 2。客户端只发一次请求，
从不重试：超时或结果不明不能证明 Stata 没执行，再次提交前先看 `.stata-receipts/` 里的回执。
回执里有你的代码和输出，不要提交进 Git。

`REFUSED_NOT_DISPATCHED` 表示扩展在发出之前就拒绝了这次运行（比如 Stata 没加载完，或者人在等待时按了
Stop）。输出里带 `reasonCode`、`retryable` 和 `retryAfterMs`；因 Stop 而拒绝的不可重试。

Stata 已经执行、但报了错的命令（比如 `r(111)`），退出码 2，不会重试。扩展能用本次运行自己的日志和
mcp-stata 的返回码确认这个报错时，verdict 是 `STATA_ERROR_CONFIRMED`，带 `stataRc`；确认不了就仍是
`EXECUTION_UNCONFIRMED_NO_RETRY`。两种情况下 Stata 的报错文字都在回执里，报错之前的命令可能已经改了数据。
这条路径目前只做过离线验证，见[已知限制](#已知限制)。

`--session` 接受会话名或会话 id（也可以设 `STATA_WORKBENCH_SESSION`）。只有一个活会话时可以省略，
有多个时必须给。

**5. 关会话。**

```sh
python3 -B tools/stata_session.py close s1
```

`close` 只请这个会话的 VS Code 窗口自己退出（macOS 发 SIGTERM，Windows 用不带 `/F` 的
`taskkill`），从不强杀。VS Code 在问要不要保存未保存的修改时，返回 `CLOSE_PENDING`（退出码 2），
窗口和文件都保持原样。同一会话的 `open` 还没结束时，返回 `OPENING`（退出码 2），不发任何信号。
其他会话照常运行。

agent 客户端的其他选项：`--list-sessions` 打印注册表；`--events 0` 打印会话事件流
（谁跑了什么、Stop、被拒、改稿提议），不运行代码。

## 功能

### 人和 agent 共用一个看得见的会话

- 编辑器命令和稳定版一样：**Run Current File**（`Ctrl+Shift+D`，macOS `Cmd+Shift+D`）、**Run Selection/Current Line**（`Ctrl+Shift+Enter` / `Cmd+Shift+Enter`）、**Open Interactive Terminal**（`Ctrl+Shift+C` / `Cmd+Shift+C`）、**View Data**、Stata Graphs 面板和 Data Browser。
- Terminal 里每次运行的卡片都标明来源：人是 `You · <runId>`，agent 是 `<agent 名> · <runId>`。runId 和 agent 回执里的一致。
- 一个后端同一时间只跑一个请求。agent 在跑时人按 Run，VS Code 提示 `<agent> is running Stata (<runId>). Wait for it to finish, or press Stop in the Stata Terminal.`，这次被拒也会记进事件流。
- 每个会话有一份只追加的事件日志（`~/.stata-workbench-next/runs/<sessionId>/events.jsonl`），可以用 `shared_stata.py --events 0` 读。
- 共享内存不是持久存储。重置、重启或关闭 VS Code 之前，先把数据和结果存到磁盘上。

### 多会话

- `tools/stata_session.py` 最多管理 **5** 个活会话。第 6 个 `open` 返回 `SESSION_LIMIT`，什么都不建。
- 每个会话有自己的配置目录、端口（`17601`–`17620`）、Stata 服务运行时、临时目录、运行前快照和执行锁。会话之间并行运行：两个 agent 可以同时往两个会话提交，谁也不用等谁。
- 有多个活会话时，agent 客户端不带 `--session` 就拒绝提交（`MULTIPLE_SESSIONS`，退出码 2），什么都不执行。
- 重开同名会话时，原来的端口空出来就沿用它。刚 `close` 完，旧端口可能还被系统占着（TIME_WAIT），这时启动器换下一个空闲端口。工具按会话名找会话，不受影响。配置目录里已经显式设过的值保持不动。
- 几个 `open` 可以同时跑。每个都在一把短锁里预留名字、端口和会话名额，然后在锁外启动；运行时的复制一个接一个做，后一个能看到前一个用掉的磁盘空间。同名会话还在打开时，第二个 `open` 会被拒绝。

### bridge 鉴权

- 每个会话在 bridge 启动时生成一个 32 字节的随机 token，只写进它自己的注册表文件 `~/.stata-workbench-next/sessions/<sessionId>.json`。macOS 上该文件权限是 `0600`；Windows 上重建访问控制列表，只给当前用户。
- bridge 的每个端点都要求 `Authorization: Bearer <token>`（缺失或错误返回 HTTP 401）、`Host` 恰好是 `127.0.0.1:<端口>`、请求不带 `Origin` 头（否则返回 HTTP 403）。token 不会出现在 `/status` 和事件流里。
- 提交之前，agent 客户端核对注册表记录、`/status` 和装好的 bundle 在会话 id、端口、重置代数（reset generation）和 bundle SHA-256 上是否一致。任何一项不符就报 `SESSION_IDENTITY_MISMATCH`，什么都不发。
- 注册表文件要等 bridge 真正绑定端口之后才写，窗口关闭时删除。`close` 还会清掉写入进程已退出时残留的临时注册表文件。

### agent 改 Stata 文件要经人审阅

- agent 要改 `.do`、`.ado`、`.mata` 文件，只能调 `POST /propose-edit`，提交文件路径、新内容（不超过 2 MiB）、当前文件的 SHA-256 和修改理由。
- VS Code 打开一个 diff，带 **Accept** 和 **Reject** 两个按钮。只有点了 **Accept**、并且文件在审阅期间没被改过，才会写入；旧版本的带时间戳副本存进 `~/.stata-workbench-next/edit-snapshots/`。
- SHA-256 不对（`SHA_MISMATCH`）、审阅期间人改了文件（`SHA_CHANGED_DURING_REVIEW`）、被拒绝或超时（默认 120 s），都不会写文件。每种结果都记进事件流。
- 这道关由扩展执行。agent 宿主那一侧也应该拦住直接写文件：[docs/next/AGENT-EDIT-PERMISSIONS.md](docs/next/AGENT-EDIT-PERMISSIONS.md) 给了 Claude Code 的 deny 规则。Codex 没有按文件生效的同类规则，所以必须走提议流程。

### Stop、恢复与锁定

- Terminal 里的 **Stop**（或 `POST /soft-stop`）取消当前运行、等它的任务收尾，Stata 后端保持不变。
- 每次 agent 运行之前，会话先给数据存一份运行前检查点。Stop 会把它放回去，人看到的是 agent 开始之前的数据。人自己的运行没有检查点，这时 Stop 会先确认 Stata 已经空闲，数据保持原样。
- 每次 Stop 都让 `resetGeneration` 加 1，agent 靠它判断自己用过的会话是否被打断过。
- 应该有检查点但没能恢复时，会话会**锁住**：`/status` 报 `trueReady: false`，之后的运行返回 HTTP 423，状态栏显示 **Stata: STALE**，Terminal 提示没有恢复运行前状态、会话已锁定。
- 点状态栏的 **Stata: KILL** 解锁：确认一次后，它强制重置本会话自己的后端，再跑经过核验的恢复 smoke（一条固定的 marker 命令，必须 rc 0 且日志里有 marker）。确认即表示接受丢失 Stata 内存里的数据。在 Windows 上，KILL 还会结束本机所有 Stata 图形界面进程（`StataMP-64`、`StataSE-64`、`Stata-64`），不只是本会话的。<!-- PENDING #22: PR #22（rc.7.82）合并后，把 Windows 这句换成 V3-K-REPORT.md 第 7 节的写法：KILL 只结束本窗口按父进程和创建时间认定的后端进程树；认不准归属时一个都不结束。 -->
- 执行看门狗会取消没有日志进展的普通运行：第一行日志出现前 120 s 没动静，或出现后 60 s 没动静（识别为长任务的运行分别是 300 s 和 30 分钟）。第一行日志之后，本窗口自己的 Stata worker 用掉的 CPU 时间也算进展，所以像 `bootstrap … nodots` 这样不输出、但 worker 一直在算的命令不会在 60 s 时被取消。CPU 在跑不等于在做有用的事：一直空转、不输出的运行，最多能占着会话到日志连续 30 分钟没动静为止，想提前结束就按 Stop 或 **Stata: KILL**。读不到或核实不了 worker 的 CPU 时间时，看门狗只按日志规则判断。运行前检查点会被恢复，但看门狗取消之后会话一律锁住，要点 **Stata: KILL** 才能继续。锁定原因会写明是哪种停顿，例如 `EXEC_PRELOG_STALL (IDLE)`；每次取消都记进 `/status.lastGuardFailure`。
- 后端还在启动、什么都还没发出时按 Stop，命令会被拒绝（`PRE_RUN_BACKEND_START_CANCELLED`），会话不会被锁。
- 代码已经发出之后才超时的，回包报 `EXEC_OUTCOME_UNKNOWN` 并带 `payloadMayHaveRun: true`，因为代码在 Stata 里可能还会执行。

## 平台实测结果

所有实机测试都用隔离的 Next 配置目录、合成的 `.do` 文件和 `17601`–`17620` 端口，没有用到研究数据。
界面操作（Stop、Trust、KILL）通过 VS Code DevTools 协议驱动，不是真人按键。日期为 2026 年、台北时间。
构建指 `main` 的提交：`e7e54848`、`579b0fe9` 和 `171138b6` 都是 `0.2.0-next.5`，`8d63cb45` 是 `0.2.0-next.4`。

11-04 的各行来自两类构建。`aba81779` 是 `v0.2.0-next.5` 发布版。`a1a2832b`（PR #21）、`40abcbea`（PR #20）
和 `2ec968a`（PR #24）是 PR 的 head，在复审返工和合并之前测的；合并后的 `main` 还没有实机复测。

### macOS（Apple Silicon，macOS 26.5，StataNow，VS Code 1.139.1）

| 检查 | 构建、日期 | 结果 |
| --- | --- | --- |
| 人和 agent 共用一个会话（global、变量、估计结果、图；Terminal 卡片显示 agent 名和回执里的 runId） | `8d63cb45`，11-01 | 通过 |
| 同时运行 2、3、5 个会话 | `8d63cb45`，11-01 | 通过。5 个会话重叠 28.57 s，各自读回自己的 owner、N 和系数；第 6 个 `open` 返回 `SESSION_LIMIT` |
| 注册表与身份校验的拒绝（陈旧记录、PID 被复用、token 错、generation 不符、多个活会话不带 `--session`） | `8d63cb45`，11-01 | 通过，7/7 被拒且没有执行 |
| 两个 agent 同时往两个会话提交（30 s 命令，间隔 0.008 s 发出） | `579b0fe9`，11-02 | 通过。两边都是 HTTP 200，分别用时 34.41 s 和 34.26 s |
| 一个会话跑 60 s，另一个会话交短命令 | `579b0fe9`，11-02 | 通过。长命令还在跑时，短命令 4.50 s 就返回了 |
| 两个会话都在忙时只 Stop 其中一个 | `579b0fe9`，11-02 | 通过。被停的会话恢复就绪；另一个照常跑完，重置代数不变 |
| 两个活会话时不带 `--session` | `579b0fe9`，11-02 | 通过。`MULTIPLE_SESSIONS`，什么都没执行 |
| 两个会话关掉一个 | `579b0fe9`，11-02 | 通过。它的注册表记录已删除；另一个会话照常能跑代码 |
| 人的长命令在 Terminal 里按 Stop，两次 | `579b0fe9`，11-02 | 通过。两次都是第一次点击就停，Stata 进程不变，数据保留 |
| 对 agent 运行按 Stop | `579b0fe9`，11-02 | 通过。没有强制重置，运行前状态已恢复（`RECOVERED_FULL`） |
| 运行前检查点被删掉后按 Stop | `579b0fe9`，11-02 | 通过。会话锁住（`trueReady: false`，下一次运行 423，状态栏 STALE） |
| **Stata: KILL** 解锁 | `579b0fe9`，11-02 | 通过。确认一次，恢复 smoke rc 0，下一次运行成功 |
| 开窗后第一条命令，`loadStataOnStartup` 为 `false`（5 次）和 `true`（2 次） | `aba81779`，11-04 | 通过，7/7 HTTP 200、rc 0，没有在首条日志前卡住。命令先等 Stata 加载完（`false` 11–14 s，`true` 约 7 s，第一次冷启动 61 s），Output 日志先写「Waiting for Stata to finish loading…」，再写「finished loading after N s」 |
| Stata 还在加载时交的命令：按 Stop、超时、worker 失败 | `aba81779`，11-04 | 通过。等待中按 Stop：HTTP 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`，什么都没发出，下一条 rc 0。worker 被冻结：336.5 s 后 HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT`，会话没锁。随后结束该 worker：HTTP 500 `PRE_RUN_BACKEND_WARMUP_FAILED`；下一条命令等了 37 s 重新加载，返回 rc 0 |
| 后端 connect 完成之前按 Stop | `aba81779`，11-04 | 失败。什么都没发出，但软 Stop 35.6 s 后返回 500，会话被锁（`soft-stop-did-not-restore-checkpoint`）。rc.7.83（PR #25）已修，目前只有离线测试 |
| 命令运行时点 Terminal 的 Stop 按钮 | `aba81779`，11-04 | 第一轮 0/2：测试驱动点的位置被 Welcome 页的透明遮罩盖住，点击没有到达 Terminal。关掉 Welcome 之后，鼠标点击、在 Terminal 视图内点击、**Stata: Cancel Current Request** 各一次都停下了运行，会话没锁 |
| 人和 agent 轮流跑；agent 运行中人插话 | `aba81779`，11-04 | 通过。人的提交得到 HTTP 409 `bridge busy`，写明正在运行的 agent；之后双方读到同一个 owner、N 和系数 |
| 两个活会话时点 **Stata: KILL** | `aba81779`，11-04 | 通过。只有被锁会话的 3 个进程被换掉；另一个会话正在跑的 40 s 命令照常 rc 0 完成 |
| 5 个活会话，3 个同时提交 | `aba81779`，11-04 | 部分通过。第 6 个 `open` 得到 `SESSION_LIMIT`。3 个同时提交里 2 个通过；一个在窗口报就绪约 20 s 后交的 agent 提交，因为后端还没起来，在派发前被拒（`BLOCKED_NO_DISPATCH`）。rc.7.86（PR #26）已修，目前只有离线测试 |
| 高负载下（load average 120–140）不输出的长命令 | `aba81779`，11-04 | 失败。一条 `bootstrap … dots(50)` 60 s 没有新日志，63 s 时被当作 `EXEC_PRELOG_STALL (IDLE)` 取消，会话被锁。rc.7.84（PR #24）加了 worker CPU 信号 |
| worker CPU 信号：空闲噪声和真卡死 | `2ec968a`，11-04 | 通过。空闲 worker 的 CPU 时间每 12 s 增长 10 ms（阈值 200 ms）。用 SIGSTOP 冻结的 worker 照样被取消，冻结后 69.7 s；KILL 之后下一条命令 rc 0。不输出的长命令那一项在首条日志预算内就结束了，所以「60 s 空闲且有 CPU 进展」那条路径还没有实机测到 |

### Windows（Windows 11 x64，Stata 18 MP，VS Code 1.144.0）

| 检查 | 构建、日期 | 结果 |
| --- | --- | --- |
| 新配置目录关闭 VS Code 和扩展的自动更新 | `171138b6`，11-02 | 通过 |
| agent 改稿审阅：接受、拒绝、审阅期间被改 | `171138b6`，11-02 | 通过 |
| 拒绝：PID 被复用、token 错、端口被占、陈旧记录 | `171138b6`，11-02 | 通过，什么都没发 |
| 双会话：两个 agent 同时提交、一边忙一边提交、Stop 其中一个、互不串、`MULTIPLE_SESSIONS` | `579b0fe9`，11-02 | 通过。两次运行重叠 40.5 s；读回分别是 `owner=w3a N=111` 和 `owner=w3b N=222` |
| 双会话 20 轮同时提交（40 次运行，其中 5 次中途 Stop） | `e7e54848`，11-03 | 通过，20/20。没被 Stop 的 35 次全部通过，日志没有一行串到另一个会话；被 Stop 的 5 次都恢复了、没有强制重置，另一个会话的重置代数不变（5/5）。20 轮里 Stata pid 都没变 |
| 人的长命令在 Terminal 里按 Stop，五次 | `e7e54848`，11-03 | 通过，5/5。第一次点击就停，Stata 进程不变，Stop 之前的数据保留 |
| 运行前检查点被改名后按 Stop | `e7e54848`，11-03 | 通过。提示写明没有恢复运行前状态、会话已锁、要点 **Stata: KILL**；状态 fenced，下一次运行 423。`579b0fe9` 上同一场景的提示错说检查点已恢复 |
| 人的长命令在 Terminal 里按 Stop，两次 | `579b0fe9`，11-02 | 通过，2/2：第一次点击就停，Stata 进程不变，数据保留 |
| 从 Terminal 停掉 agent 运行 | `579b0fe9`，11-02 | 通过。运行前检查点已恢复（`restored=true`），读回 N=77 |
| 运行前检查点被移走后按 Stop | `579b0fe9`，11-02 | 通过。会话锁住（`snapshot-expected-not-restored`） |
| 看门狗取消一条静默的 agent 命令 | `579b0fe9`，11-02 | 部分通过。运行前检查点已恢复，但取消升级成了强制重置，状态里报的是上一次失败的原因 |
| 看门狗取消一条静默的 Terminal 命令 | `e7e54848`，11-03 | 通过。静默探针读到了自己的 marker，没有强制重置；锁定原因是这次取消自己的（`elapsedMs 63187`、`stallReason IDLE`） |
| 开窗后的第一条命令，`loadStataOnStartup=false` | `579b0fe9`，11-02；`e7e54848`，11-03 | 时好时坏：3 次卡了 2 次（约 120 s 后 HTTP 504，会话锁住）；另一次 42.2 s 返回 rc 0。`e7e54848` 上的 504 报 `EXEC_OUTCOME_UNKNOWN`、`payloadMayHaveRun: true` |
| 开窗后的第一条命令，`loadStataOnStartup=true` | `579b0fe9`，11-02 | 通过。开窗时 Stata 在后台加载，用了 57.7 s；之后第一条命令 6.1 s 完成，rc 0 |
| 默认 `loadStataOnStartup`（配置里没有这个键），开窗后第一条 agent 命令 | `3765d82a`，11-03 | 通过，3/3。启动器写入 `true`；`open` 之后 106.6–107.7 s Stata 就绪；第一条 agent 命令 23.1–25.2 s 返回 rc 0。`open` 之前写好的 `false` 被保留 |
| agent 路径和 Terminal 路径上的看门狗取消 | `3765d82a`，11-03 | 通过。每次取消都在 `/status.lastGuardFailure` 记下自己的 `runId` 和 `elapsedMs`（63 615 ms 和 63 159 ms）；锁定原因 `EXEC_PRELOG_STALL (IDLE)`。只出现了 `IDLE` 这一种停顿 |
| 被取消的冷启动命令的迟到事件（`loadStataOnStartup=false`） | `3765d82a`，11-03 | 通过。命令 167.1 s 后返回 HTTP 504；它迟到的 `log_path` 事件以 `not this client's run` 被丢弃，没有交给下一次运行 |
| 这类取消之后的普通命令；重新开窗后的第一条 Terminal 命令 | `3765d82a`，11-03 | 部分通过。解锁后同一后端：5/5 rc 0，每条约 3.1 s，日志里没有别人的行。默认 `true` 重新开窗：0/2。`connect` 完成（54.2 s）后立刻发的第一条 Terminal 命令在首条日志前卡住，163.9 s 后返回 HTTP 504；会话被锁，第二条得 423 |
| 两个会话，8 轮同时提交 agent 命令、其中 2 轮按 Stop；Terminal Stop 3 次 | `3765d82a`，11-03 | 通过。没被停的 14/14 全部通过；被停的 2 次都恢复了，没有强制重置；日志没有串到另一个会话；每轮 21.4–24.8 s。Terminal Stop 3/3 第一次点击就停 |
| `close` 清理残留的临时注册表文件 | `171138b6`，11-02；`e7e54848`，11-03 | `171138b6` 上部分通过（漏了一个文件）。`e7e54848` 上通过：写入进程已退出的文件被删，注册表为空。「进程已退出却报错误码 5」这种情况没出现（三个都报 87），那一支只有单元测试 |
| 跳过恢复 smoke 时的 KILL 提示；迟到事件后探针读自己的日志 | `e7e54848`，11-03 | 部分通过。前者在 Windows 上走不到（那里 KILL 一定会跑 smoke）；后者需要的迟到事件在两次懒加载里都没复现。两支都只有单元测试 |
| 新开窗、`connect` 刚完成就发的第一条 Terminal 命令 | `e5d2cda7`，11-04 | 通过，3/3。HTTP 200、rc 0，3.05–3.12 s 返回；第二条也通过。派发前扩展先查了 worker 状态（`list_sessions` 4–6 ms；worker 已在 running，所以没有出现等待提示）。同一检查在 `3765d82a` 上也 2/2 通过，所以这次复测不能说明之前那次卡住已经消除 |
| 开窗后第一条 agent 命令；4 次 agent 运行、最后一次软 Stop；Terminal Stop | `e5d2cda7`，11-04 | 通过。第一条 agent 命令 11.5 s 返回 rc 0。第 1–3 次 14.4–15.7 s 通过；被停的那次恢复了检查点（`restored=true`，没有强制重置），Stop 之前的数据保留。Terminal Stop 第一次点击就停，Stata 进程不变 |
| 开窗后第一条 Terminal 命令，带分段计时（`loadStataOnStartup` 为 `true` 和 `false`，新建和复用的配置目录） | `a1a2832b`，11-04 | 通过，24/24 HTTP 200、rc 0，其中 10 次用的是新建配置目录。每条第一条命令都先等 Stata 加载 16–60 s，之后运行、log path 和首行输出在 0.6 s 内跟上。带同样计时行的旧构建 `3765d82a` 17 次里卡了 1 次（约 120 s 后 HTTP 504）；见[已知限制](#已知限制) |
| 4 条 8 s 命令，第 2 条软 Stop；点一次 Terminal 的 Stop 按钮 | `a1a2832b`，11-04 | 通过。Stop 1.65 s 返回，检查点已恢复，没有强制重置；另外 3 轮的开始和结束行都写进了日志；Stata 进程不变。Terminal Stop 第一次点击就停。面板刚拿到焦点时的第一次 Run 点击没有反应，和之前的 Windows 测试一样 |
| Stata 还在加载时交的命令（worker 被挂起）：按 Stop、超时、重启 | `40abcbea`，11-04 | 通过。等待中按 Stop：以 `PRE_RUN_BACKEND_WARMUP_CANCELLED` 被拒，Stata 日志里什么都没有。超时：300.1 s 后 HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT`，什么都没发出。恢复后下一条命令 46.1 s 返回 rc 0；它的 worker 在启动中失败过，被重启一次、43 s 加载完，命令只执行了一次。没有出现用户可见的 `PRE_RUN_BACKEND_WARMUP_FAILED`（`stataPath` 写错时 Stata 照样加载了）。等待提示出现在 Output 日志里；测试用的输入方式不画 Terminal 面板，所以 Windows 上面板里的文字还没核实 |

macOS Intel 和 Windows Server 2022 在每个 PR 的 CI 上跑离线测试和打包（没有授权的 Stata）。
Windows 10、Windows on ARM 和 Linux 未验证。

PR #15（Stop/KILL 提示与实际结果一致、Windows 进程存活判定、静默探针修复）已在 Windows 上用 `e7e54848` 实机复测
（表中 11-03 各行）。PR #17（`e9b22430`：开窗即加载 Stata、看门狗取消写明自己的停顿、迟到事件跟着自己的任务走）
已在 Windows 上用它的 head `3765d82a`（bundle 与 `e9b22430` 相同；表中标 `3765d82a` 的各行）实机复测。三项修复都成立，但 Stata 刚加载完就发的 Terminal 命令卡过一次。PR #18（`1bf02d02`：Terminal 命令派发前先等 Stata warm-up）
已在 Windows 上用它的 head `e5d2cda7`（源码树相同；表中 11-04 各行）实机复测，见[已知限制](#已知限制)。macOS 在 11-04 用 `v0.2.0-next.5` 发布版（`aba81779`）做了实机复测。
PR #19–#21、#23–#26 在这些测试之后合并进 `main`；合并后的提交在两个平台上都还没有实机复测。

## 已知限制

`main` 上已修复（`e9b22430`，PR #17），并已在 Windows 上用 `3765d82a`（11-03）实机确认，另有注明的除外：

- **Windows：开窗后的第一条命令曾经会把会话锁住（剩下的卡顿由下面的 warm-up 修复处理）。** `stataMcp.loadStataOnStartup: false` 时，Stata 要等第一条命令来了才加载。在 Windows 上，这第一条命令 3 次卡了 2 次，约 120 s 后返回 HTTP 504，会话被锁。启动器现在默认写 `true`，Stata 在开窗时就加载（Windows 11 上 57.7 s）。配置目录里显式写了 `false` 的，问题照样会出现（最后一次在 `3765d82a` 上核过）；启动器保留这个值，`open` 的回包会在 `backendLoad` 里说明。这样的会话被锁后点 **Stata: KILL** 解锁；要避免，就在 `open` 之前把 `profiles/<名字>/user-data/User/settings.json` 里的 `false` 删掉。到目前为止的测试里，macOS 没有这个问题。
- **被取消命令的迟到事件曾经记到别的运行上。** 在 Windows 上，一条取消已报「确认」的命令约 2 s 后照样执行了，它迟到的日志事件被交给了紧接着的那次运行（静默探针）。当时会话是锁住的，没人在错误状态上接着做；PR #15 之后，这种回包报 `EXEC_OUTCOME_UNKNOWN` 并带 `payloadMayHaveRun: true`（已在 Windows 上用 `e7e54848` 实机确认）。PR #17 让事件跟着自己的任务走：一次运行没等到回包就结束后，task id 不明的事件不再交给当前运行，而是暂存或丢弃。暂存区最多 256 条；如果 256 条全是 `log_path` 或 `task_done`，新来的 `task_done` 可能被丢。
- **看门狗取消曾经显示上一次失败的原因。** 在 agent 路径上，看门狗取消之后的状态沿用了之前一次 Terminal 失败的原因和时长。现在每次取消都写自己的 `stallReason` 和 `elapsedMs`，锁定原因写成例如 `EXEC_PRELOG_STALL (IDLE)`。`reasonCode` 本身对各种停顿仍都是 `EXEC_PRELOG_STALL`，因为客户端按它匹配。

`0.2.0-next.5` 之后在 `main` 上修复的，有离线测试和 CI；合并后的提交还没有实机复测：

- **Windows：Stata 加载完后的第一条 Terminal 命令偶尔卡住（W-P1）。** 分段计时（PR #21）找到了卡在哪里。33 次里卡住的那 1 次，worker 里 Stata 自己的启动在 pre-flight 检查之后、到 `stata_setup.config` 结束之间用了 76.6 s（其余 32 次是 3.4–8.6 s）。命令一直在排队，没有丢：旧构建把这段等待算进了命令的 120 s 首条日志预算，在 Stata 就绪前 1.7 s 把它取消了。PR #18 起，命令先在这个预算之外等 Stata 加载完（默认最多 300 s）。带这段等待的构建 24 次 0 次卡住，其中 10 次是新建配置目录。这是统计上限（95% 置信度下卡住率低于约 12.5%），不能证明不会再卡。Stata 启动超过上限时，命令在派发前被拒绝（`PRE_RUN_BACKEND_WARMUP_TIMEOUT`），会话不会被锁。
- **不输出的长命令 60 s 后会被取消**（继承自稳定版）。看门狗现在还把本窗口自己的 Stata worker 用掉的 CPU 时间算作进展（PR #24，rc.7.84）。限制见下面的 CPU 信号一条。
- **后端 connect 完成之前按 Stop 会锁住会话。** 现在只拒绝这条命令，不锁会话（PR #25，rc.7.83）。
- **同时跑的几个 `open` 会在 10 s 后互相超时。** 现在都在短锁里预留、锁外启动（PR #23）。
- **刚开窗时 agent 的提交会被拒**（`BLOCKED_NO_DISPATCH`），而 Terminal 命令会等。现在 agent 也等同一个 warm-up；拒绝结果带 `retryable` 和 `retryAfterMs`（PR #26，rc.7.86）。
- **warm-up 缓存可能信任一个已被换掉的 worker。** 现在缓存记下 worker 的 pid、启动时刻和 transport，用之前再核一次；核对失败或超时就当作没就绪。worker 在启动中挂掉时，Terminal 命令会把它重启一次（PR #20，rc.7.81）。
- **Stata 报错被报成结果不明。** 确认了的报错现在给 agent 返回 `STATA_ERROR_CONFIRMED` 和 Stata 的返回码（`stataRc`），Terminal 路径也报这个返回码，不再是 -1（PR #27，rc.7.85；PR #28 让 mcp-stata 发出返回码）。目前只有源码审查和离线测试，见下面的限制。

当前 `main` 上还没解决的问题：

- **Stata 还在加载时交的命令。** `trueReady` 不等后台加载。Terminal 命令和 agent 的提交都会先等 Stata worker 进入 running；等过 2 s，Terminal 显示「Waiting for Stata to finish loading…」，按 Stop 可以取消等待。等满 300 s 或 warm-up 失败时，命令在发出之前就被拒绝（`PRE_RUN_BACKEND_WARMUP_TIMEOUT` 或 `PRE_RUN_BACKEND_WARMUP_FAILED`，`payloadDispatched=false`）。读不到 worker 状态时照常发送，Terminal 会写明无法确认加载已完成。11-04 在 macOS 上实机确认了等待提示、等待中 Stop（经 `/soft-stop`）、超时和失败拒绝；Windows 上确认了除失败拒绝以外的几项，等待提示只在 Output 日志里核过。
- **Windows 上的 Stata: KILL 会结束本机所有 Stata 图形界面进程**，不只是本会话的。确认之前先保存其他 Stata 窗口里的工作。<!-- PENDING #22: PR #22（rc.7.82）合并后删除或改写本条 -->
- **macOS 的 KILL 和强制重置只按 pid 认后端。** 清理时，登记的 pid 的命令行里含 `mcp-stata` 就结束它，不核对进程启动时刻和父进程。如果这个 pid 正好被别的会话的 `mcp-stata` 复用，有可能被误结束。
- **worker CPU 信号是一种近似。** CPU 在跑不等于在做有用的事：一直空转、不输出的运行，最多能占着会话到日志连续 30 分钟没动静为止。核实不了进程树时（采样期间有 pid 退出、超过 4 层或 16 个进程、父进程对不上），这次采样不算进展，照 60 s 日志规则判断。同一秒内的 pid 复用超出它所核对的启动时刻的精度。目前实机只测了空闲噪声和被冻结的 worker，还没测一条超过 60 s 不输出的命令。
- **Stata 报错的返回码按保守条件确认，还没有实机测过。** 只有同时满足这些条件才算确认：这次运行没被取消（Stop、watchdog、Break、rc 1），日志是这次运行自己的，最后一行 `r(n)` 后面只有回显的命令，完成 marker 没有打印出来，返回码是正整数且等于 mcp-stata 给的 rc。mcp-stata 只有打了运行时补丁（PR #28）才在 `task_done` 里带这个 rc，取自本次运行已经拿到的响应；没打补丁的运行时不带 rc，报错一律确认不了。其他情况 Terminal 路径仍是 rc -1，agent 仍拿到 `EXECUTION_UNCONFIRMED_NO_RETRY`；报错文字里提到 cancel、timeout 或 stall 的也不确认。目前的证据只有源码审查和离线测试。跨模块测试里的 `task_done` 结果是手工构造的，界面部分是桩，所以它不是 MCP 传输测试，也不是端到端测试。这些检查是按 macOS 上的真实日志写的，还没有采到 Windows 的日志。Mac/Windows 的实机验收（报错返回 `STATA_ERROR_CONFIRMED`、`stataRc` 111，下一条命令 rc 0，会话还能继续用）还没做。
- **通用的日志解析器只认普通写法 `r(n);`**，不认 mcp-stata 1.26.1 写的 SMCL 写法 `{search r(111), local:r(111);}`，只有新的报错检查两种都认。报错没被确认时，release 时推断的 rc、Run File 的收尾和 watchdog 的报错检查在这类日志里仍然看不到 rc。
- **重开的会话可能换端口。** 刚 `close` 完，旧端口可能还处于 TIME_WAIT，启动器就换下一个空闲端口。工具按会话名找会话。
- **Windows 派发开销。** 在 Windows 上，每次 agent 提交比 Stata 本身的工作多花约 15 s（派发前检查和回执核验）；一条短命令从头到尾要 17.4 s。20 轮 8 s 命令里，每次提交的固定开销是 12–18 s。
- **启动服务可能要等 PyPI。** 扩展在启动 Stata 服务之前，会先去 PyPI 查一次 `mcp-stata` 的版本。在这个请求会超时的机器上，超时时间会算进第一次启动。
- **内存。** 每个会话都是完整的一份 VS Code 加 Stata。macOS 上 5 个会话 RSS 合计 3852–4000 MB（每个 718–850 MB）。在 16.8 GB 内存的 Windows 机器上，两个空闲会话的工作集分别是 1.93 GB 和 2.16 GB，有负载时每个 2.00–2.39 GB。这种配置的机器开第三个会话前，先看可用内存。
- **工作区信任。** 新工作区要点一次 **Trust**，扩展才会启动。
- **agent 宿主。** Codex 没有针对 `.do` 文件的按文件 deny 规则，见[agent 改 Stata 文件要经人审阅](#agent-改-stata-文件要经人审阅)。
- **继承自稳定版的：** 多行选区里顶层的 `exit` 会结束整个选区，并被报成失败；Data Browser 的 frame 名只在打开浏览器时更新；只用 `graph use` 不会在 Terminal 里生成图卡片；不保证显示的源码和实际执行的字节完全一致。
- 维护的是 `dist/extension.js` 这个 bundle。另有一套参考源码构建，但它和 bundle 的功能是否一致没有确认。

## 排错

| 现象 | 怎么办 |
| --- | --- |
| `open` 返回了 `LAUNCHED`，但 `--status` 连不上 | 窗口处于受限模式。在那个窗口里点一次 **Trust** |
| `SESSION_LIMIT` | 已经有 5 个活会话，先 `close` 一个 |
| `NO_FREE_PORT` | `17601`–`17620` 都被别的 Next 配置目录或别的程序占了 |
| `DISK_RESERVE` | 可用磁盘低于启动器的下限，什么都没建 |
| `RUNTIME_SOURCE_MISSING` | 先建 Stata 服务运行时（见[安装](#安装)），或者传 `--runtime-source` |
| `EXTENSIONS_LINK_MISMATCH` | 配置目录的 `extensions` 链接指向了别的目录。传和上次一样的 `--extensions-dir` |
| `SETTINGS_NOT_PLAIN_JSON` | 配置目录的 `settings.json` 带注释或不是 JSON 对象，启动器什么都没改 |
| `MULTIPLE_SESSIONS` | 有多个活会话。传 `--session <名字>`，或者设 `STATA_WORKBENCH_SESSION` |
| `SESSION_IDENTITY_MISMATCH` | 注册表和 `/status` 对不上（比如窗口重载之后）。重新跑一次 `--status --session <名字>`；什么都没执行 |
| `candidate identity mismatch` | 装好的 VSIX 不是你的克隆钉的那个构建。切到 VSIX 对应的提交 |
| bridge 返回 HTTP 401 或 403 | 请求要带会话 token、`Host: 127.0.0.1:<端口>`，并且不能带 `Origin`。用 agent 工具，它会从注册表读 token |
| 状态栏 **Stata: STALE**，运行返回 HTTP 423 | 点 **Stata: KILL** 并确认。它会强制重置本会话的后端，并自己跑恢复 smoke；Stata 内存里的数据会丢 |
| Windows：开窗后第一条命令返回 HTTP 504（`EXEC_PRELOG_STALL` 或 `EXEC_OUTCOME_UNKNOWN`），会话被锁 | 点 **Stata: KILL** 解锁；在 Windows 上 KILL 还会结束本机所有其他 Stata 图形界面进程 <!-- PENDING #22 -->。命令可能已经执行过，重交之前先看回执。如果配置目录把 `loadStataOnStartup` 设成 `false`，下次 `open` 之前把这一项删掉。见[已知限制](#已知限制) |
| Terminal 显示「Waiting for Stata to finish loading…」 | Stata 还在启动。等它，或者按 Stop 取消；这时什么都还没发出。等满 300 s 命令会以 `PRE_RUN_BACKEND_WARMUP_TIMEOUT` 被拒绝，没有发出 |
| agent 客户端返回 `REFUSED_NOT_DISPATCHED` | 扩展在发出之前拒绝了这次运行。看 `reasonCode`。`retryable` 为 true 时，等 `retryAfterMs` 之后再交；因 Stop 而拒绝的为 false |
| agent 客户端返回 `STATA_ERROR_CONFIRMED` | Stata 执行了这条命令，并以 `stataRc` 报错拒绝。报错文字在回执里。改代码；报错之前的命令可能已经改了数据 |
| `close` 返回 `OPENING` | 这个会话的 `open` 还在进行。等它返回，再跑一次 `close` |
| `close` 返回 `CLOSE_PENDING` | 那个窗口里 VS Code 在问要不要保存修改。先回答它，再跑一次 `close` |
| `No module named 'mcp.server.fastmcp'` | 运行时装成了 MCP 2.x。用约束文件重装 |
| agent 超时或结果不明 | 不要直接重交。先看回执和 `--events`；超时不能证明 Stata 没执行 |

## 配置

启动器往每个会话的配置目录里写这些 VS Code 设置：

| 设置 | 值 | 含义 |
| --- | --- | --- |
| `stataMcp.visibleBridgePort` | 挑中的端口 | bridge 端口（扩展默认 `17601`） |
| `stataMcp.nextSessionName`、`stataMcp.nextProfilePath`、`stataMcp.nextMcpConfigPath` | 由启动器写 | 会话身份，不要手改 |
| `stataMcp.loadStataOnStartup` | 没设过时写 `true` | 开窗时在后台加载 Stata（Windows 11 上 connect 用了 54–66 s；`open` 之后 97–108 s 后端就绪）。`trueReady` 不等它 |
| `update.mode`、`extensions.autoUpdate`、`extensions.autoCheckUpdates` | 没设过时写 `none`、`false`、`false` | 不让测试窗口更新 VS Code 或扩展 |

其他 `stataMcp.*` 设置（`stataPath`、`runFileWorkingDirectory`、`requestTimeoutMs`、
`enableExecuteTimeout`、`maxOutputLines` 等）和稳定版用法相同。

环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `STATA_WORKBENCH_NEXT_HOME` | `~/.stata-workbench-next` | 状态目录：配置目录、注册表、运行记录、扩展 |
| `STATA_WORKBENCH_SESSION` | — | agent 工具要用的会话名或 id |
| `STATA_WORKBENCH_AGENT_NAME` | `agent` | 显示在 agent 的 Terminal 卡片和事件流里的名字 |
| `STATA_WORKBENCH_RUNTIME_SOURCE` | 本机运行时（见[安装](#安装)） | `open` 复制给新会话的运行时 |
| `STATA_WORKBENCH_CODE` | 标准位置的 VS Code | 要启动的 VS Code |
| `STATA_WORKBENCH_TIMING_FILE` | — | 诊断用：扩展把 `[wb-timing]` 行同时追加写进这个文件 |

**Stata Workbench** 输出频道里，Terminal 命令在首行输出之前的每一步各有一行 `[wb-timing] {…}`
（入口、warm-up、工具调用、log path、首行输出）。这些行只有固定字段：时刻、id、状态、错误类型或代码，
不写代码、输出和错误消息。它们是同步写的，有一点 I/O 开销。mcp-stata 内部的计时不属于产品：
`scripts/stata_timing_patch.js` 只给一份新建的一次性运行时副本插桩，供人工诊断用。

## 开发

```sh
npm ci --ignore-scripts
npm run check -- --keep-going
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run package` 一步跑完全部检查并生成 `stata-workbench-next-<版本>.vsix`。CI 在 macOS 15
（Apple Silicon 和 Intel）和 Windows Server 2022 上跑这些步骤，不需要 Stata、图形界面或凭据，另外还跑一套
参考源码构建。图片语料测试在私有语料里没有 `.do` 文件时跳过，另外还在仓库里的一小套合成语料上跑；
pre-flight 补丁测试只接受未打补丁或恰好打过一次补丁的本机运行时。

对 bundle 的修改都写成 `scripts/` 里可读的补丁脚本，作用在维护的 `dist/extension.js` 上。
后加的补丁都能撤回，并在 `scripts/later_bundle_patches.js` 和 `scripts/patch_manager.js` 里登记。
改了 bundle 之后，要刷新 `release/runtime-manifest.json` 和 `tools/verified_workbench.py` 里钉的
`BUNDLE_SHA256`；把补丁重放两次，得到的字节必须相同。

更多：[需要授权机器才能做的检查](docs/next/LIVE-CHECKS.md)、
[跨平台说明](docs/CROSS_PLATFORM.md)、
[共享执行与并发](docs/shared-execution-and-concurrency.md)、
[发布维护](docs/RELEASE.md)和[更新日志](CHANGELOG.md)。

## 许可

AGPL-3.0-or-later。派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)。
与 [hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp) 的设计比较在 [NOTICE](NOTICE) 里致谢，
这并不表示两者的运行时可以互换。见 [LICENSE](LICENSE) 和 [SECURITY.md](SECURITY.md)。

不包含 Stata、Stata 授权、凭据或数据。bridge 只监听 `127.0.0.1`，不是远程服务，也不是多用户服务。
