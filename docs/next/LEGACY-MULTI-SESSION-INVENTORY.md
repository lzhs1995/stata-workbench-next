# 旧 Windows 多会话方案盘点：搬不搬（Next A6）

2026-10-31。对象是 2026-05/06 在 Windows 上做成、但没有并入跨平台仓库的多会话方案。
来源：

- 旧方案说明：`Stata_Workbench_协作执行与补丁说明.md`（私有只读归档
  `handoff/claude-takeover-20261028-v1/legacy-windows-20261030/archive/开题报告/`，带 MANIFEST.json），
  行号以 `:NNNN` 记。本盘点只读了它的摘录（经 handoff `saio-review-20261031/B-CLAUDER-MULTI.md` 第 6–7 节），
  没有读四个 ps1 的源码，那些脚本不在本仓库。
- 仓库侧登记：[`docs/LEGACY_WINDOWS.md`](../LEGACY_WINDOWS.md) 第 42–43 行（「每命名会话一窗口 + sessions.json」记为
  Replaced；多会话登记与看门狗记为 Open）。
- 当年的实测：17485/17486/17487/17488 四实例，2026-06-11 小门禁 18/18 PASS（`:5078-5106`），
  3/6/12 图并发压力通过（`:4848-4850`、`:4884`），global 宏互不串、两实例 sleep 真重叠（`:4646-4647`）。
  当年自己的口径：完整 70 格 Phase5 矩阵仍是发布级门禁，没有闭环（`:4596`）。

Next 的会话模型（计划第 2 节）：一个 VS Code 窗口 = 一个 Stata Terminal = 一个 Stata；第二个会话用
独立 `--user-data-dir` 启动，`--extensions-dir` 共用，由 `stata_session.py open <名字>` 一步建好；
测试端口 17601–17620。下表的「搬」都按这个模型落地，不照搬 PowerShell 实现。

## 机制逐条

