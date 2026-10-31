# 需要实机才能证明的点（Next）

本页只列离线测试证明不了、必须在装了 Stata 的 Mac 或 Windows 上跑的检查。由 codex-astra（Mac）
和经 xdev 派的 Windows 任务完成。每条完成后在「结果」列写日期、平台、证据路径。
全部用 Next 的隔离配置目录、合成 `.do`、17601–17620 端口；不碰 17485 和研究目录。

| # | 来自 | 检查 | 怎么判通过 | 结果 |
|---|---|---|---|---|
| L1 | A6 第 15 条 | `code --user-data-dir <新目录> --extensions-dir <共用目录> --new-window` 在 macOS 和 Windows 上是否起独立进程 | 两个配置目录各开一个窗口后，按进程数窗口，每个进程恰好 1 个窗口 | |
| L2 | A6 第 16 条 | 配置目录里只有 Next 一个 Stata 类扩展时 bridge 正常起在 17601 | `/status` 200，`bridgePort` 17601 | |
| L3 | A1 | Next VSIX 装进隔离配置目录后，未设端口时 bridge 监听 17601、不监听 17485 | `lsof`/`Get-NetTCPConnection` 只见 17601 | |
