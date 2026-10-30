# 人与 AI 共享 Stata 会话使用指南

窗口允许遮挡/隐藏及多实例的边界，见[共享执行与并发指南](shared-execution-and-concurrency.md)。
同一 backend 内提交仍串行；本次经验更新不改变公共客户端或要求重启现役实例。

## 打开和人工使用

通过 VS Code 的「Extensions: Install from VSIX...」安装 Release 下载的 VSIX。
设置 `stataMcp.stataPath`，执行「Stata: Open Interactive Terminal」。
需要 AI 接入时，按 [完整安装命令](QUICKSTART.md) 使用独立 profile。

打开 `.do` 文件，用「Stata: Run Current File」运行整份文件，或用
「Stata: Run Selection/Current Line」运行选中内容。结果在 Stata Terminal，
图在 Stata Graphs。清除显示不等于清除数据；长任务结束前不要重复提交。

## AI 接入

首次接入或遇到 `-1743`（macOS）：在报错 agent 的同一宿主运行
`python3 -B tools/verified_workbench.py --doctor`，再按诊断运行一次
`python3 -B tools/verified_workbench.py --request-permissions`。系统弹窗需本人允许。
`--request-permissions` 是 macOS 的系统授权查询；Windows 上用已安装的 `python.exe`
运行 `--doctor`，Windows 安装步骤见 README 的[安装](../README.zh-CN.md#安装)。
权限失败现在显示未知窗口数 `null`，不再冒充“窗口数为 0”。
[完整权限说明：自动化空列表、辅助功能、持久性与系统故障](MAC_PERMISSIONS.md)。

AI 必须使用同一 profile、同一端口的 `tools/shared_stata.py`，不另起隐藏 Stata。
`tools/verified_workbench.py --status` 只检查，`--open` 复用现有窗口。
[快速开始](QUICKSTART.md) 提供人工创建 40、AI 改为 42、人工读取并清理的例子。

共享同一 backend 的数据、宏、scalar 和结果，不是两份内存同步。人和 AI
轮流操作；busy、恢复未完成、实例不唯一或身份不符时工具会拒绝。
`.stata-receipts/` 回执含代码和日志，保持私有。

## 停止与恢复

先用界面停止功能，检查是否完整恢复、是否重新 ready。不要把部分恢复当成功。
未确认的执行不自动重试，先查日志避免重复写入。不要以重启、clear all 或
强制删文件作为默认修复。重要结果必须保存到磁盘，关闭应用后不保证恢复内存。

## 验收范围

`0.1.3-rc.7.39` 在一台已授权的 Mac 上有 FULL45 45/45、632/632 和共享 backend 的记录。
公开包已移除本机 token，包哈希不同，运行时 bundle 相同。
`0.1.3-rc.7.44` 的候选版在 macOS 26.5 arm64 和 Windows 11 x64（Stata 18 MP）上做了有限的
实机检查，没有新跑 FULL45；Windows 10、Windows on ARM 和 Linux 未验证。各平台测到哪一步见
README 的[平台状态](../README.zh-CN.md#平台状态)，详见 [验收说明](ACCEPTANCE.md)。

## 旧 DO 修订与图形验收

保留作者文件名、变量名、段落、运算顺序和编码习惯；在改动旁用 `***`、`//` 或 `/* ... */` 说明原行为、修改理由与影响，分清仅审阅注释和实际执行修订。默认同时展示源码和 Stata Terminal；用户已允许遮挡或隐藏时沿用该约定，物理可见性单列。同一 backend 串行，离线审阅可并行；未知请求沿原 requestId/runId 核收，不能重发。

候选验证须核实际 config、command、runtime 与加载宿主；独立 profile 本身不足以隔离共享配置或 runtime。未明确启用的 Claude/Codex 配置不应改写，显式配置失败不应回落其他环境，并核前后限定范围哨兵。

图形验收使用隔离小样例，完整解码并实看 PNG，实际重载 GPH 后再导出，绑定同次请求、源码和日志。主体 rc、每项清理 rc、恢复原 frame 及日志关闭分别记录；失败不能被清理或成功标记覆盖。关闭日志后的标记取自同次 Terminal。SVG 转 PNG 通过只证明该转换路线。

候选源码检查、最终包内容、安装、实际加载、原生验收分别报告；未跑项仍是未跑，文档或打包通过不代表现役插件已修复。详见[共享执行与交付经验](shared-session-delivery-lessons.md)。
