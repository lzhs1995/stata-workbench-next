> Historical document: current public release instructions and scope are in [QUICKSTART](QUICKSTART.md), [ACCEPTANCE](ACCEPTANCE.md) and [RELEASE](RELEASE.md). Older platform/version claims below do not certify the current version.

# Stata Workbench Shared Session — Mac 维护手册

本文件是历史 Windows 维护说明的 Mac 对应版；通用维护流程见 [MAINTENANCE](MAINTENANCE.md)。
面向后续接手的 Claude Code / Codex / 人类操作者。

## rc.7.10.33 transport log 与内部 graph noise（2026-08-04）

- 共享 source adapter 在临时执行代码中仅替换精确的 `capture log close _all` / `log close _all`，避免研究代码关闭 Terminal 依赖的 transport log。命名 log 保持原语义，研究 `.do` 文件不落盘修改。
- `mcp-stata` 内部 no-capture graph fallback 使用 `capture quietly`，保留 `_rc` 判定但不再把内部 `could not find Graph window` 写入可见日志。用户显式输入的 graph 错误仍必须可见。
- 验收必须同时包含 source adapter 单元门禁、pinned uvx runtime 实际补丁状态、新 VSIX SHA 与受影响长任务的 fresh rerun。

## rc.7.10.31 双窗口 bridge ownership race（2026-08-04）

macOS 在 reopen 时可能恢复两个 VS Code 窗口并并行激活两个 Extension Host。旧逻辑中，先启动但最终退出的 host 可先占用 bridge 端口；存活 host 收到一次 `EADDRINUSE` 后不会重试，导致退出窗口释放端口后 `17525` 仍长期离线。

- 只有 `EADDRINUSE` 使用有界退避重试：`250, 500, 1000, 2000, 4000, 5000, 5000, 5000 ms`。
- 其他 listen 错误立即失败，不能用重试隐藏配置或权限问题。
- Extension Host dispose 必须取消待执行 timer；已释放 host 不得在稍后重新抢占端口。
- `/status.bridgeBind` 公开 `phase`、attempt/retry 计数、最近错误和绑定时间，供 reopen 门禁绑定当前 owner 取证。
- 验收必须制造两个 rc70 窗口的真实 ownership race，终止初始 owner，并证明存活 host 在退避窗口内最终绑定 `127.0.0.1:17525`；单窗口 reload 成功不能替代该门禁。

## rc.6.4.4 Terminal 双层防回归门禁（2026-08-02）

`0.1.3-rc.6.4.4` 恢复 template-safe SMCL fallback v2，并新增两类资源门禁：

- `npm run check` 要求 `src/ui-shared` 与 `dist/ui-shared` 各 8 个资源完整、非空，直拷资源字节一致，真实 `main.js` 包含 `smclToHtml` / `parseSMCL` / `processSyntaxHighlighting`。
- `npm run package` 在 VSIX 生成后再次读取归档，核对同一组 16 个资源，避免 `.vscodeignore` 或打包配置回归。
- `/status.terminalWebview.fallbackActive` 与 `fallbackVersion` 区分真实 shared UI 和降级路径；正常包必须为 `false` / `null`。
- fallback v2 marker 为 `codex-smcl-fallback-v2-template-safe`，22 项语义测试包含真实中文 SMCL 样本。

## rc.6.4.3 Terminal 内联脚本语法门禁（2026-08-02）

`0.1.3-rc.6.4.3` 修复 Terminal HTML 模板内 fallback 对象多余的闭合括号。该错误不会被 `node --check dist/extension.js` 发现，因为内联脚本位于模板字符串中；现在 `npm run check` 会抽取该脚本并用 JavaScript 解析器单独校验。外部脚本也统一携带当前 CSP nonce。

## rc.6.4.2 Terminal 冷升级恢复边界（2026-08-02）

`0.1.3-rc.6.4.2` 修复保留旧 `Stata Terminal` 标签升级扩展后，serializer 继续引用旧 bundle 资源 URI，导致外部 CSS/JS 不加载的问题。

