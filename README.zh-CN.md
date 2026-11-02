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

当前版本：`0.2.0-next.5`（见 `package.json`）。只通过 GitHub Releases 分发，不发布到 Open VSX
或 Visual Studio Marketplace。

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

1. **VSIX 和工具要来自同一个提交。** 克隆本仓库，切到你要装的 VSIX 对应的提交或 tag。
   工具钉了 bundle 的 SHA-256，遇到别的构建一律拒绝。自己打 VSIX 见[开发](#开发)。
2. **把 VSIX 装进 Next 共用的扩展目录。** 启动器把每个会话的 `extensions` 目录链接到
   `~/.stata-workbench-next/extensions-shared`，所以要装在这里，不要装进日常用的 VS Code 配置。
3. **建 Stata 服务运行时**，放在扩展和启动器最先查找的位置。同一台机器上已经装过稳定版的话，
   这份运行时一般已经有了；启动器只读它，给每个会话复制一份。

### macOS

```sh
git clone https://github.com/lzhs1995/stata-workbench-next.git
cd stata-workbench-next   # 切到你的 VSIX 对应的提交

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
VS Code 窗口。它马上返回 `LAUNCHED`：不等 bridge、不激活窗口、不发任何 Stata 命令。不给
`--workspace` 时，会话用自己那个空的 `profiles/s1/workspace`。

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

`--session` 接受会话名或会话 id（也可以设 `STATA_WORKBENCH_SESSION`）。只有一个活会话时可以省略，
有多个时必须给。

**5. 关会话。**

```sh
python3 -B tools/stata_session.py close s1
```

`close` 只请这个会话的 VS Code 窗口自己退出（macOS 发 SIGTERM，Windows 用不带 `/F` 的
`taskkill`），从不强杀。VS Code 在问要不要保存未保存的修改时，返回 `CLOSE_PENDING`（退出码 2），
窗口和文件都保持原样。其他会话照常运行。

agent 客户端的其他选项：`--list-sessions` 打印注册表；`--events 0` 打印会话事件流
（谁跑了什么、Stop、被拒、改稿提议），不运行代码。

## 功能

### 人和 agent 共用一个看得见的会话

- 编辑器命令和稳定版一样：**Run Current File**（`Ctrl+Shift+D`，macOS `Cmd+Shift+D`）、**Run Selection/Current Line**（`Ctrl+Shift+Enter` / `Cmd+Shift+Enter`）、**Open Interactive Terminal**（`Ctrl+Shift+C` / `Cmd+Shift+C`）、**View Data**、Stata Graphs 面板和 Data Browser。
- Terminal 里每次运行的卡片都标明来源：人是 `You · <runId>`，agent 是 `<agent 名> · <runId>`。runId 和 agent 回执里的一致。
- 一个后端同一时间只跑一个请求。agent 在跑时人按 Run，VS Code 提示 `<agent> is running Stata (<runId>). Wait for it to finish, or press Stop in the Stata Terminal.`，这次被拒也会记进事件流。
- 每个会话有一份只追加的事件日志（`~/.stata-workbench-next/runs/<sessionId>/events.jsonl`），可以用 `shared_stata.py --events 0` 读。

### 多会话

- `tools/stata_session.py` 最多管理 **5** 个活会话。第 6 个 `open` 返回 `SESSION_LIMIT`，什么都不建。
- 每个会话有自己的配置目录、端口（`17601`–`17620`）、Stata 服务运行时、临时目录、运行前快照和执行锁。会话之间并行运行：两个 agent 可以同时往两个会话提交，谁也不用等谁。
- 有多个活会话时，agent 客户端不带 `--session` 就拒绝提交（`MULTIPLE_SESSIONS`，退出码 2），什么都不执行。
- 重开同名会话时沿用原来的端口。配置目录里已经显式设过的值保持不动。

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
- 点状态栏的 **Stata: KILL** 解锁：确认一次后，它强制重置本会话自己的后端，再跑经过核验的恢复 smoke（一条固定的 marker 命令，必须 rc 0 且日志里有 marker）。确认即表示接受丢失 Stata 内存里的数据。
- 执行看门狗会取消没有日志进展的普通运行：第一行日志出现前 120 s 没动静，或出现后 60 s 没动静（识别为长任务的运行分别是 300 s 和 30 分钟）。运行前检查点会被恢复，但看门狗取消之后会话一律锁住，要点 **Stata: KILL** 才能继续。

## 平台实测结果

所有实机测试都用隔离的 Next 配置目录、合成的 `.do` 文件和 `17601`–`17620` 端口，没有用到研究数据。
界面操作（Stop、Trust、KILL）通过 VS Code DevTools 协议驱动，不是真人按键。日期为 2026 年、台北时间。
构建指 `main` 的提交：`579b0fe9` 和 `171138b6` 都是 `0.2.0-next.5`，`8d63cb45` 是 `0.2.0-next.4`。

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

### Windows（Windows 11 x64，Stata 18 MP，VS Code 1.144.0）

| 检查 | 构建、日期 | 结果 |
| --- | --- | --- |
| 新配置目录关闭 VS Code 和扩展的自动更新 | `171138b6`，11-02 | 通过 |
| agent 改稿审阅：接受、拒绝、审阅期间被改 | `171138b6`，11-02 | 通过 |
| 拒绝：PID 被复用、token 错、端口被占、陈旧记录 | `171138b6`，11-02 | 通过，什么都没发 |
| 双会话：两个 agent 同时提交、一边忙一边提交、Stop 其中一个、互不串、`MULTIPLE_SESSIONS` | `579b0fe9`，11-02 | 通过。两次运行重叠 40.5 s；读回分别是 `owner=w3a N=111` 和 `owner=w3b N=222` |
| 人的长命令在 Terminal 里按 Stop，两次 | `579b0fe9`，11-02 | 通过，2/2：第一次点击就停，Stata 进程不变，数据保留 |
| 从 Terminal 停掉 agent 运行 | `579b0fe9`，11-02 | 通过。运行前检查点已恢复（`restored=true`），读回 N=77 |
| 运行前检查点被移走后按 Stop | `579b0fe9`，11-02 | 通过。会话锁住（`snapshot-expected-not-restored`） |
| 看门狗取消一条静默的 agent 命令 | `579b0fe9`，11-02 | 部分通过。运行前检查点已恢复，但取消升级成了强制重置，状态里报的是上一次失败的原因（见[已知限制](#已知限制)） |
| 开窗后的第一条命令，`loadStataOnStartup=false` | `579b0fe9`，11-02 | 失败：120 s 后 HTTP 504，会话锁住 |
| 开窗后的第一条命令，`loadStataOnStartup=true` | `579b0fe9`，11-02 | 通过。开窗时 Stata 在后台加载，用了 57.7 s；之后第一条命令 6.1 s 完成，rc 0 |
| `close` 清理残留的临时注册表文件 | `171138b6` / `579b0fe9`，11-02 | `171138b6` 上部分通过，漏了一个文件；PR #15 已修，尚未实机复测 |

macOS Intel 和 Windows Server 2022 在每个 PR 的 CI 上跑离线测试和打包（没有授权的 Stata）。
Windows 10、Windows on ARM 和 Linux 未验证。

`main` 现在已包含 PR #15（Stop/KILL 提示与实际结果一致、Windows 进程存活判定、静默探针修复）。
这些测试在 macOS 和 Windows 的 CI 上都通过，但还没有实机复测。

## 已知限制

当前 `main` 上还没解决的问题：

- **Windows：开窗后的第一条命令可能把会话锁住。** 启动器写的是 `stataMcp.loadStataOnStartup: false`，Stata 要等第一条命令来了才加载。在 Windows 上，这第一条命令会一直卡到 120 s 的首日志门限，返回 HTTP 504（`EXEC_PRELOG_STALL`），会话被锁。*修复发布之前的办法：* 点 **Stata: KILL** 解锁；或者在 `open` 之前，在 `profiles/<名字>/user-data/User/settings.json` 里写 `"stataMcp.loadStataOnStartup": true`。启动器不会覆盖你设的值，Stata 会在开窗时后台加载（测试机上约 1 分钟）。把默认值改成 `true` 的修复正在做。到目前为止的测试里，macOS 没有这个问题。
- **取消显示「已确认」，命令不一定没跑。** 在 Windows 上，看门狗取消一条命令、取消也报了已确认之后，那条命令约 2 s 后照样执行了，它迟到的日志事件还被算到了下一次运行头上。这种情况下会话是锁住的，不会有人在错误状态上接着做。PR #15 之后，如果取消发生在第一行日志之前，回包报 `EXEC_OUTCOME_UNKNOWN`（代码可能已经运行）。根本的修复是按任务而不是按「当前在跑的那次」来归属事件，正在做。
- **看门狗取消一律锁会话，原因可能是旧的。** 在 Windows 上，看门狗取消之后的状态沿用了上一次失败的原因和时长（`EXEC_PRELOG_STALL`），而不是这次取消自己的。修复正在做。要继续用，点 **Stata: KILL**。
- **长时间不输出的命令。** 60 s 不写日志的命令（比如 `bootstrap … nodots`）会被当作卡死而取消。这条规则继承自稳定版。长命令请加进度输出。
- **Windows 派发开销。** 在 Windows 上，每次 agent 提交比 Stata 本身的工作多花约 15 s（派发前检查和回执核验）；一条短命令从头到尾要 17.4 s。
- **启动服务可能要等 PyPI。** 扩展在启动 Stata 服务之前，会先去 PyPI 查一次 `mcp-stata` 的版本。在这个请求会超时的机器上，超时时间会算进第一次启动。
- **内存。** 每个会话都是完整的一份 VS Code 加 Stata。macOS 上 5 个会话 RSS 合计 3852–4000 MB（每个 718–850 MB）。在 16.8 GB 内存的 Windows 机器上，两个空闲会话的工作集分别是 1.93 GB 和 2.16 GB。这种配置的机器开第三个会话前，先看可用内存。
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
| Windows：第一条命令返回 HTTP 504 `EXEC_PRELOG_STALL` | 见[已知限制](#已知限制)第一条 |
| `close` 返回 `CLOSE_PENDING` | 那个窗口里 VS Code 在问要不要保存修改。先回答它，再跑一次 `close` |
| `No module named 'mcp.server.fastmcp'` | 运行时装成了 MCP 2.x。用约束文件重装 |
| agent 超时或结果不明 | 不要直接重交。先看回执和 `--events`；超时不能证明 Stata 没执行 |

## 配置

启动器往每个会话的配置目录里写这些 VS Code 设置：

| 设置 | 值 | 含义 |
| --- | --- | --- |
| `stataMcp.visibleBridgePort` | 挑中的端口 | bridge 端口（扩展默认 `17601`） |
| `stataMcp.nextSessionName`、`stataMcp.nextProfilePath`、`stataMcp.nextMcpConfigPath` | 由启动器写 | 会话身份，不要手改 |
| `stataMcp.loadStataOnStartup` | 没设过时写 `false` | 开窗时加载 Stata |
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

## 开发

```sh
npm ci --ignore-scripts
npm run check -- --keep-going
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run package` 生成 `stata-workbench-next-<版本>.vsix`。CI 在 macOS 15（Apple Silicon 和 Intel）
和 Windows Server 2022 上跑这些步骤，不需要 Stata、图形界面或凭据，另外还跑一套参考源码构建。
在本地，`scripts/mac/test_png_compat_unit.js`（依赖私有图片语料）和
`scripts/test_stata_preflight_timeout_patch.js`（依赖本机装好的运行时）要用到特定机器上的文件，
在维护者的 Mac 上是已知失败；在 CI 上通过。

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
