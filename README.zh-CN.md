# Stata Workbench Shared Session

[English](README.md) | [中文](README.zh-CN.md)

这是一个 VS Code 扩展：人和 AI agent 轮流使用同一个可见的 Stata 会话。双方的代码
都送到同一个 backend，所以数据、宏、scalar、结果和图形是共享的。

## 这是什么

- 编辑器里：**Run Current File**、**Run Selection/Current Line**、Stata Terminal、
  Stata Graphs 面板和 Data Browser。
- 给 agent 用：`tools/shared_stata.py` 经本机 HTTP bridge 向正在运行的会话发送一条
  命令或一个已保存的 `.do` 文件，并写一份私有回执。
- 同一个 backend 的提交逐个执行。人和 agent 轮流操作；自动运行进行中时不要在编辑器里输入。
- 共享内存不是持久存储。重置、重启或关闭 VS Code 之前，把数据和结果存到磁盘。
- 不包含 Stata、Stata 许可、凭据或数据。bridge 只监听本机回环地址，不是远程或多用户服务。

派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)
（AGPL-3.0-or-later），见[许可证](#许可证)。

### 版本

| 版本 | 状态 | 平台证据 |
| --- | --- | --- |
| `v0.1.3-rc.7.44` | Pre-release，准备中，尚未发布 | macOS 和 Windows，见[平台状态](#平台状态) |
| [`v0.1.3-rc.7.39-public.2`](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.39-public.2) | 已发布的最新 pre-release（2026-09-09） | 仅 macOS |

本文档对应 `v0.1.3-rc.7.44`。下面的测量来自候选版 `0.1.3-rc.7.44-dev.5` 到
`dev.8`，每条结果都写明是哪个候选版。

### 文档

- [跨平台开发与配置](docs/CROSS_PLATFORM.md)
- [Windows 实机验收手册](docs/WINDOWS_ACCEPTANCE.md)
- [能力与证据台账](SYNC.md)、[验收范围](docs/ACCEPTANCE.md)
- [macOS 权限](docs/MAC_PERMISSIONS.md)、[故障排查](docs/TROUBLESHOOTING.md)
- [共享执行与并发](docs/shared-execution-and-concurrency.md)
- [共享会话交付经验](docs/shared-session-delivery-lessons.md)、
  [研究交接与归档经验](docs/empirical-review-and-archive.md)
- [发布维护](docs/RELEASE.md)、[更新日志](CHANGELOG.md)
- [中文使用指南](docs/USAGE.zh-CN.md)

## 平台状态

同一个 VSIX 用于 macOS 和 Windows。候选版在 macOS 和 Windows CI 上打出的包，运行时
文件逐字节相同，只有随包文档的换行符不同。

| 平台 | 测试环境 | 结果 |
| --- | --- | --- |
| macOS，Apple Silicon | macOS 26.5 arm64、StataNow、VS Code 1.139.1、隔离 profile | dev.8：冷启动首次运行 14.1 秒，Data Browser 显示当前 frame，soft Stop 提示文案通过。更早的 `0.1.3-rc.7.39` 通过 FULL45（45 个场景 / 632 步） |
| macOS，Intel | 只有 CI（macOS 15 Intel） | 离线测试与打包；没有用授权 Stata 实跑 |
| Windows 11 x64 | Windows 11 家庭中文版 24H2（build 26100）、Stata 18 MP、VS Code 1.121.0、Windows PowerShell 5.1、隔离 profile | 验收手册第 1–10 步通过（dev.5–dev.6，见下）。dev.7 默认服务约束通过。dev.8：冷启动首次运行 25.2 秒，Data Browser frame 和 soft Stop 通过 |
| Windows，默认安装路线 | 同一台机器，空的 `uv` 缓存 | 带 `mcp<2` 时服务装好并能导入；不带时 `uv` 解析到 MCP 2.x，服务导入失败 |
| Windows Server 2022 x64 | 只有 CI | 离线测试、真实文件锁、进程匹配、PowerShell 5.1/7 入口；没有授权 Stata |
| Windows 10、Windows on ARM、Linux | — | 未验证 |

### Windows 测试步骤

来自 [Windows 验收手册](docs/WINDOWS_ACCEPTANCE.md)，只用合成数据。第 1–8 步在
dev.5 上通过。第 9 步在 dev.5 上失败（backend 冷启动超出 60 秒的运行前预算），修复后
在 dev.6 上通过。第 10 步在 dev.6 上做。第 1–8 步没有在 dev.6–dev.8 上重跑。

| 步骤 | 检查内容 |
| --- | --- |
| 1 | Run Current File：rc 0，6 行 / 4 个变量，CSV/DTA/GPH 和两张 800×480 PNG，GPH 可重新载入 |
| 2 | Terminal 里点图形缩略图 → **Open**：Stata Graphs 载入图片，执行计数不变 |
| 3 | Data Browser：6 行 / 4 个变量，Unicode 标签保留 |
| 4 | agent 客户端：一次 POST，零重试，共享 scalar 40 → 42 |
| 5 | Run Selection 在同一 backend 上读到 42 |
| 6 | 第一个客户端忙时提交第二个：等第一个释放后才派发，各一次 POST |
| 7 | 运行中点 Stop：任务和传输排空，没有硬重置，backend 不变 |
| 8 | 清理客户端：每项清理 rc 0，恢复原来的空 `default` frame |
| 9 | Reload Window 后第一次运行，backend 冷启动 |
| 10 | 空闲时锁屏/解锁并取消一次 UAC 弹窗：backend、扩展宿主和计数都不变 |

## 系统要求

| 项目 | 要求 |
| --- | --- |
| VS Code | 1.75 或更新（测试版本：macOS 1.139.1，Windows 1.121.0） |
| Stata | 本机已授权的安装（测试：macOS 上 StataNow，Windows 上 Stata 18 MP） |
| `uv` / `uvx` | 用来启动 `mcp-stata` 服务（`mcp-stata` 1.26.1，`mcp<2`） |
| Python 3 | 只有 `tools/` 里的 agent 和诊断工具需要。Windows 上用已安装的 `python.exe`，不要用 Microsoft Store 的别名 |
| macOS 权限 | 运行 agent 工具的宿主需要「系统事件」自动化和辅助功能权限，见 [macOS 权限](docs/MAC_PERMISSIONS.md) |

## 安装

从 [v0.1.3-rc.7.44 发布页](https://github.com/lzhs1995/stata-workbench-shared-session/releases/tag/v0.1.3-rc.7.44)
下载 `stata-workbench-shared-session-0.1.3-rc.7.44.vsix` 和 `SHA256SUMS`，放在同一个
文件夹。VSIX 的 SHA256 是 `@@RC744_VSIX_SHA256@@`。安装前先核对（见[验证下载文件](#验证下载文件)）。

下面的命令装进一个单独、可识别的 profile，agent 工具按这个 profile 和端口找到会话。
只在编辑器里用的话，在平常的 VS Code 里执行 **Extensions: Install from VSIX...** 就够了。

### macOS

```sh
export STATA_WORKBENCH_PROFILE="$HOME/.stata-workbench-shared"
export STATA_WORKBENCH_PORT=17485
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  --user-data-dir "$STATA_WORKBENCH_PROFILE/user-data" \
  --extensions-dir "$STATA_WORKBENCH_PROFILE/extensions" \
  --install-extension ./stata-workbench-shared-session-0.1.3-rc.7.44.vsix
```

在这个 profile 里把 `stataMcp.stataPath` 设为已授权的 Stata 可执行文件。

### Windows

在 PowerShell 里：

```powershell
$env:STATA_WORKBENCH_PROFILE = Join-Path $HOME '.stata-workbench-shared'
$env:STATA_WORKBENCH_PORT = '17485'
code --user-data-dir "$env:STATA_WORKBENCH_PROFILE\user-data" `
  --extensions-dir "$env:STATA_WORKBENCH_PROFILE\extensions" `
  --install-extension .\stata-workbench-shared-session-0.1.3-rc.7.44.vsix
```

`code` 就是 VS Code 的 `bin\code.cmd`；不在 `PATH` 里时见[故障排查](#故障排查)。把
`stataMcp.stataPath` 设为已授权的可执行文件，例如 `C:\Program Files\Stata18\StataMP-64.exe`。
用 `$env:` 设的变量只在当前 PowerShell 窗口有效。

Windows 上的测试用的是[验收工具](docs/WINDOWS_ACCEPTANCE.md)建的私有 profile 和 17497
端口，不是上面的默认 profile。

### agent 工具

agent 和诊断工具在本仓库里，不在 VSIX 里。按发布 tag 克隆，工具钉住的版本才和装好的
VSIX 一致：

```sh
git clone https://github.com/lzhs1995/stata-workbench-shared-session.git
cd stata-workbench-shared-session
git checkout v0.1.3-rc.7.44
python3 -B tools/verified_workbench.py --doctor
```

Windows 上把 `python3` 换成 `python`。`--doctor` 输出 JSON（系统与架构、Python、VS Code、
profile 和端口、Stata 候选路径、已安装和正在运行的身份），不会启动 VS Code 或 Stata。

## 快速开始

先设好同样的 `STATA_WORKBENCH_PROFILE` 和 `STATA_WORKBENCH_PORT`：

1. 只在 macOS 上做一次：在将要运行 agent 的宿主里执行
   `python3 -B tools/verified_workbench.py --request-permissions`，在系统弹窗里允许。
2. 用示例工作区打开这个 profile：
   `python3 tools/verified_workbench.py --open --workspace "$PWD/examples/minimal-workspace"`。
   `--open` 复用同一个 profile，没有时只启动一次。
3. 还没设 `stataMcp.stataPath` 的话现在设。
4. 执行 **Stata: Open Interactive Terminal**，打开 `smoke.do`，执行
   **Stata: Run Current File**。Terminal 打印 `STATA_WORKBENCH_SMOKE_OK`。

打开或重载后的第一次运行还要启动 Stata 服务。dev.8 的测试机上分别用了 14.1 秒（macOS）
和 25.2 秒（Windows）。等它跑完，不要重复提交。

### 共享会话

在 Stata Terminal 里执行 `scalar public_shared_demo = 40`，等它就绪。在设了同样
profile 和端口的 shell 里：

```sh
python3 tools/shared_stata.py --code 'scalar public_shared_demo = public_shared_demo + 2' --cwd "$PWD"
```

回到 Terminal，`display public_shared_demo` 显示 42。最后执行
`scalar drop public_shared_demo`。这个名字已经被你的工作占用时换一个。

## 使用

| 要做的事 | 怎么做 |
| --- | --- |
| 运行整份 `.do` 文件 | **Stata: Run Current File**（`Ctrl+Shift+D`，macOS `Cmd+Shift+D`） |
| 运行选中内容或当前行 | **Stata: Run Selection/Current Line**（`Ctrl+Shift+Enter`，macOS `Cmd+Shift+Enter`） |
| 打开 Terminal | **Stata: Open Interactive Terminal**（`Ctrl+Shift+C`，macOS `Cmd+Shift+C`） |
| 预览已保存的图 | 在 Terminal 里点缩略图，再点 **Open**。Stata Graphs 显示这个文件，不会再跑一次 Stata |
| 浏览数据 | Terminal 里的 **Data Browser** 按钮，或 **Stata: View Data** |
| 停止运行 | Terminal 里的 **Stop** |
| 让 agent 运行代码 | `tools/shared_stata.py`，见下 |

运行快捷键在 `.do`、`.ado`、`.mata` 文件（或 Stata 语言文件）获得焦点时生效。

- **图形。** 点开的预览会用这一张图替换当前显示的这批图；其他导出文件仍可从 Terminal 里的
  链接和磁盘上找到。没有打开 Graphs 面板时，自动出图的批次让 Terminal 保持可见。
- **Data Browser。** 显示行、变量和当前 frame（例如 `wb_platform`）。frame 名在浏览器打开时读取。
- **Stop。** soft Stop 取消当前运行、排空任务，backend 不变。Terminal 会显示例如
  `human-file cancelled by soft Stop (generation 1)`，`/status` 报
  `resetGenerationKind: "soft-stop"`。下一次运行前先确认会话重新就绪。

### agent 客户端

```sh
python3 tools/shared_stata.py --code 'display 1+1' --cwd /absolute/workspace
python3 tools/shared_stata.py --file analysis.do --cwd /absolute/workspace --busy-policy wait --max-wait 60
```

- 每次调用一次 POST，不自动重试。超时或结果不明不能证明 Stata 没有执行；再提交前先查回执和会话。
- 遇到 bundle 或监听方不对、重复的启动器、会话忙或在恢复、backend 变了，都会拒绝。
  `--busy-policy wait` 只在提交前等待，最多 `--max-wait` 秒。
- 它从不启动、激活、重置或重试 Stata。
- 退出码 0 表示结论 `PASS_VISIBLE_SHARED_RUN`：执行和身份检查通过；不证明有人同时看着源码和
  Terminal。其他结果退出码为 2。
- 每次调用把请求、响应、实际提交的 `.do` 字节和运行日志写进 `.stata-receipts/`
  （或 `--receipt-dir`）。里面有你的代码和输出，不要提交到仓库。
- `.do` 路径可以含中文、空格和撇号；路径里有 Stata 宏分隔符、双引号或控制字符会被拒绝。
- Windows 上 `scripts/invoke_stata_visible_safe.ps1` 包装的是同一个客户端。它原来的
  `AllowHttp500Retry`、`BusyPolicy reset`、`SmokeAfterReset` 模式现在在派发前就失败。

## 配置

VS Code 设置：

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `stataMcp.stataPath` | 空 | 本机 Stata 可执行文件的路径 |
| `stataMcp.visibleBridgePort` | `17485` | 本机 bridge 端口（`/status`、`/run-command`、`/soft-stop`），必须与 `STATA_WORKBENCH_PORT` 相同 |
| `stataMcp.runFileWorkingDirectory` | 空 | Run File 的工作目录，可用绝对路径、`~`、`${workspaceFolder}`、`${fileDir}` |
| `stataMcp.loadStataOnStartup` | `false` | VS Code 启动时启动 Stata |
| `stataMcp.requestTimeoutMs` | `100000` | 元数据和界面请求的超时 |
| `stataMcp.enableExecuteTimeout` | `false` | 给执行命令设超时；为长研究脚本默认关闭 |
| `stataMcp.maxOutputLines` | `2000` | Terminal 保留的行数 |
| `stataMcp.autoRevealOutput` | `false` | 运行后显示输出通道 |
| `stataMcp.showAllLogsInOutput` | `false` | 把 `mcp-stata` 原始日志全部写进输出通道 |
| `stataMcp.logStataCode` | `false` | 记录发给 backend 的 Stata 代码 |
| `stataMcp.autoConfigureMcp` | `false` | 在宿主的 MCP 配置里添加或更新 `mcp-stata` |
| `stataMcp.restoreFinalSnapshotAfterGraphRouting` | `false` | Run File 图形路由后恢复 do 文件结束时的数据快照 |

工具的环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `STATA_WORKBENCH_PROFILE` | `~/.stata-workbench-shared` | 隔离 profile 的根目录 |
| `STATA_WORKBENCH_PORT` | `17485` | 必须与 `stataMcp.visibleBridgePort` 相同 |
| `STATA_WORKBENCH_CODE` | 标准位置的 VS Code | macOS 是 app 的 CLI；Windows 是 `Code.exe`，或会被解析到 `Code.exe` 的 `code.cmd`/`code.bat` |
| `STATA_WORKBENCH_PYTHON` | — | Windows PowerShell 包装脚本使用的 Python |

端口被占用时工具会拒绝，这不是去关别的编辑器的理由。另选一个空闲的
`stataMcp.visibleBridgePort`，并把 `STATA_WORKBENCH_PORT` 设成同一个值。

## 验证下载文件

用同一个发布页的 `SHA256SUMS` 核对文件哈希。

macOS：

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Windows PowerShell：

```powershell
$f = 'stata-workbench-shared-session-0.1.3-rc.7.44.vsix'
$expected = (Select-String -Path SHA256SUMS -SimpleMatch $f).Line.Split(' ')[0]
(Get-FileHash $f -Algorithm SHA256).Hash.ToLower() -eq $expected
```

最后一行必须输出 `True`。然后在按发布 tag 克隆的仓库里，用发布身份清单核对 VSIX 内容：

```sh
python3 tools/verify_release.py --vsix /path/to/stata-workbench-shared-session-0.1.3-rc.7.44.vsix
```

包版本和每个钉住的运行时文件都一致时，它输出含 `"verdict": "PASS"` 的 JSON。这只核对运行时身份，
不是实机验收。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 第一次运行很慢 | 打开或重载后的第一次运行还要启动 Stata 服务。等它，不要重复提交 |
| Terminal 长时间显示忙 | 先查 bridge 状态（`python3 tools/verified_workbench.py --status`）再运行别的代码；不要再排一个长任务 |
| 长脚本卡住或超时 | 先核对原请求、原始日志和输出。超时不能证明 Stata 没有执行。见[存储与日志恢复](docs/storage-and-log-recovery.md) |
| 端口已被占用 | 别的编辑器占着。另选空闲的 `stataMcp.visibleBridgePort`，`STATA_WORKBENCH_PORT` 设成同一个值 |
| 图形不出现 | 给图命名；多个未命名的图会互相覆盖唯一的 `Graph` 窗口 |
| Windows：`code` 装不上 VSIX | 运行 `Get-Command code` 和 `code --version`；把 `PATH` 改成指向 VS Code 的 `bin\code.cmd`，或用 **Extensions: Install from VSIX...** |
| macOS：错误 `-1743` 或找不到窗口 | 在与 agent 相同的宿主里运行 `--doctor`，再运行一次 `--request-permissions`。见 [macOS 权限](docs/MAC_PERMISSIONS.md) |
| `No module named 'mcp.server.fastmcp'` | 服务装成了 MCP 2.x。默认路线会加 `mcp<2`；自定义的服务命令也要加这个约束 |

更多情况见[故障排查](docs/TROUBLESHOOTING.md)和[桌面恢复记录](docs/desktop-auth-terminal-recovery.md)。

## 已知限制

- Windows 10、Windows on ARM 和 Linux 未验证。macOS Intel 只有 CI。
- 上一次完整的授权测试集（FULL45）是在 `0.1.3-rc.7.39` 上通过的。`rc.7.44` 候选版做的是
  [平台状态](#平台状态)里列出的有限检查，没有新跑 FULL45。
- 测试中的界面操作用的是 DevTools 自动化点击，不是人工按键。
- Windows 锁屏/解锁和 UAC 这一步，依据是 Winlogon 事件和会话状态未变；没有实时录屏，取消 UAC
  的情况来自操作者本人的报告。
- macOS 上 VS Code 窗口被隐藏时，Terminal 文字可能要到运行结束才出现。
- 一个 backend 一次只跑一个请求。多个实例需要各自的 profile 和端口；没有通用的多实例调度。
- Data Browser 的 frame 名在浏览器打开时更新，之后再 `frame change` 不会跟着变。面板较窄时
  FILTER 一行文字会重叠。
- 单独的 `graph use` 不会在 Terminal 里生成图形卡片。
- 不保证显示的源码与实际执行的字节完全一致。
- `dist/extension.js` 是维护中的 bundle。另有一个参考源码构建，但它与 bundle 的功能等价尚未证明。
- 远程桌面、所有 Stata 版本，以及测试过的路径以外的长路径，都未认证。

## 版本历史

日期为 UTC。详情见[更新日志](CHANGELOG.md)。

| Tag | 日期 | 类型 | 范围 |
| --- | --- | --- | --- |
| `v0.1.3-rc.7.44` | @@RC744_DATE@@ | Pre-release | macOS 和 Windows：Windows 适配层与验收工具、backend 冷启动不计入运行前预算、默认服务保持在 MCP 1.x、连上后再查取消、Stop 提示文案、Data Browser frame、已保存图形预览、递归 DO 引用扫描 |
| `v0.1.3-rc.7.39-public.2` | 2026-09-09 | Pre-release | macOS 权限诊断（Mac tools 1.1.0）；运行时不变 |
| `v0.1.3-rc.7.39-public.1` | 2026-09-07 | Pre-release | 对 Mac 验收过的 `0.1.3-rc.7.39` 做公开打包；去掉本机维护 token |
| `docs-2026.09.26` | 2026-09-26 | 文档 | 只有文档；运行时不变 |
| `v0.1.1` | 2026-05-19 | 正式版 | 教学示例和安装文档 |
| `v0.1.0` | 2026-05-19 | 正式版 | 首个公开预发版本 |

GitHub 把 `v0.1.1` 标为「Latest」，因为之后的版本都是 pre-release。

## 许可证

AGPL-3.0-or-later。派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)。
与 [hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp) 的设计对比在 [NOTICE](NOTICE)
里致谢，不表示两者运行时可以互换。见 [LICENSE](LICENSE) 和 [SECURITY.md](SECURITY.md)。

发布渠道是 GitHub Releases。较早的 Open VSX 条目不是这个运行时，Visual Studio Marketplace
上也没有发布。

### 开发

```sh
npm ci --ignore-scripts
npm run check
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run check` 只读，并有运行时摘要守卫。`check:legacy` 是旧的会改写文件的流程，不要对已封存的
候选版运行。打包用的是带版本的维护 bundle、可读补丁和界面源码，不是从上游 TypeScript 干净重建。
CI 在 macOS ARM、macOS Intel 和 Windows Server 2022 上运行，没有 Stata、图形界面或私有凭据。
改了运行时就需要新版本和新的授权验收，见[发布维护](docs/RELEASE.md)。