- 激活时必须先设置当前 `extensionUri`，再注册 `stataTerminal` serializer。
- serializer 必须把当前 URI 传给 `restorePanel`；恢复时重设 `enableScripts`、`localResourceRoots` 并无条件重建 HTML。
- `/status.terminalWebview` 必须同时报告 `scriptReady=true` 与 `styleReady=true` 才能判定 Terminal 资源完整。只看到面板或原生 HTML 控件不算通过。
- macOS 验收必须保留旧标签、完整退出隔离 VS Code、在同一 profile 强制升级，再由 serializer 恢复；新开面板不能替代该门禁。
- Windows 验收继续暂停，直到 macOS 冷升级门禁通过并生成最终同一 VSIX SHA。

## rc.6.4.1 控制面边界（2026-08-02）

`0.1.3-rc.6.4.1` 把停止后的恢复收敛为四态控制面：`normal`、`busy`、`not-ready`、`recovery-required`。

- `POST /recovery-smoke` 是唯一恢复豁免入口。调用方不能提供 Stata 代码；端点内部生成 generation/token/marker，并要求当前 runId、transport 成功、`rc=0`、日志中存在独立 marker 输出行后才清门。
- 普通 `/run-command`、Terminal、selection 和 Run File 在 `recovery-required` 下必须快速返回/回执 `423`，不得排队或挂起。
- `POST /graph-clear` 与图面板 `Clear All` 只清 UI 快照，不得清 `postRunBusy`、不得写 readiness，也不得通过空快照 hydrate 把 stale 改成 ready。
- `/status` 公开 `recovery`、`backendOwnerId`、`ownedBackendPids`，但不公开内部 token/marker。
- force-reset 只清理由当前 Extension Host 登记的 backend PID。Darwin 只走 `scripts/mac/cleanup.sh --force --pid <pid>`；PowerShell 只在 `win32` 分支执行。
- `/run-command` 的 visible-bridge watchdog 必须设置 `acceptGraphCompletionMarkerAsDone:false`。代码准备阶段生成的 graph completion marker 不是 Stata 已执行完成的证据；静默长任务必须等真实 transport/do-file 完成后才能释放 HTTP 和 single-flight 状态。
- Darwin cleanup 必须通过 `scripts/mac/test_cleanup_unit.js` 的真进程门禁；不能只信脚本退出码。验收还要用 `ps -p <oldPid>` 证明旧 owner PID 已消失，再允许新 backend 启动。
- repo 静态门禁：`npm run check`。它不等于 Windows 真机验收。

独立冷装使用新 profile 和新端口，不复用当前 17485/17495。完整步骤见 `docs/RC64_COLD_INSTALL_CHECKLIST.md`。

> **维护结构决策（重要）**：本项目 **不拆成 Mac / Windows 两套独立分支**，而是
> **单一代码库（`dist/extension.js` 一份）+ OS 适配层**。真正与操作系统相关的差异只有三类，
> 全部靠 `process.platform` 或独立脚本目录隔离，核心业务逻辑永远只维护一份：
>
> 1. **路径**：Windows 硬编码盘符（`C:\Users\<user>\...`）→ Mac 家目录 / `/var/folders/...` 临时目录。
> 2. **运维脚本**：`scripts/*.ps1` / `*.cmd`（Windows）↔ 未来的 `scripts/mac/*.sh`（Mac）。
> 3. **打包完整性**：见下方“§0 终端乱码根因”。这是本手册创建的直接原因。
>
> 上游 `tmonk/stata-workbench` 和 `hanlulong/stata-mcp`“提供 Mac/Windows 两套版本”，
> 本质也是同一份 TS/Python 逻辑 + 各自的启动脚本 / 二进制，不是两条并行的业务代码。
> 一个人长期维护，拆两套 = 每个 bug 修两遍 + 两边漂移，是维护灾难。**结论：单库 + 适配层。**

---

## §0.5 乱码复发定案（2026-07-25）——「老毛病又犯」的真正机制根因

**别再重查渲染器了。** 2026-07-25 用户再报终端乱码。全盘静态 + live 自证复核结论如下（全部实测）：

- 已装 `0.1.1` 目录里 `dist/ui-shared/main.js`（33400 字节，真 `smclToHtml`）**在**、`src/ui-shared/*` 全套**在**、`node --check` 全过。
- 把**真实密集 SMCL 日志**（真 Stata `regress`/`summarize` 落盘 log，含 `{col}{space}{c |}{hline}{res}{txt}`）分别喂进 main.js 真解析器**和** fallback stub 解析器 → **两条路都零泄漏，完美渲染**。
- live 触发一次真运行后桥 `lastClientError=None`（webview 渲染没抛错）。
- 当前 VS Code（Jul 25 01:47 启）与终端面板（Jul 25 04:19 建）都晚于修复（main.js Jul 23 21:27）。