| # | 旧机制 | 旧做法（出处） | 搬不搬 | 理由 / Next 落点 |
|---|---|---|---|---|
| 1 | 会话注册表 | `%USERPROFILE%\.stata-workbench\sessions.json`，**一个文件存全部会话**（`:4588`） | 搬，改形 | 改成一会话一文件 `~/.stata-workbench-next/sessions/<sessionId>.json`（照 ClaudeR `~/.claude_r_sessions/<name>.json`）。单文件多条并发写要全局锁，一处写坏会连累别的会话；一文件一会话只需原子改名。阶段 D |
| 2 | token 文件 | `tokens\<session>.token`，与注册表分开（`:4588`） | 搬，合并 | token 写进该会话自己的注册表文件（0600 / 仅当前用户），不另设目录。阶段 C 先建文件、阶段 D 补全字段 |
| 3 | `X-Stata-Workbench-Token` 头 + 401 | helper 注入，bundle 校验（`:4588`、`:4590`） | 搬，改头 | 改用标准 `Authorization: Bearer <token>`，并加 Host 校验、拒绝带 Origin 的请求（旧方案没有这两条）。阶段 C |
| 4 | 默认会话无 token 时不强制 | 「默认零破坏」（`:4590`） | **不搬** | 这是为兼容旧客户端留的口子。Next 是独立扩展，没有要兼容的旧客户端；所有会话都必须带 token |
| 5 | 端口分配 | 无参时自动 agent-a/b/c…，也可 `agent-x 17490` 显式指定（`:4588`、`:4598`） | 搬 | 自动取 17601–17620 里下一个空闲端口；显式指定也支持。阶段 D |
| 6 | 显式端口被占时明确失败 | 「不得静默换端口后仍声称绑定到 17490」，实测 `Port 17490 is already in use`（`:4598`、`:4600`） | 搬 | 原样保留这条规则。现有 bundle 对占用端口是同端口有限次重试后放弃（`scripts/bridge_rebind_core.js`），没有明确报错，阶段 D 改 |
| 7 | 新窗口用独立 `--user-data-dir`、共用 `--extensions-dir` | `open_stata_vscode_session.ps1`（`:4588`） | 搬 | 就是 Next 的会话模型。跨平台改写成 `tools/stata_session.py`（Python），不再走 cmd → vbs → ps1 三层 |
| 8 | 用环境变量把端口、会话名、token 路径注入扩展 | `MCP_STATA_BRIDGE_PORT`、`MCP_STATA_SESSION_NAME`、`MCP_STATA_TOKEN_PATH`（`:4588`） | 改做法 | 改为启动器把端口和会话名写进该配置目录的 `settings.json`，扩展从设置读。环境变量经 VS Code CLI、已在运行的主进程转发时不可靠，且难以事后核查；settings.json 可直接打开看 |
| 9 | 每会话独立 temp/log/audit/graph 根 | 「避免证据互相覆盖」（`:4588`） | 搬 | 阶段 D：全部放在该会话目录下，checkpoint 和事件流也在内 |
| 10 | port-only 调用写进旧 audit 路径 | 坑：按端口调用时 audit 落到 legacy 路径；修法是先解析 `resolvedSessionName`（`:4600`） | 搬（作规则） | 资源目录一律由注册表里的 sessionId 推出，不由端口推算 |
| 11 | 复用判断只看 PID | 坑 D9：PID 被 pwsh 等进程复用，误判为活（`:4596`） | 搬（作规则） | 存活以 `/status` 回显的 sessionId、端口、generation 与注册表一致为准；PID 只用来确认「已死」，探测不到或无权限一律不判死（照 ClaudeR 三态 pid） |
| 12 | 从 live `/status` 重建丢失的注册表条目 | `stata_bridge_common.ps1`，理由是冷启动时进程树会重新挂接（`:4867`） | 搬，加约束 | 允许，但重建时必须用注册表之外的凭据核对 token（否则任何监听端口的进程都能冒充会话）。阶段 D 设计时定 |
| 13 | FIFO 队列 | 显式 `queueMode:"fifo"` 时排队，默认仍 busy-409（`:4590`）；实测「同一 Workbench 两个 AgentId FIFO」（`:5102`） | **暂不搬** | Next 先保持一个会话一次一个请求、忙时 409 的现有语义（计划第 3 节 B 只加明确提示）。多 agent 共用一个会话的排队等真有需求再做；排队会让人以为自己的 Run 已提交 |
| 14 | `X-Agent-Id` 可见标记 | bundle 把 agent id 显示在 Terminal（`:4590`） | 搬 | 阶段 B：bridge 读请求里的 agent 名，Terminal 抬头 `[agent名 · runId]`，人的运行 `[你 · runId]` |
| 15 | 非 default 会话改用 hosted keep-alive 启动 | 短生命周期 `Code.exe` stub 会让会话掉线（`:4592`） | 实测后定 | 跨平台启动器在阶段 A（codex-astra 实机）先测 macOS 和 Windows 上 `code --user-data-dir … --new-window` 的进程寿命 |
| 16 | 另一个未打补丁的 Stata 扩展抢先加载 | 导致 17485/17486 两个 bridge 一起消失（`:4592`） | 搬（作规则） | 每个 Next 配置目录只装 Next 一个 Stata 扩展；启动器启动前列出 extensions-dir 里的 Stata 类扩展，有别的就拒绝 |
| 17 | 多会话健康看门狗 | `multi_workbench_watchdog.ps1`（LEGACY_WINDOWS.md 第 43 行 Open） | **不搬** | 常驻看门狗会自己去重启会话，人看不到原因。Next 改为客户端每次提交前核对身份，`stata_session.py list` 按需报告陈旧条目 |
| 18 | 多实例并发出图只路由 1/3 | 4 实例 Run File + graph export 时 Graph 面板只收到部分图（`:4811-4812`），后在 v7.385 修了 PNG 导出卡死（`:4936`） | 搬（作验收） | 阶段 F 的多会话验收加图形压力：每会话 3/6 张命名图，核每张都到了本会话的面板和目录，没有串到别的会话 |
| 19 | 验收口径比 `ok:true` 严 | 每会话同时满足多条（`:4816`）；§63.3 五条出图规则（`:4870-4884`） | 搬 | 阶段 F 每条结果都记 commit、bundle SHA、配置目录、端口、sessionId、日志路径 |
| 20 | 8 个 helper 统一 `-SessionName/-Port` 参数面 | Phase 3（`:4590`） | 改做法 | 只保留一个客户端 `tools/shared_stata.py`，加 `--session` 和 `--list-sessions`；有多个会话又没指定时报 `MULTIPLE_SESSIONS`、不执行代码 |
| 21 | hanlulong 对照栈 | 另一个 Stata 扩展的对照实现（LEGACY_WINDOWS.md「Not needed」） | 不搬 | 与多会话无关 |

## 没有出处、需要实机才能定的点

- 第 15 条：独立 `--user-data-dir` 的 VS Code 窗口在 macOS 上会不会被已在运行的主进程接管成同一进程。
  如果会，「每进程 1 个窗口」的窗口门禁就不成立，计划第 2 节的前提要重测。写进 [LIVE-CHECKS](LIVE-CHECKS.md)。
- 每个配置目录的 mcp-stata 运行时能否共用一份（上次测得一份约 523 MB）。阶段 A，codex-astra 实测。
- 授权：用户 2026-10-31 确认 StataMP 授权允许同时 10 个实例；Next 默认上限 5 个。
