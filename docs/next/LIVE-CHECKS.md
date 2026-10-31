# 需要实机才能证明的点（Next）

本页只列离线测试证明不了、必须在装了 Stata 的 Mac 或 Windows 上跑的检查。由 codex-astra（Mac）
和经 xdev 派的 Windows 任务完成。每条完成后在「结果」列写日期、平台、证据路径。
全部用 Next 的隔离配置目录、合成 `.do`、17601–17620 端口；不碰 17485 和研究目录。

| # | 来自 | 检查 | 怎么判通过 | 结果 |
|---|---|---|---|---|
| L1 | A6 第 15 条 | `code --user-data-dir <新目录> --extensions-dir <共用目录> --new-window` 在 macOS 和 Windows 上是否起独立进程 | 两个配置目录各开一个窗口后，按进程数窗口，每个进程恰好 1 个窗口 | |
| L2 | A6 第 16 条 | 配置目录里只有 Next 一个 Stata 类扩展时 bridge 正常起在 17601 | `/status` 200，`bridgePort` 17601 | |
| L3 | A1 | Next VSIX 装进隔离配置目录后，未设端口时 bridge 监听 17601、不监听 17485 | `lsof`/`Get-NetTCPConnection` 只见 17601 | |
| L4 | B | `shared_stata.py --agent-name claude --code 'display 1'`：Terminal 这次运行的卡片上方出现 `claude · <runId>`，runId 与回执里的 `runId` 相同 | 截图 + 回执 | |
| L5 | B | 人按 Run File、在 Terminal 输入命令：卡片上方是 `You · <runId>` | 截图 | |
| L6 | B | agent 长命令运行中人按 Run File：弹出的提示写明 `claude is running Stata (<runId>)` 并提到 Stop；`/events` 里有一条 `run-refused`，`busyRunId` 是 agent 那次 | 截图 + `/events` JSON | |
| L7 | B | 一次 agent 运行、一次人的运行、一次 soft Stop 之后，`events.jsonl` 每次运行恰好一条 `run-start` 和一条 `run-end`（Stop 那次另有至多一条 `run-end-update`），seq 连续；`--events 0` 与文件内容一致 | 文件 + 命令输出 | |
| L8 | B | 把 `next_session_core.js` 暂时改名后重载窗口：扩展照常激活、能跑代码，`/status.nextSession.error` 有原因，`/events` 回 503；改回后恢复 | `/status` JSON | |