**推论**：当前磁盘态逻辑上不可能产生标记乱码 → 用户那张截图是 **reload 生效前**、内存里旧 webview 的旧状态（正是 §0 末尾那句「生效需 Reload Window，扩展已在内存」的坑再现）。

**机制性根因（这才是「反复犯」的原因，必须根治）**：

- **`stata-workbench-shared-session-0.1.1.vsix` 包内根本没有 `ui-shared/` 目录，只有 `dist/extension.js`。**
- 任何一次「从 0.1.1.vsix 重装」→ `ui-shared/main.js` 消失 → webview 走 fallback → （修复前的旧 stub 无 `smclToHtml`）→ 乱码。
- 也就是说：只要还留着那个缺 ui-shared 的 vsix 当安装源，乱码就会周期性复发，跟渲染器代码无关。

**根治（2026-07-25 已完成）——金包 `0.1.2-gold`**：

- 从当前 **live 黄金目录**（三补丁全在 + 真 ui-shared 齐全）直接重打包，产出
  `stata-workbench-shared-session-0.1.2-gold.vsix`（repo 根目录，2.56 MB，version=0.1.2）。
- 金包内容核验：`dist/extension.js` = **5431818 字节**（三 marker 齐：`stata-workbench-visible` /
  `codex-display-only-clear-v6-cleanup-v9-postrun-busy` / `codex-smcl-fallback-v1`）+
  `dist/ui-shared/main.js`（sha256 `eb11a74c…1ae91cf4`）+ 全 `src/ui-shared/*`。
- **祸根/过时包已改名加警示**（防误装）：
  - `0.1.1.vsix` → `DO-NOT-INSTALL_0.1.1_NO-UISHARED_causes-garble.vsix.bak`
  - `0.1.2-uishared-fix.vsix`（extension.js 是 5429031 原版，缺 visible-bridge/fallback 两补丁）→
    `SUPERSEDED_0.1.2-uishared-fix_use-gold-instead.vsix.bak`
- **以后唯一合法安装源 = `0.1.2-gold.vsix`。** 它同时带齐「可见通道补丁 + 真 ui-shared + fallback 双保险」，
  重装不再回退到乱码态。

> ⚠️ 关键区分：`0.1.2-gold`（5431818，三补丁，唯一可用）≠ `0.1.2-uishared-fix`（5429031，缺可见通道补丁，已弃）。
> 装错后者会补上 ui-shared 治乱码，但丢掉压力测试依赖的 visible-bridge 补丁。认字节数 / marker，别只认版本号。

历史金包完整性自检（把 `/path/to/stata-workbench-shared-session` 换成自己的仓库根目录）：

```bash
V="/path/to/stata-workbench-shared-session/stata-workbench-shared-session-0.1.2-gold.vsix"
unzip -p "$V" extension/dist/ui-shared/main.js | shasum -a 256   # 期望 eb11a74c…1ae91cf4
unzip -l "$V" | grep -E 'ui-shared|extension.js'                  # 应见 dist/extension.js 5431818 + 全 ui-shared
```

（生效仍需装完 `Developer: Reload Window` 或重启 VS Code——扩展在激活时载入内存。）

---

## §0 终端乱码根因（2026-07-23 定位并修复）

### 现象

Mac 上迁移后：**Stata Graphs 面板正常出图，但 Stata Terminal 满屏乱码**
（原始 SMCL 控制标记 `{txt}{res}{com}{hline}{c S|}` 被原样吐出，样式全崩）。

一度怀疑是 Mac/Windows 编码兼容问题。**实测证伪**：

- do 文件是 UTF-8（字节 `e5bc80...` 正确解出“开题报告”），源文件编码没问题。
- Stata 写盘的 log 是干净 UTF-8（`e7bc96...` 正确解出“编码探测中文测试”），Stata 输出编码没问题。
- 中文本身没坏，坏的是 SMCL 控制标记没被渲染成可读文本。

### 真根因：打包漏文件（不是编码、不是 OS 兼容）

webview 终端渲染依赖外部脚本 **`dist/ui-shared/main.js`**，其中才有真正的
`smclToHtml`（SMCL→HTML 渲染器）。这个文件（以及 `src/ui-shared/design.css`、
`highlight.css`、`highlight.min.js`、`mark.min.js`、`autocomplete.js`）
**在装好的扩展目录、在 git 仓库、在 `0.1.0` / `0.1.1` 两个 vsix 里全部缺失**。

`extension.js` 里只有一个 **fallback stub**，注释明写
`if the shared UI script fails to load, provide minimal helpers`，
但这个 stub 只实现了 `escapeHtml` / `formatDuration` / `bindArtifactEvents`，
**独漏 `smclToHtml`**。于是终端渲染时 `stataUI.smclToHtml(...)` 抛异常 → 原始 SMCL 泄漏 → 乱码。

- **图为什么好**：graph panel 走 `extension.js` 内置 inline-snapshot 逻辑，不依赖 `ui-shared/main.js`。
- **Windows 为什么没事**：那边装的是 tmonk 原版就地打补丁，tmonk 自带完整 `ui-shared`；
  重打包成 Mac 这个 vsix 时把整个 `ui-shared` 漏掉了。

### 已落地的止血修复（stopgap，patch marker `codex-smcl-fallback-v1`）

在 `dist/extension.js` 的 fallback stub 里注入一个**自包含的 `smclToHtml`**
（不依赖任何缺失外部文件），实现它注释里承诺的“让终端仍能工作”。

- 处理标记：`{txt}{res}{com}{err}{inp}` 等纯样式标记丢弃；`{hline N}` 横线；
  `{c xxx}` 特殊字符（盒线 / 数字字符码）；`{cmd:X}` `{help X:Y}` 等带内容指令保留可见文本；
  `\n`→`<br>`；HTML 转义。
- 单元测试 22/22 通过（含真实乱码样本 `{res}{txt}编码探测中文测试`）。
- `node --check` 通过，锚点唯一。
- 备份：`dist/extension.js.codex-smcl-fallback-backup-<stamp>`。
- **生效需 VS Code `Developer: Reload Window` 或重启**（扩展在激活时载入内存）。

验证补丁是否还在：

```bash
node --check "$HOME/.vscode/extensions/lzhs1995.stata-workbench-shared-session-0.1.1/dist/extension.js"
grep -c "codex-smcl-fallback-v1" "$HOME/.vscode/extensions/lzhs1995.stata-workbench-shared-session-0.1.1/dist/extension.js"
```

### 长期真修（2026-07-23 已完成）

止血补丁只解决“终端乱码”，语法高亮 / design.css 样式 / autocomplete 仍缺（那些资产整体缺失）。
**已做根治：把完整 `ui-shared` 资产从上游取回并重打包进 vsix。**

来源与版本：

- 上游 `tmonk/stata-workbench`（默认分支 = `v1.1.1`）浅克隆到 `/tmp/tmonk-probe`。
- 上游 `src/ui-shared/main.js` 里有真 `smclToHtml`（1 处定义 + 7 处调用），
  暴露的 `window.stataUI` 方法（`escapeHtml` / `formatDuration` / `bindArtifactEvents` /
  `processSyntaxHighlighting` / `smclToHtml`）与已装 `extension.js` 的 11 处调用**逐一匹配**，
  接口兼容，可直接落地。

落地的资产（已同时写入 **已装扩展目录** 和 **git 仓库**）：

| 目标路径 | 来源 | 处理方式 |
|---|---|---|
| `dist/ui-shared/main.js` | 上游 `src/ui-shared/main.js` | 直拷（0 import/export，standalone，等价 esbuild 产物）|
| `dist/ui-shared/data-browser.js` | 上游 `src/ui-shared/data-browser.js` | **需 esbuild bundle**（含 `apache-arrow` / `@sentry/browser` import，直拷会抛错）|
| `src/ui-shared/{design.css,highlight.css,highlight.min.js,mark.min.js,autocomplete.js,data-browser.css}` | 上游同名 | 直拷 |

`data-browser.js` 的 bundle 命令（仅此文件需要）：

```bash
node_modules/.bin/esbuild src/ui-shared/data-browser.js \
  --bundle --format=iife --platform=browser \
  --outfile=dist/ui-shared/data-browser.js
```

重打包结果：

- 新 vsix：`stata-workbench-shared-session-0.1.2-uishared-fix.vsix`（在 repo 根目录，2.6 MB）。
- 打包命令：`bunx @vscode/vsce package --no-dependencies`
  （`--no-dependencies`：依赖已内联进 `dist/extension.js`，repo 无 node_modules）。
- 解包核验：vsix 内含 `extension/dist/ui-shared/main.js`（33400 字节，`smclToHtml` 定义数 = 1）+
  全部 `extension/src/ui-shared/*`，`extension/dist/extension.js` = 5429031 字节（Mac 补丁血统，
  `__codexUriFile`×8 / `force-reset`×5，**不是** `codex-macos-v1` 旧血统）。

要点 / 坑：

1. **不要用上游 `extension.js` 覆盖已装的**——已装版是 Mac 打补丁血统（loader 改成 `__codexUriFile`），
   覆盖会丢掉全部 Mac 适配。真修只补 `ui-shared` 资产，`extension.js` 一字不动。
2. `.vscodeignore` 不排除 `ui-shared`（真因一直是源目录里没这些文件，不是被 ignore）。
3. 真 `main.js` 到位后，`window.stataUI` 由它提供，§0 的 fallback stub 变成**无害的双保险**
   （真 main.js 加载成功即优先，stub 不再触发）；保留即可，无需移除。

生效仍需 VS Code `Developer: Reload Window` 或重装新 vsix。

---

## §1 Mac 桥（bridge）连接信息

- 地址：`http://127.0.0.1:17485`
- patch marker（rc.6.4 运行时）：`codex-rc64-control-plane`
- 端点：
  - `GET  /status`         查状态（POST 会 404）
  - `POST /run-command`    同步 HTTP 执行（无 token）
  - `POST /debug-run-file` native 执行（**唯一把 log 实时流进 Stata Terminal 的通道**）
  - `POST /force-reset`    强恢复
  - `POST /recovery-smoke` 内部生成代码并验证落盘 marker 的专用恢复入口
  - `GET  /graph-status`   图面板状态

Token must be obtained from the local installation, never from this repository:

- For authenticated maintenance endpoints, use the selected local session's configured token through `STATA_BRIDGE_TOKEN` in its local maintenance environment.
- Never paste the token value into documentation, commits or public reports. Removing a literal from this document does not remove historical commits or released archives.
- `/run-command` 无 token 鉴权。

---

## §2 两条执行通道的取舍（Mac 已验证）

| 通道 | log 流进终端 | 图进面板 | 大文件 | 备注 |
|------|:---:|:---:|:---:|------|
| `POST /run-command`（HTTP 同步） | ❌ | ✅（post-run 路由命名图） | ✅ | 会提前返回假 rc:0，Stata 仍在跑 |
| `POST /debug-run-file?path=...&disk=0` | ✅ | 需另跑 replay | ✅ | **`disk=0` 跳过 inline-snapshot 预扫描**，大文件不卡 |

**关键**：`/debug-run-file` 默认 `preparedMode: inline-snapshot` 会预扫全文件（万行级会卡死）。
加 **`&disk=0`** 直接从磁盘执行，log 实时流入终端，整文件跑完。（`disk=1` 与默认都会在 prepare 阶段卡。）

**真假完成判据（golden signal，绝不说谎）**：
真跑 = 快速非量化返回 + route/SVG 增长 + 引擎 CPU-TIME 爬升；
假卡 = 量化的 8.0/14.0/28.0s 台阶 + route 冻结 + CPU-TIME 冻结。
native prepare 阶段跑在**扩展宿主进程（Code Helper）**，不是 python worker——盯 worker CPU 会误判卡死。

---

## §3 图导出：Mac 用 SVG/PDF，别用 PNG

Mac 上 raster **PNG 导出路径会挂 0 字节**（`graph export ... .png width()` 60s+ 卡死）；
vector **SVG / PDF 路径健康**。规避方案（已端到端验证）：

1. Stata 里导 **SVG 或 PDF**。
2. 再用 Mac 内建 `qlmanage` / `sips` 把 SVG/PDF 转 PNG。
   （已验：真 Stata svg 41.9K → `qlmanage` 得 1600px 有效 PNG。）

`set graphics off` **不救**（仍 0 字节挂）。

---

## §4 Mac 特有的坑

1. **源 do-file 硬编码 Windows 路径**（`C:/Users/<user>/...`）→ Mac 上命中 `r(603)` 当场中止，
   **不是桥问题**。必须跑改写成 Mac 路径的 tmpdo 版本。
2. **HTTP 500 / rc=-1 可能是传输 blip**，Stata 其实仍落盘干完。判成败必查**落盘产物**，
   判真假完成必抓 `lastRun.rc` + `ok` + `stdout` 尾。
3. **post-run busy / recovery-required**：先查 `/status`，需要放弃当前 run 时用 force-reset；仅当返回 `recovery.required=true` 时调用 `/recovery-smoke`。`graph-clear` 只清图面板，不能用于恢复执行态。
4. **进程隔离**：故障注入 / kill 只针对 session 级 worker PID 精确 kill，
   **绝不 blanket-pkill Stata**。
5. **Python**：Mac 用 `/opt/homebrew/bin/python3`。

---

## §5 Mac 运维脚本（`scripts/mac/`，2026-07-23 已建成并逐个 live 验证）

Windows 的 `scripts/*.ps1` Mac 一个都跑不了。已把常用几支移植成纯 bash（只依赖系统自带
`curl` + `/usr/bin/jq`），放 `scripts/mac/`，与现有 `scripts/` 平级，**共用同一份 `dist/extension.js`**。
公共逻辑抽进 `lib.sh`（桥地址/token/HTTP 封装/颜色输出/JSON 取字段）。

| 脚本 | Windows 对应 | 作用 | live 验证 |
|------|--------------|------|-----------|
| `lib.sh`              | —（新抽公共库）              | 桥常量 + curl/jq 封装，被其余脚本 source | — |
| `status.sh`           | `/status` 片段               | 只读查桥状态（`--json` 出原始）；退出码 0/2/3 | ✅ idle/trueReady |
| `run_visible.sh`      | `invoke_stata_visible.ps1`   | HTTP `/run-command` 执行 `-c code` 或 `-f dofile`；出错自动 force-reset+smoke 重试一次 | ✅ ok=true rc=0 |
| `run_native_disk0.sh` | native `debug-run-file`      | native 通道（唯一把 log 实时流进终端）；默认 `disk=0` | ✅ ran=runFile |
| `force_reset.sh`      | `unblock_stata_terminal.ps1` | force-reset；按返回态决定是否运行 verified recovery smoke | rc.6.4 待冷装 |
| `cleanup.sh`          | `cleanup_mcp_stata_processes.ps1` | 默认 dry-run；force 模式必须显式传 Extension Host 登记的 PID | rc.6.4 exact-PID live unit 通过 |

用法示例：

```bash
cd scripts/mac
./status.sh                              # 查状态
./run_visible.sh -c 'display "hi"'       # 跑一段代码
./run_visible.sh -f /abs/path/x.do       # 跑整个 do（HTTP do "file"，超大文件走这个）
./run_native_disk0.sh /abs/path/x.do     # native，log 实时进终端（小/中文件）
./force_reset.sh                         # busy 死角恢复
./cleanup.sh                             # 先 dry-run 看孤儿进程
./cleanup.sh --force --pid 12345         # 仅清理 /status.ownedBackendPids 中确认归属的 PID
```

红线（已写进 `cleanup.sh`）：只按 `mcp-stata` 命令行特征匹配、按 exact PID 逐个 `kill`，
**绝不 blanket pkill、绝不动 VS Code / Stata GUI / 当前 shell**。桥地址/token 可用
`STATA_BRIDGE_BASE` / `STATA_BRIDGE_TOKEN` 配置（默认端口 17485，没有公开默认 token）。

判成败仍守 Windows 手册 §6.3 铁律：**rc=0/ok=false 是假完成签名**，务必核对 stdout 尾 + 落盘产物；
native 通道 worker CPU 信号不可靠，判真活看 routeAttempt 增长 + 墙钟非量化 + self-log 字节增长（golden signal）。

---

## §6 给后续接手者的一句话

Mac 上的“终端乱码”不是模型编码问题，而是两层缺陷叠加：主 profile `0.1.2` 只带 `dist/ui-shared/main.js` 与 `data-browser.js`，缺 CSS/高亮/补全资源；同时 Terminal 外部脚本缺 CSP nonce，旧 fallback 又因模板语法错误无法初始化。真实 `main.js` 一直包含完整 SMCL 解析器，退化发生在外部脚本未加载时的 fallback。

长期门禁 = 完整 `ui-shared` 归档校验 + nonce/生成脚本解析校验 + `codex-smcl-fallback-v2-template-safe` 22 项语义测试。
执行走 native `disk=0` 让 log 流进终端，图导 SVG/PDF 再转 PNG，判成败一律查落盘产物 + golden signal。
