# Stata Workbench 共享工作階段（Next）

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

<img src="media/icon.png" alt="Stata Workbench Next 圖示" width="96">

> **開發線。** 本儲存庫（`stata-workbench-next`）用來開發和測試多工作階段、agent 身分、
> bridge 驗證身分和經審閱的 agent 改稿。它不替換穩定版
> [stata-workbench-shared-session](https://github.com/lzhs1995/stata-workbench-shared-session)。
> 在某個 Next 建置版本正式發布之前，研究工作請繼續用穩定版。

這是一個 VS Code 擴充套件，讓人和 AI agent 共用同一個看得見的 Stata 工作階段。雙方的程式碼在同一個
Stata 後端裡執行，執行進度即時顯示在 **Stata Terminal** 面板裡：人可以看著 agent 跑，隨時插話、
按 **Stop**、改完再跑。資料、巨集、純量、估計結果和圖在被清掉之前一直共享。

Next 線新增：

- **同時開多個工作階段。** 最多 5 個有名字的工作階段，每個都有自己的 VS Code 視窗、Stata 後端、連接埠和設定目錄。
- **bridge 驗證身分。** 每個本地 bridge 請求都要帶該工作階段的 token。agent 用戶端從工作階段自己的登錄檔裡讀取，不需要人手工複製 token。
- **agent 改稿要經人審閱。** agent 改 `.do`、`.ado`、`.mata` 檔案時只能先提交提議，人在 diff 裡點 **Accept** 之後才會寫入。
- **Stop 和恢復如實報告。** 有執行前檢查點時，Stop 會把它恢復回來；恢復不了時工作階段會鎖住，不會在錯誤的資料上悄悄繼續跑。

派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)
（AGPL-3.0-or-later），見[授權條款](#授權條款)。

## 目錄

- [與穩定版的關係](#與穩定版的關係)
- [環境要求](#環境要求)
- [安裝](#安裝)（[macOS](#macos)、[Windows](#windows)）
- [快速上手](#快速上手)
- [功能](#功能)
- [平台實測結果](#平台實測結果)
- [已知限制](#已知限制)
- [疑難排解](#疑難排解)
- [設定](#設定)
- [開發](#開發)與[授權條款](#授權條款)

## 與穩定版的關係

Next 和穩定版可以裝在同一臺機器上並行使用，兩者不共用任何東西，Next 的測試視窗不會干擾研究工作階段。

| | 穩定版 | Next |
| --- | --- | --- |
| 擴充套件 id | `lzhs1995.stata-workbench-shared-session` | `lzhs1995.stata-workbench-next` |
| bridge 連接埠 | `17485` | 預設 `17601`；啟動器在 `17601`–`17620` 裡挑空閒連接埠 |
| 狀態目錄 | `~/.stata-workbench-shared`（預設設定目錄） | `~/.stata-workbench-next`（`STATA_WORKBENCH_NEXT_HOME`） |
| Stata 服務執行環境 | 全機共用一份 | 每個工作階段一份私有副本（macOS 用 APFS 複製，Windows 整份複製） |
| 工作階段數 | 一個設定目錄加一個連接埠算一個 | 一臺機器最多 5 個有名字的工作階段 |
| agent 工具 | 穩定版儲存庫的 `tools/` | 本儲存庫的 `tools/`；對不上 bundle 就拒絕 |

Next 啟動器從不選用 `17485`、`17416`、`17497`、`17507` 這幾個連接埠，所以 Next 工作階段不會佔用穩定版工具在用的連接埠。

目前版本：`0.2.0-next.6`（見 `package.json`），改動見[更新紀錄](CHANGELOG.md)。只透過 GitHub Releases 分發，Next 的建置版本在那裡以預先發行版
（pre-release）釋出；不釋出到 Open VSX 或 Visual Studio Marketplace。

## 環境要求

| 項 | 要求 |
| --- | --- |
| 系統 | macOS（實測 Apple Silicon）或 Windows 11 x64 |
| VS Code | 1.75 或更高（實測：macOS 1.139.1，Windows 1.144.0） |
| Stata | 本機已授權的安裝（實測：macOS 上 StataNow，Windows 上 Stata 18 MP） |
| `uv` | 建一次 Stata 服務執行環境時使用（Python 3.11 上的 `mcp-stata` 1.26.1） |
| Python 3 | 執行 `tools/` 裡的啟動器和 agent 工具。Windows 上用裝好的 `python.exe`，不要用 Microsoft Store 的別名 |
| 記憶體 | 每個開啟的工作階段各跑一份 VS Code 和 Stata，見[已知限制](#已知限制) |
| 磁碟 | macOS：可用空間低於 20 GB 時啟動器拒絕開新工作階段。Windows：2 GB 加上執行環境副本的大小 |

## 安裝

擴充套件、Stata 服務執行環境和 agent 工具是三樣東西，每臺機器各裝一次。

1. **下載 VSIX 並核對，再取同一 tag 的工具。** 從預先發行版
   [`v0.2.0-next.6`](https://github.com/lzhs1995/stata-workbench-next/releases/tag/v0.2.0-next.6)
   下載 `stata-workbench-next-0.2.0-next.6.vsix`，把它的 SHA-256
   和釋出說明裡的值對一下：macOS 用 `shasum -a 256 <文件>`，Windows 用
   `(Get-FileHash <文件> -Algorithm SHA256).Hash.ToLower()`。然後複製本儲存庫，切到同一個 tag。
   工具釘了 bundle 的 SHA-256，遇到別的建置版本一律拒絕；`python3 -B tools/verify_release.py --vsix <文件>`
   可用本儲存庫副本中的執行環境清單核對 VSIX。自行封裝 VSIX 見[開發](#開發)。
2. **把 VSIX 裝進 Next 共用的擴充套件目錄。** 啟動器把每個工作階段的 `extensions` 目錄連結到
   `~/.stata-workbench-next/extensions-shared`，所以要裝在這裡，不要裝進日常用的 VS Code 設定。
3. **建 Stata 服務執行環境**，放在擴充套件和啟動器最先查詢的位置。同一臺機器上已經裝過穩定版的話，
   這份執行環境一般已經有了；啟動器只讀它，給每個工作階段複製一份。

### macOS

```sh
git clone https://github.com/lzhs1995/stata-workbench-next.git
cd stata-workbench-next
git checkout v0.2.0-next.6   # 你的 VSIX 对应的 tag

CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
"$CODE" --user-data-dir ~/.stata-workbench-next/install-user-data \
  --extensions-dir ~/.stata-workbench-next/extensions-shared \
  --install-extension ./stata-workbench-next-0.2.0-next.6.vsix

RT=~/.local/share/stata-workbench/mcp-stata-1.26.1
uv venv --python 3.11 "$RT"
uv pip install --python "$RT/bin/python3" \
  -c examples/platform-acceptance/service-constraints.txt mcp-stata==1.26.1
```

### Windows

在 PowerShell 裡，於本儲存庫副本的目錄下執行：

```powershell
code --user-data-dir "$HOME\.stata-workbench-next\install-user-data" `
  --extensions-dir "$HOME\.stata-workbench-next\extensions-shared" `
  --install-extension .\stata-workbench-next-0.2.0-next.6.vsix

$rt = Join-Path $env:LOCALAPPDATA 'stata-workbench\mcp-stata-1.26.1'
uv venv --python 3.11 $rt
uv pip install --python "$rt\Scripts\python.exe" `
  -c examples\platform-acceptance\service-constraints.txt mcp-stata==1.26.1
```

`code` 指 VS Code 的 `bin\code.cmd`。如果它不在 `PATH` 裡，先用 `Get-Command code` 查，
修好 `PATH`，或者直接用完整路徑呼叫 `Code.exe`。下文所有命令在 Windows 上把 `python3` 換成 `python`。

約束檔案把 MCP 釘在 2.x 以下（`mcp==1.28.1`）。不用它的話，`uv` 會解析到 MCP 2.x，服務匯入失敗。
執行環境放在別處的，可以用 `--runtime-source` 或 `STATA_WORKBENCH_RUNTIME_SOURCE` 指定。

## 快速上手

以下命令都在儲存庫根目錄執行，每個工具都輸出一個 JSON 物件。

**1. 開工作階段。**

```sh
python3 -B tools/stata_session.py open s1 --workspace /absolute/path/to/project
```

這一步會建 `~/.stata-workbench-next/profiles/s1/`，挑一個空閒連接埠，寫好工作階段設定，然後啟動一個
VS Code 視窗。它最多等 60 s，看這個視窗的 VS Code 行程有沒有出現，結果寫在 `launchState` 裡
（`visible`、`accepted-not-visible` 或 `prepare-only`）；不等 bridge、不啟用視窗、不發任何 Stata 命令。
只看到 `LAUNCHED` 不代表 bridge 已就緒。不給 `--workspace` 時，工作階段用自己那個空的 `profiles/s1/workspace`。

之後 Stata 在開窗時背景載入（啟動器會寫 `stataMcp.loadStataOnStartup: true`，設定目錄裡已設過的值不動），
Windows 11 上 connect 用了 54–66 s，`open` 之後 97–108 s Stata 後端就緒。`trueReady` 不等這次載入。載入期間在 Terminal 交的命令或 agent 的提交都會先等 Stata worker 進入 running；等過 2 s，Terminal 顯示「Waiting for Stata to finish loading…」。見[已知限制](#已知限制)。

新工作區會以 VS Code 的受限模式（Restricted Mode）開啟，點一次 **Trust** 之後擴充套件才啟動。
只有對你專門為這個工作階段建的工作區，才用 `--disable-workspace-trust`。找不到 Stata 時，在視窗裡設定
`stataMcp.stataPath`。

**2. 核對工作階段。**

```sh
python3 -B tools/verified_workbench.py --status --session s1
python3 -B tools/stata_session.py list
```

`--status` 先核對裝好的 bundle 和工具釘的值是否一致，再經過驗證身分的 bridge 讀 `/status`。
`list` 列出每個設定目錄、它的連接埠、VS Code 行程和活著的登錄檔紀錄（不含 token）。

**3. 人來執行程式碼。** 在視窗裡執行 **Stata: Open Interactive Terminal**，直接輸入命令，
或者對 `.do` 檔案用 **Stata: Run Current File**。每次執行的卡片抬頭是 `You · <runId>`。

**4. agent 來執行程式碼。**

```sh
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --code 'display c(N)' --cwd /absolute/path/to/project
python3 tools/shared_stata.py --session s1 --agent-name claude \
  --file analysis.do --cwd /absolute/path/to/project --busy-policy wait --max-wait 60
```

執行過程即時出現在同一個 Terminal 裡，抬頭是 `claude · <runId>`，人隨時可以按 **Stop**。
退出碼 0 表示 verdict 是 `PASS_VISIBLE_SHARED_RUN`，其他情況退出碼 2。用戶端只發一次請求，
從不重試：超時或結果不明不能證明 Stata 沒執行，再次提交前先看 `.stata-receipts/` 裡的執行回執。
執行回執裡有你的程式碼和輸出，不要提交進 Git。

`REFUSED_NOT_DISPATCHED` 表示擴充套件在發出之前就拒絕了這次執行（比如 Stata 沒載入完，或者人在等待時按了
Stop）。輸出裡帶 `reasonCode`、`retryable` 和 `retryAfterMs`；因 Stop 而拒絕的不可重試。

Stata 已經執行、但報了錯的命令（比如 `r(111)`），退出碼 2，不會重試。擴充套件能用本次執行自己的紀錄和
mcp-stata 的回傳碼確認這個報錯時，verdict 是 `STATA_ERROR_CONFIRMED`，帶 `stataRc`；確認不了就仍是
`EXECUTION_UNCONFIRMED_NO_RETRY`。兩種情況下 Stata 的報錯文字都在執行回執裡，報錯之前的命令可能已經改了資料。
agent 路徑已在 macOS（`b82203d`、`d5b03df`）和 Windows（`d020b036`、`80e01c8`）上做過實機驗證，
見[平台實測結果](#平台實測結果)和[已知限制](#已知限制)。

人在 VS Code 裡用 Terminal 的 Stop 按鈕或 **Stata: Cancel Current Request** 停掉 agent 的這次執行，
如果同一次 Stop 恢復了這次執行的執行前檢查點、工作階段重新就緒，verdict 是 `STOPPED_NO_RETRY`（退出碼 2，
不重試）。在 agent 的執行上，Terminal 的 Stop 按鈕已在 macOS 和 Windows 實機核過；
**Stata: Cancel Current Request** 在這條路徑上仍未驗證，見[平台實測結果](#平台實測結果)。Stop 之前部分程式碼可能已經執行。經
`POST /soft-stop` 或看門狗的 Stop 仍是 `EXECUTION_UNCONFIRMED_NO_RETRY`，來源寫在 `stopReportedBy` 裡。
Run File 或 Run Selection 通知裡的 **Cancel** 只屬於人自己的那次執行：它停不了接手工作階段的 agent 執行，
人的那次執行也不給 agent 用戶端任何 verdict。

`--session` 接受工作階段名或工作階段 id（也可以設 `STATA_WORKBENCH_SESSION`）。只有一個活工作階段時可以省略，
有多個時必須給。

**5. 關工作階段。**

```sh
python3 -B tools/stata_session.py close s1
```

`close` 只請這個工作階段的 VS Code 視窗自己退出（macOS 發 SIGTERM，Windows 用不帶 `/F` 的
`taskkill`），從不強殺。VS Code 在問要不要儲存未儲存的修改時，回傳 `CLOSE_PENDING`（退出碼 2），
視窗和檔案都保持原樣。同一工作階段的 `open` 還沒結束時，回傳 `OPENING`（退出碼 2），不發任何訊號。
其他工作階段照常執行。在 macOS 上，結果裡還列出仍佔著本工作階段檔案的行程（`leftoverProcesses`），以及可能比服務行程
活得更久的 Stata worker（`orphanWorkers`）。`close` 只報告它們（`orphanCleanup.mode` 為 `report-only`，
`signalled: []`）；只有每次讀取都成功、什麼都沒留下時，`orphanCleanup.clean` 才為 true。
掃描只看工作階段的 workspace 資料夾和直接放在裡面的檔案，不看更深的子資料夾，行程讀取也不是原子的，
所以 `clean` 的意思是在這個範圍裡沒看到佔用者，不能證明設定目錄下已經沒有活著的行程。

agent 用戶端的其他選項：`--list-sessions` 列印登錄檔；`--events 0` 列印工作階段事件流
（誰跑了什麼、Stop、被拒、改稿提議），不執行程式碼。

## 功能

### 人和 agent 共用一個看得見的工作階段

- 編輯器命令和穩定版一樣：**Run Current File**（`Ctrl+Shift+D`，macOS `Cmd+Shift+D`）、**Run Selection/Current Line**（`Ctrl+Shift+Enter` / `Cmd+Shift+Enter`）、**Open Interactive Terminal**（`Ctrl+Shift+C` / `Cmd+Shift+C`）、**View Data**、Stata Graphs 面板和 Data Browser。
- Terminal 裡每次執行的卡片都標明來源：人是 `You · <runId>`，agent 是 `<agent 名> · <runId>`。runId 和 agent 執行回執裡的一致。
- 一個後端同一時間只跑一個請求。agent 在跑時人按 Run，VS Code 提示 `<agent> is running Stata (<runId>). Wait for it to finish, or press Stop in the Stata Terminal.`，這次被拒也會記進事件流。
- 每個工作階段有一份只追加的事件紀錄（`~/.stata-workbench-next/runs/<sessionId>/events.jsonl`），可以用 `shared_stata.py --events 0` 讀。
- 共享記憶體不是持久儲存。重置、重啟或關閉 VS Code 之前，先把資料和結果存到磁碟上。

### 多工作階段

- `tools/stata_session.py` 最多管理 **5** 個活工作階段。第 6 個 `open` 回傳 `SESSION_LIMIT`，什麼都不建。
- 每個工作階段有自己的設定目錄、連接埠（`17601`–`17620`）、Stata 服務執行環境、臨時目錄、執行前快照和執行鎖。工作階段之間並行執行：兩個 agent 可以同時往兩個工作階段提交，誰也不用等誰。
- 有多個活工作階段時，agent 用戶端不帶 `--session` 就拒絕提交（`MULTIPLE_SESSIONS`，退出碼 2），什麼都不執行。
- 重開同名工作階段時，原來的連接埠空出來就沿用它。剛 `close` 完，舊連接埠可能還被系統佔著（TIME_WAIT），這時啟動器換下一個空閒連接埠。工具按工作階段名找工作階段，不受影響。設定目錄裡已經顯式設過的值保持不動。
- 幾個 `open` 可以同時跑。每個都在一把短鎖裡預留名字、連接埠和工作階段名額，然後在鎖外啟動；執行環境的複製一個接一個做，後一個能看到前一個用掉的磁碟空間。同名工作階段還在開啟時，第二個 `open` 會被拒絕。

### bridge 驗證身分

- 每個工作階段在 bridge 啟動時生成一個 32 位元組的隨機 token，只寫進它自己的登錄檔 `~/.stata-workbench-next/sessions/<sessionId>.json`。macOS 上該檔案權限是 `0600`；Windows 上重建存取控制清單，只給目前使用者。
- bridge 的每個端點都要求 `Authorization: Bearer <token>`（缺失或錯誤回傳 HTTP 401）、`Host` 恰好是 `127.0.0.1:<端口>`、請求不帶 `Origin` 頭（否則回傳 HTTP 403）。token 不會出現在 `/status` 和事件流裡。
- 提交之前，agent 用戶端核對登錄檔紀錄、`/status` 和裝好的 bundle 在工作階段 id、連接埠、重置代數（reset generation）和 bundle SHA-256 上是否一致。任何一項不符就報 `SESSION_IDENTITY_MISMATCH`，什麼都不發。
- 登錄檔要等 bridge 真正繫結連接埠之後才寫，視窗關閉時刪除。`close` 還會清掉寫入行程已退出時殘留的臨時登錄檔。

### agent 改 Stata 檔案要經人審閱

- agent 要改 `.do`、`.ado`、`.mata` 檔案，只能調 `POST /propose-edit`，提交檔案路徑、新內容（不超過 2 MiB）、目前檔案的 SHA-256 和修改理由。
- VS Code 開啟一個 diff，帶 **Accept** 和 **Reject** 兩個按鈕。只有點了 **Accept**、並且檔案在審閱期間沒被改過，才會寫入；舊版本的帶時間戳副本存進 `~/.stata-workbench-next/edit-snapshots/`。
- SHA-256 不對（`SHA_MISMATCH`）、審閱期間人改了檔案（`SHA_CHANGED_DURING_REVIEW`）、被拒絕或超時（預設 120 s），都不會寫檔案。每種結果都記進事件流。
- 這道關由擴充套件執行。agent 宿主那一側也應該攔住直接寫檔案：[docs/next/AGENT-EDIT-PERMISSIONS.md](docs/next/AGENT-EDIT-PERMISSIONS.md) 給了 Claude Code 的 deny 規則。Codex 沒有按檔案生效的同類規則，所以必須走提議流程。

### Stop、恢復與鎖定

- Terminal 裡的 **Stop**（或 `POST /soft-stop`）取消目前執行、等它的任務收尾，Stata 後端保持不變。
- 每次 agent 執行之前，工作階段先給資料存一份執行前檢查點。Stop 會把它放回去，人看到的是 agent 開始之前的資料。人自己的執行沒有檢查點，這時 Stop 會先確認 Stata 已經空閒，資料保持原樣。
- 每次 Stop 都讓 `resetGeneration` 加 1，agent 靠它判斷自己用過的工作階段是否被打斷過。
- 應該有檢查點但沒能恢復時，工作階段會**鎖住**：`/status` 報 `trueReady: false`，之後的執行回傳 HTTP 423，狀態列顯示 **Stata: STALE**，Terminal 提示沒有恢復執行前狀態、工作階段已鎖定。
- 點狀態列的 **Stata: KILL** 解鎖：確認一次後，它強制重置本工作階段自己的後端，再跑經過核驗的恢復 smoke（一條固定的 marker 命令，必須 rc 0 且紀錄裡有 marker）。確認即表示接受丟失 Stata 記憶體裡的資料。在 Windows 上，KILL 只結束本視窗的 Stata Workbench 後端（按父行程和建立時間認定的 python/mcp-stata 行程樹），不影響其它 VS Code 視窗和你自己開啟的 Stata。認不準是不是本視窗的行程，它不作為結束物件。已經請求結束、但結果或殘留檢查沒能確認時，工作階段保持未就緒：提示裡列出這些行程的 pid 和啟動時間，並給出核對用的 PowerShell 命令；出路是關掉這個 VS Code 視窗、另開一個。關窗不能證明這些行程已經結束。macOS 上 KILL 照舊結束登記的後端 pid。
- 執行看門狗會取消沒有紀錄進展的普通執行：第一行紀錄出現前 120 s 沒動靜，或出現後 60 s 沒動靜（識別為長任務的執行分別是 300 s 和 30 分鐘）。第一行紀錄之後，本視窗自己的 Stata worker 用掉的 CPU 時間也算進展，所以像 `bootstrap … nodots` 這樣不輸出、但 worker 一直在算的命令不會在 60 s 時被取消。CPU 在跑不等於在做有用的事：一直空轉、不輸出的執行，最多能佔著工作階段到紀錄連續 30 分鐘沒動靜為止，想提前結束就按 Stop 或 **Stata: KILL**。讀不到或核實不了 worker 的 CPU 時間時，看門狗只按紀錄規則判斷。執行前檢查點會被恢復，但看門狗取消之後工作階段一律鎖住，要點 **Stata: KILL** 才能繼續。鎖定原因會寫明是哪種停頓，例如 `EXEC_PRELOG_STALL (IDLE)`；每次取消都記進 `/status.lastGuardFailure`。`/status.watchdogCpu` 給出正在執行的守衛，以及最近一次 agent 和 Terminal 守衛的 CPU 計數、算作進展的次數和按型別統計的失敗取樣。
- 後端還在啟動、什麼都還沒發出時按 Stop，命令會被拒絕（`PRE_RUN_BACKEND_START_CANCELLED`），工作階段不會被鎖。
- 程式碼已經發出之後才超時的，回包報 `EXEC_OUTCOME_UNKNOWN` 並帶 `payloadMayHaveRun: true`，因為程式碼在 Stata 裡可能還會執行。

## 平台實測結果

所有實機測試都用隔離的 Next 設定目錄、合成的 `.do` 檔案和 `17601`–`17620` 連接埠，沒有用到研究資料。
介面操作（Stop、Trust、KILL）透過 VS Code DevTools 協議驅動，不是真人按鍵。日期為 2026 年、臺北時間。
建置版本指 `main` 的提交：`e7e54848`、`579b0fe9` 和 `171138b6` 都是 `0.2.0-next.5`，`8d63cb45` 是 `0.2.0-next.4`。

11-04 的各行來自兩類建置版本。`aba81779` 是 `v0.2.0-next.5` 釋出版。`a1a2832b`（PR #21）、`40abcbea`（PR #20）
和 `2ec968a`（PR #24）是 PR 的 head，在複核返工和合併之前測的。之後 macOS 在 `main` `b0bc49d` 上做了實機複驗，
Stata 報錯回傳碼和 KILL 後遺留的 worker 另在 `b82203d` 上測過。
PR #30 在它的最終 head `8739778` 上做了實機檢查，這個 head 的檔案樹和合併提交 `e0b4e11` 相同。PR #31 在最後一輪複核返工之前，於 macOS 的 head `db105f28` 和 `4a1ac2e` 上做過實機檢查，見[已知限制](#已知限制)。

<!-- FMAC-RESULT -->
11-06 對合併後的執行環境做了實機複驗：macOS 用 `d5b03df`（PR #31 的合併候選；擴充套件 bundle 和清理核心與 `main` `d020b036` 相同，只有 Python 的 `close` 工具不同），Windows 用 `main` `d020b036`（16 項裡 15 項通過）。這幾輪發現了由 PR #32 和 PR #33 修復的兩個 macOS 缺陷，以及下面的 Windows KILL 恢復缺陷。PR #33 的最後一個提交 `32ff282`（恢復步驟前後的停止檢查）只有離線測試。在釋出提交上做過的檢查列在它的 GitHub 釋出說明裡。
<!-- /FMAC-RESULT -->

<!-- KW-RESULT -->
這幾輪發現的 Windows KILL 恢復缺陷已由 PR #34（rc.7.90）修復。11-07 在 `main` `80e01c8`（#34 的合併提交）上對 Windows 做了實機複驗：兩個活工作階段中對一個點 **Stata: KILL**，只結束了這個視窗的後端行程樹，這個視窗自己恢復（恢復 smoke 通過，下一條命令 rc 0），另一個視窗的行程不變，下一條命令 rc 0。
<!-- /KW-RESULT -->

### macOS（Apple Silicon，macOS 26.5，StataNow，VS Code 1.139.1）

| 檢查 | 建置版本、日期 | 結果 |
| --- | --- | --- |
| 人和 agent 共用一個工作階段（global、變數、估計結果、圖；Terminal 卡片顯示 agent 名和執行回執裡的 runId） | `8d63cb45`，11-01 | 通過 |
| 同時執行 2、3、5 個工作階段 | `8d63cb45`，11-01 | 通過。5 個工作階段重疊 28.57 s，各自讀回自己的 owner、N 和係數；第 6 個 `open` 回傳 `SESSION_LIMIT` |
| 登錄檔與身分校驗的拒絕（陳舊紀錄、PID 被複用、token 錯、generation 不符、多個活工作階段不帶 `--session`） | `8d63cb45`，11-01 | 通過，7/7 被拒且沒有執行 |
| 兩個 agent 同時往兩個工作階段提交（30 s 命令，間隔 0.008 s 發出） | `579b0fe9`，11-02 | 通過。兩邊都是 HTTP 200，分別用時 34.41 s 和 34.26 s |
| 一個工作階段跑 60 s，另一個工作階段交短命令 | `579b0fe9`，11-02 | 通過。長命令還在跑時，短命令 4.50 s 就回傳了 |
| 兩個工作階段都在忙時只 Stop 其中一個 | `579b0fe9`，11-02 | 通過。被停的工作階段恢復就緒；另一個照常跑完，重置代數不變 |
| 兩個活工作階段時不帶 `--session` | `579b0fe9`，11-02 | 通過。`MULTIPLE_SESSIONS`，什麼都沒執行 |
| 兩個工作階段關掉一個 | `579b0fe9`，11-02 | 通過。它的登錄檔紀錄已刪除；另一個工作階段照常能跑程式碼 |
| 人的長命令在 Terminal 裡按 Stop，兩次 | `579b0fe9`，11-02 | 通過。兩次都是第一次點選就停，Stata 行程不變，資料保留 |
| 對 agent 執行按 Stop | `579b0fe9`，11-02 | 通過。沒有強制重置，執行前狀態已恢復（`RECOVERED_FULL`） |
| 執行前檢查點被刪掉後按 Stop | `579b0fe9`，11-02 | 通過。工作階段鎖住（`trueReady: false`，下一次執行 423，狀態列 STALE） |
| **Stata: KILL** 解鎖 | `579b0fe9`，11-02 | 通過。確認一次，恢復 smoke rc 0，下一次執行成功 |
| 開窗後第一條命令，`loadStataOnStartup` 為 `false`（5 次）和 `true`（2 次） | `aba81779`，11-04 | 通過，7/7 HTTP 200、rc 0，沒有在首條紀錄前卡住。命令先等 Stata 載入完（`false` 11–14 s，`true` 約 7 s，第一次冷啟動 61 s），Output 紀錄先寫「Waiting for Stata to finish loading…」，再寫「finished loading after N s」 |
| Stata 還在載入時交的命令：按 Stop、超時、worker 失敗 | `aba81779`，11-04 | 通過。等待中按 Stop：HTTP 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`，什麼都沒發出，下一條 rc 0。worker 被凍結：336.5 s 後 HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT`，工作階段沒鎖。隨後結束該 worker：HTTP 500 `PRE_RUN_BACKEND_WARMUP_FAILED`；下一條命令等了 37 s 重新載入，回傳 rc 0 |
| 後端 connect 完成之前按 Stop | `aba81779`，11-04 | 失敗。什麼都沒發出，但軟 Stop 35.6 s 後回傳 500，工作階段被鎖（`soft-stop-did-not-restore-checkpoint`）。在這個建置版本上失敗。rc.7.83（PR #25）已修；在 `main` `b0bc49d` 上實機通過（connect 前按 Stop，命令被拒、工作階段沒鎖，下一條命令 rc 0） |
| 命令執行時點 Terminal 的 Stop 按鈕 | `aba81779`，11-04 | 第一輪 0/2：測試驅動點的位置被 Welcome 頁的透明遮罩蓋住，點選沒有到達 Terminal。關掉 Welcome 之後，滑鼠點選、在 Terminal 檢視內點選、**Stata: Cancel Current Request** 各一次都停下了執行，工作階段沒鎖 |
| 人和 agent 輪流跑；agent 執行中人插話 | `aba81779`，11-04 | 通過。人的提交得到 HTTP 409 `bridge busy`，寫明正在執行的 agent；之後雙方讀到同一個 owner、N 和係數 |
| 兩個活工作階段時點 **Stata: KILL** | `aba81779`，11-04 | 通過。只有被鎖工作階段的 3 個行程被換掉；另一個工作階段正在跑的 40 s 命令照常 rc 0 完成 |
| 5 個活工作階段，3 個同時提交 | `aba81779`，11-04 | 部分通過。第 6 個 `open` 得到 `SESSION_LIMIT`。3 個同時提交裡 2 個通過；一個在視窗報就緒約 20 s 後交的 agent 提交，因為後端還沒起來，在派發前被拒（`BLOCKED_NO_DISPATCH`）。在這個建置版本上失敗。rc.7.86（PR #26）已修；在 `main` `b0bc49d` 上實機通過（開窗後立即交的 agent 命令 rc 0，與 `lastCold.runId` 一致） |
| 高負載下（load average 120–140）不輸出的長命令 | `aba81779`，11-04 | 失敗。一條 `bootstrap … dots(50)` 60 s 沒有新紀錄，63 s 時被當作 `EXEC_PRELOG_STALL (IDLE)` 取消，工作階段被鎖。rc.7.84（PR #24）加了 worker CPU 訊號 |
| worker CPU 訊號：空閒噪聲和真卡死 | `2ec968a`，11-04 | 通過。空閒 worker 的 CPU 時間每 12 s 增長 10 ms（閾值 200 ms）。用 SIGSTOP 凍結的 worker 照樣被取消，凍結後 69.7 s；KILL 之後下一條命令 rc 0。不輸出的長命令那一項在首條紀錄預算內就結束了，所以「60 s 空閒且有 CPU 進展」那條路徑還沒有實機測到 |
| agent 交的命令 Stata 報錯（`display nosuchvar`） | `b82203d`，11-05 | 通過。`STATA_ERROR_CONFIRMED`，`stataRc` 111，各項報錯檢查都為真；Terminal 卡片顯示 RC 111。下一條 agent 命令 rc 0，工作階段保持就緒 |
| 人在 Terminal 裡輸入的命令 Stata 報錯 | `b82203d`，11-05 | 通過。執行以失敗結束、rc 111，面板顯示 `RC 111` 和 `r(111);`。下一條輸入的命令 rc 0，之後 agent 命令 rc 0 |
| 人跑 Run File 時點通知裡的 **Cancel**（「Running long_dots.do [Cancel]」） | `8739778`（PR #30），11-05 | 通過。這次點選經和 Terminal 按鈕同一個 Stop 停下了執行；5 s 後工作階段空閒，執行前的狀態已恢復，之後在面板裡輸入的命令 rc 0 |
| 人用 Terminal Stop 停 agent 的執行 | `8739778`（PR #30），11-05 | 通過。agent 拿到 `STOPPED_NO_RETRY`，`stoppedBy` 為 person，各項 stop 檢查都為真；只發了一次請求，沒有重試。下一條 agent 命令通過 |
| 打包、`verify_release` 和裝好的 bundle | `d5b03df`，11-06 | 通過。VSIX 裡的 bundle 和裝好的 bundle 都等於固定的 SHA-256；`verify_release --vsix` 116/116；執行環境清單的 115 個檔案與裝好的副本一致 |
| 開窗後第一條命令，`true` 和 `false` 各兩次；等待中按 Stop | `d5b03df`，11-06 | 通過，4/4，面板和紀錄裡都有等待提示。等待中 Stop（經 `/soft-stop`）以 `PRE_RUN_BACKEND_WARMUP_CANCELLED` 被拒，什麼都沒發出，下一條命令 rc 0 |
| Run File 通知裡的 **Cancel**；人用 Terminal Stop 停 agent 的執行 | `d5b03df`，11-06 | 通過。Cancel 停下了執行，執行前狀態已恢復，之後輸入的命令 rc 0。agent 拿到 `STOPPED_NO_RETRY`（一次請求、沒有重試，8 項 stop 檢查都為真） |
| 新執行進行中點舊通知的 **Cancel** | `d5b03df`，11-06 | 沒做到。3 次嘗試裡，舊通知都在新執行的通知出現前 4.7–10 s 關掉了；新執行每次都 rc 0。只有離線測試 |
| agent 和人各交一條報錯命令 | `d5b03df`，11-06 | 通過。agent：`STATA_ERROR_CONFIRMED`、`stataRc` 111，下一條 agent 命令 rc 0。人：rc 111，下一條輸入的命令 rc 0 |
| 四個活工作階段：輪流、報錯命令、Stop、對其中一個點 KILL | `d5b03df`，11-06 | 通過。KILL 只換掉了那個工作階段自己的三個行程；另一個工作階段 40 s 的迴圈以 rc 0 跑完。人跑 Run File 時用滑鼠點面板的 Stop，仍點在通知上；通知裡的 Cancel 能停下執行 |
| 不輸出的命令執行中點 KILL（孤兒 worker） | `d5b03df`，11-06 | 通過。舊 worker 和它的 resource tracker 被結束；同一資料夾裡一個命令列像 worker 的測試行程 pid 和啟動時刻都沒變 |
| 不輸出的 `bootstrap … reps(400) nodots`；`/status.watchdogCpu` | `d5b03df`，11-06 | 通過。105 s 沒有輸出，108 s 以 rc 0 完成，有 CPU 進展（8 次取樣裡 7 次，0 次出錯）；22 次輪詢都有 `watchdogCpu` |
| 本視窗的 worker 被 SIGSTOP 停住時的強制重置 | `d5b03df`、`d020b036`，11-06 | 失敗，4/4。強制重置結束服務行程約 1 s 後，擴充套件宿主退出（code 0），只剩 VS Code 主行程，`close` 回傳 `CLOSE_PENDING`。`e0b4e11`（#31 之前）上沒有出現。由 PR #33 修復 |
| 在 PR #33 的第一個 head 上做同樣的對照 | `3c8e4f3`，11-06 | 通過，2/2。發任何終止訊號之前 worker 先被恢復，擴充套件宿主活了下來；**Stata: KILL** 解鎖了工作階段，下一條命令 rc 0，`close` 回傳 `CLOSED`。其中一次有一行 `host-group-unknown`（什麼都沒發；原因沒查到） |
| 還有行程佔著 workspace 時的 `close` | `d5b03df`、`d020b036`，11-06 | `d5b03df` 上失敗：每次 `lsof +d` 都以退出碼 1 帶行回傳，`close` 報 `identity-unreadable` 和 `holders: unknown`。用 #32 的 `close` 工具（`main` `d020b036`）通過：一個佔著 workspace 的活測試行程被列為 unresolved（`holders: present:1`、`clean: false`、什麼訊號都沒發）。比視窗活得更久的真實 Stata worker 沒有造出來 |

### Windows（Windows 11 x64，Stata 18 MP，VS Code 1.144.0）

| 檢查 | 建置版本、日期 | 結果 |
| --- | --- | --- |
| 新設定目錄關閉 VS Code 和擴充套件的自動更新 | `171138b6`，11-02 | 通過 |
| agent 改稿審閱：接受、拒絕、審閱期間被改 | `171138b6`，11-02 | 通過 |
| 拒絕：PID 被複用、token 錯、連接埠被佔、陳舊紀錄 | `171138b6`，11-02 | 通過，什麼都沒發 |
| 雙工作階段：兩個 agent 同時提交、一邊忙一邊提交、Stop 其中一個、互不串、`MULTIPLE_SESSIONS` | `579b0fe9`，11-02 | 通過。兩次執行重疊 40.5 s；讀回分別是 `owner=w3a N=111` 和 `owner=w3b N=222` |
| 雙工作階段 20 輪同時提交（40 次執行，其中 5 次中途 Stop） | `e7e54848`，11-03 | 通過，20/20。沒被 Stop 的 35 次全部通過，紀錄沒有一行串到另一個工作階段；被 Stop 的 5 次都恢復了、沒有強制重置，另一個工作階段的重置代數不變（5/5）。20 輪裡 Stata pid 都沒變 |
| 人的長命令在 Terminal 裡按 Stop，五次 | `e7e54848`，11-03 | 通過，5/5。第一次點選就停，Stata 行程不變，Stop 之前的資料保留 |
| 執行前檢查點被改名後按 Stop | `e7e54848`，11-03 | 通過。提示寫明沒有恢復執行前狀態、工作階段已鎖、要點 **Stata: KILL**；狀態 fenced，下一次執行 423。`579b0fe9` 上同一場景的提示錯說檢查點已恢復 |
| 人的長命令在 Terminal 裡按 Stop，兩次 | `579b0fe9`，11-02 | 通過，2/2：第一次點選就停，Stata 行程不變，資料保留 |
| 從 Terminal 停掉 agent 執行 | `579b0fe9`，11-02 | 通過。執行前檢查點已恢復（`restored=true`），讀回 N=77 |
| 執行前檢查點被移走後按 Stop | `579b0fe9`，11-02 | 通過。工作階段鎖住（`snapshot-expected-not-restored`） |
| 看門狗取消一條靜默的 agent 命令 | `579b0fe9`，11-02 | 部分通過。執行前檢查點已恢復，但取消升級成了強制重置，狀態裡報的是上一次失敗的原因 |
| 看門狗取消一條靜默的 Terminal 命令 | `e7e54848`，11-03 | 通過。靜默探針讀到了自己的 marker，沒有強制重置；鎖定原因是這次取消自己的（`elapsedMs 63187`、`stallReason IDLE`） |
| 開窗後的第一條命令，`loadStataOnStartup=false` | `579b0fe9`，11-02；`e7e54848`，11-03 | 時好時壞：3 次卡了 2 次（約 120 s 後 HTTP 504，工作階段鎖住）；另一次 42.2 s 回傳 rc 0。`e7e54848` 上的 504 報 `EXEC_OUTCOME_UNKNOWN`、`payloadMayHaveRun: true` |
| 開窗後的第一條命令，`loadStataOnStartup=true` | `579b0fe9`，11-02 | 通過。開窗時 Stata 在背景載入，用了 57.7 s；之後第一條命令 6.1 s 完成，rc 0 |
| 預設 `loadStataOnStartup`（設定裡沒有這個鍵），開窗後第一條 agent 命令 | `3765d82a`，11-03 | 通過，3/3。啟動器寫入 `true`；`open` 之後 106.6–107.7 s Stata 就緒；第一條 agent 命令 23.1–25.2 s 回傳 rc 0。`open` 之前寫好的 `false` 被保留 |
| agent 路徑和 Terminal 路徑上的看門狗取消 | `3765d82a`，11-03 | 通過。每次取消都在 `/status.lastGuardFailure` 記下自己的 `runId` 和 `elapsedMs`（63 615 ms 和 63 159 ms）；鎖定原因 `EXEC_PRELOG_STALL (IDLE)`。只出現了 `IDLE` 這一種停頓 |
| 被取消的冷啟動命令的遲到事件（`loadStataOnStartup=false`） | `3765d82a`，11-03 | 通過。命令 167.1 s 後回傳 HTTP 504；它遲到的 `log_path` 事件以 `not this client's run` 被丟棄，沒有交給下一次執行 |
| 這類取消之後的普通命令；重新開窗後的第一條 Terminal 命令 | `3765d82a`，11-03 | 部分通過。解鎖後同一後端：5/5 rc 0，每條約 3.1 s，紀錄裡沒有別人的行。預設 `true` 重新開窗：0/2。`connect` 完成（54.2 s）後立刻發的第一條 Terminal 命令在首條紀錄前卡住，163.9 s 後回傳 HTTP 504；工作階段被鎖，第二條得 423 |
| 兩個工作階段，8 輪同時提交 agent 命令、其中 2 輪按 Stop；Terminal Stop 3 次 | `3765d82a`，11-03 | 通過。沒被停的 14/14 全部通過；被停的 2 次都恢復了，沒有強制重置；紀錄沒有串到另一個工作階段；每輪 21.4–24.8 s。Terminal Stop 3/3 第一次點選就停 |
| `close` 清理殘留的臨時登錄檔 | `171138b6`，11-02；`e7e54848`，11-03 | `171138b6` 上部分通過（漏了一個檔案）。`e7e54848` 上通過：寫入行程已退出的檔案被刪，登錄檔為空。「行程已退出卻報錯誤碼 5」這種情況沒出現（三個都報 87），那一支只有單元測試 |
| 跳過恢復 smoke 時的 KILL 提示；遲到事件後探針讀自己的紀錄 | `e7e54848`，11-03 | 部分通過。前者在 Windows 上走不到（那裡 KILL 一定會跑 smoke）；後者需要的遲到事件在兩次懶載入裡都沒重現。兩支都只有單元測試 |
| 新開窗、`connect` 剛完成就發的第一條 Terminal 命令 | `e5d2cda7`，11-04 | 通過，3/3。HTTP 200、rc 0，3.05–3.12 s 回傳；第二條也通過。派發前擴充套件先查了 worker 狀態（`list_sessions` 4–6 ms；worker 已在 running，所以沒有出現等待提示）。同一檢查在 `3765d82a` 上也 2/2 通過，所以這次複驗不能說明之前那次卡住已經消除 |
| 開窗後第一條 agent 命令；4 次 agent 執行、最後一次軟 Stop；Terminal Stop | `e5d2cda7`，11-04 | 通過。第一條 agent 命令 11.5 s 回傳 rc 0。第 1–3 次 14.4–15.7 s 通過；被停的那次恢復了檢查點（`restored=true`，沒有強制重置），Stop 之前的資料保留。Terminal Stop 第一次點選就停，Stata 行程不變 |
| 開窗後第一條 Terminal 命令，帶分段計時（`loadStataOnStartup` 為 `true` 和 `false`，新建和複用的設定目錄） | `a1a2832b`，11-04 | 通過，24/24 HTTP 200、rc 0，其中 10 次用的是新建設定目錄。每條第一條命令都先等 Stata 載入 16–60 s，之後執行、log path 和首行輸出在 0.6 s 內跟上。帶同樣計時行的舊建置版本 `3765d82a` 17 次裡卡了 1 次（約 120 s 後 HTTP 504）；見[已知限制](#已知限制) |
| 4 條 8 s 命令，第 2 條軟 Stop；點一次 Terminal 的 Stop 按鈕 | `a1a2832b`，11-04 | 通過。Stop 1.65 s 回傳，檢查點已恢復，沒有強制重置；另外 3 輪的開始和結束行都寫進了紀錄；Stata 行程不變。Terminal Stop 第一次點選就停。面板剛拿到焦點時的第一次 Run 點選沒有反應，和之前的 Windows 測試一樣 |
| Stata 還在載入時交的命令（worker 被掛起）：按 Stop、超時、重啟 | `40abcbea`，11-04 | 通過。等待中按 Stop：以 `PRE_RUN_BACKEND_WARMUP_CANCELLED` 被拒，Stata 紀錄裡什麼都沒有。超時：300.1 s 後 HTTP 504 `PRE_RUN_BACKEND_WARMUP_TIMEOUT`，什麼都沒發出。恢復後下一條命令 46.1 s 回傳 rc 0；它的 worker 在啟動中失敗過，被重啟一次、43 s 載入完，命令只執行了一次。沒有出現使用者可見的 `PRE_RUN_BACKEND_WARMUP_FAILED`（`stataPath` 寫錯時 Stata 照樣載入了）。等待提示出現在 Output 紀錄裡；測試用的輸入方式不畫 Terminal 面板，所以 Windows 上面板裡的文字還沒核實 |
| 兩個活工作階段時的 `/panic-kill?dryRun=1` | `d020b036`，11-06 | 通過，2/2。每個視窗只選中自己的 4 個行程，兩組不相交 |
| 兩個活工作階段中對一個點 **Stata: KILL** | `d020b036`，11-06 | 範圍通過，恢復失敗。只有被 KILL 的視窗的行程樹結束；另一個視窗的 pid 不變，下一條命令 rc 0。被 KILL 的視窗恢復 smoke 失敗（`transport-failed`），下一條命令得到 HTTP 423 `panic-kill-command-needs-smoke`；見本節開頭的說明 |
| PR #34 之後，兩個活工作階段中對一個點 **Stata: KILL** | `80e01c8`，11-07 | 通過。只有被 KILL 的視窗的行程樹結束（「ended 3 of 4 … already exited 1」）；點選後 77 s，被 KILL 的視窗顯示「the verified recovery smoke passed; the session is READY」，換了新後端（`resetGeneration` 1），沒關視窗，下一條命令 rc 0。另一個視窗的 pid 不變，下一條命令 rc 0 |
| KILL 恢復之後：Stata 報錯，再由人按 Terminal Stop | `80e01c8`，11-07 | 通過。恢復後的視窗上 `display nosuchvar` 得到 `STATA_ERROR_CONFIRMED`，`stataRc` 111，下一條命令 rc 0。另一個視窗上人按 Terminal Stop 停 agent 的執行，得到 `STOPPED_NO_RETRY`，下一條命令 rc 0；兩個視窗都以 `CLOSED` 關閉 |
| agent 交的報錯命令（`display nosuchvar`） | `d020b036`，11-06 | 通過。`STATA_ERROR_CONFIRMED`、`stataRc` 111，12 項報錯檢查都為真，下一條命令 rc 0。Stata 紀錄裡有 `r(111);`；擴充套件紀錄裡沒有報錯文字 |
| 不輸出的長命令（`bootstrap … reps(400) nodots`，沒有紀錄輸出） | `d020b036`，11-06 | 通過。跑了 192.8 s，rc 0，沒有被取消；15 次取樣裡 14 次有 CPU 進展，0 次出錯；`/status.watchdogCpu` 存在 |
| 後端被凍住時交的命令：失敗、按 Stop | `d020b036`，11-06 | 通過。失敗：51 s 後面板顯示 `PRE_RUN_BACKEND_WARMUP_FAILED`，什麼都沒發出，下一條命令 rc 0。身分探針期間按 Stop：HTTP 409 `PRE_RUN_BACKEND_WARMUP_CANCELLED`，什麼都沒發出；`/soft-stop` 呼叫本身用了 58 s，工作階段一直鎖著（見已知限制） |
| 第一條命令；真實 Terminal 面板裡的等待提示 | `d020b036`，11-06 | 通過。`loadStataOnStartup` 為 `true` 和 `false` 時，開窗後馬上交的 agent 命令都通過；`false` 時第一條 Terminal 命令 73.4 s 回傳 rc 0。面板從 4.7 s 到 42.7 s 顯示「Waiting for Stata to finish loading」，之後顯示輸出 |
| 人用 Terminal Stop 停 agent 的執行；`close` | `d020b036`，11-06 | 通過。`STOPPED_NO_RETRY`，`stoppedBy` 為 person，各項 stop 檢查都為真，下一條命令 rc 0。6 次 `close` 都回傳 `CLOSED` |

macOS Intel 和 Windows Server 2022 在每個 PR 的 CI 上跑離線測試和打包（沒有授權的 Stata）。
Windows 10、Windows on ARM 和 Linux 未驗證。

PR #15（Stop/KILL 提示與實際結果一致、Windows 行程存活判定、靜默探針修復）已在 Windows 上用 `e7e54848` 實機複驗
（表中 11-03 各行）。PR #17（`e9b22430`：開窗即載入 Stata、看門狗取消寫明自己的停頓、遲到事件跟著自己的任務走）
已在 Windows 上用它的 head `3765d82a`（bundle 與 `e9b22430` 相同；表中標 `3765d82a` 的各行）實機複驗。三項修復都成立，但 Stata 剛載入完就發的 Terminal 命令卡過一次。PR #18（`1bf02d02`：Terminal 命令派發前先等 Stata warm-up）
已在 Windows 上用它的 head `e5d2cda7`（原始碼樹相同；表中 11-04 各行）實機複驗，見[已知限制](#已知限制)。macOS 在 11-04 用 `v0.2.0-next.5` 釋出版（`aba81779`）做了實機複驗，
11-04 至 11-05 又在 `main` `b0bc49d`（PR #19–#21、#23–#26 之後，#27、#28、#22 之前）上複驗了一次，發現的問題列在[已知限制](#已知限制)。
11-06 macOS 在 `d5b03df` 上、Windows 在 `main` `d020b036` 上複驗（表中 11-06 各行）；11-07 在 PR #34 之後的 `main` `80e01c8` 上複驗了 Windows（表中 11-07 各行）。

## 已知限制

`main` 上已修復（`e9b22430`，PR #17），並已在 Windows 上用 `3765d82a`（11-03）實機確認，另有註明的除外：

- **Windows：開窗後的第一條命令曾經會把工作階段鎖住（剩下的卡頓由下面的 warm-up 修復處理）。** `stataMcp.loadStataOnStartup: false` 時，Stata 要等第一條命令來了才載入。在 Windows 上，這第一條命令 3 次卡了 2 次，約 120 s 後回傳 HTTP 504，工作階段被鎖。啟動器現在預設寫 `true`，Stata 在開窗時就載入（Windows 11 上 57.7 s）。設定目錄裡顯式寫了 `false` 的，問題照樣會出現（最後一次在 `3765d82a` 上核過）；啟動器保留這個值，`open` 的回包會在 `backendLoad` 裡說明。這樣的工作階段被鎖後點 **Stata: KILL** 解鎖；要避免，就在 `open` 之前把 `profiles/<名字>/user-data/User/settings.json` 裡的 `false` 刪掉。到目前為止的測試裡，macOS 沒有這個問題。
- **被取消命令的遲到事件曾經記到別的執行上。** 在 Windows 上，一條取消已報「確認」的命令約 2 s 後照樣執行了，它遲到的紀錄事件被交給了緊接著的那次執行（靜默探針）。當時工作階段是鎖住的，沒人在錯誤狀態上接著做；PR #15 之後，這種回包報 `EXEC_OUTCOME_UNKNOWN` 並帶 `payloadMayHaveRun: true`（已在 Windows 上用 `e7e54848` 實機確認）。PR #17 讓事件跟著自己的任務走：一次執行沒等到回包就結束後，task id 不明的事件不再交給目前執行，而是暫存或丟棄。暫存區最多 256 條；如果 256 條全是 `log_path` 或 `task_done`，新來的 `task_done` 可能被丟。
- **看門狗取消曾經顯示上一次失敗的原因。** 在 agent 路徑上，看門狗取消之後的狀態沿用了之前一次 Terminal 失敗的原因和時長。現在每次取消都寫自己的 `stallReason` 和 `elapsedMs`，鎖定原因寫成例如 `EXEC_PRELOG_STALL (IDLE)`。`reasonCode` 本身對各種停頓仍都是 `EXEC_PRELOG_STALL`，因為用戶端按它匹配。

`0.2.0-next.5` 之後在 `main` 上修復的，有離線測試和 CI。macOS 在 `main` `b0bc49d`（#27、#28、#22、#30、#31 之前）上做了實機複驗，PR #30 另在它的最終 head `8739778` 上測過，PR #31 在最後一輪複核返工之前的 head 上測過。11-06 macOS 在 `d5b03df`（合併後的 bundle）上、Windows 在 `main` `d020b036` 上複驗，結果寫在各條裡：

- **Windows：Stata 載入完後的第一條 Terminal 命令偶爾卡住（W-P1）。** 分段計時（PR #21）找到了卡在哪裡。33 次裡卡住的那 1 次，worker 裡 Stata 自己的啟動在 pre-flight 檢查之後、到 `stata_setup.config` 結束之間用了 76.6 s（其餘 32 次是 3.4–8.6 s）。命令一直在排隊，沒有丟：舊建置版本把這段等待算進了命令的 120 s 首條紀錄預算，在 Stata 就緒前 1.7 s 把它取消了。PR #18 起，命令先在這個預算之外等 Stata 載入完（預設最多 300 s）。帶這段等待的建置版本 24 次 0 次卡住，其中 10 次是新建設定目錄。這是統計上限（95% 信賴水準下卡住率低於約 12.5%），不能證明不會再卡。Stata 啟動超過上限時，命令在派發前被拒絕（`PRE_RUN_BACKEND_WARMUP_TIMEOUT`），工作階段不會被鎖。
- **不輸出的長命令 60 s 後會被取消**（繼承自穩定版）。看門狗現在還把本視窗自己的 Stata worker 用掉的 CPU 時間算作進展（PR #24，rc.7.84）。限制見下面的 CPU 訊號一條；11-04 macOS 複驗時，高負載下這樣的命令仍被取消了，起因是 CPU 取樣失敗；PR #31 改了這一點（見下面）。
- **後端 connect 完成之前按 Stop 會鎖住工作階段。** 現在只拒絕這條命令，不鎖工作階段（PR #25，rc.7.83）。
- **同時跑的幾個 `open` 會在 10 s 後互相超時。** 現在都在短鎖裡預留、鎖外啟動（PR #23）。
- **剛開窗時 agent 的提交會被拒**（`BLOCKED_NO_DISPATCH`），而 Terminal 命令會等。現在 agent 也等同一個 warm-up；拒絕結果帶 `retryable` 和 `retryAfterMs`（PR #26，rc.7.86）。
- **warm-up 快取可能信任一個已被換掉的 worker。** 現在快取記下 worker 的 pid、啟動時刻和 transport，用之前再核一次；核對失敗或超時就當作沒就緒。worker 在啟動中掛掉時，Terminal 命令會把它重啟一次（PR #20，rc.7.81）。
- **Stata 報錯被報成結果不明。** 確認了的報錯現在給 agent 回傳 `STATA_ERROR_CONFIRMED` 和 Stata 的回傳碼（`stataRc`），Terminal 路徑也報這個回傳碼，不再是 -1（PR #27，rc.7.85；PR #28 讓 mcp-stata 發出回傳碼）。已在 macOS 的 `b82203d` 和 `d5b03df` 上實機驗證，Windows 在 `d020b036` 上驗證了 agent 路徑，見下面的限制。
- **Windows 上的 Stata: KILL 曾經結束本機所有 Stata 圖形介面行程和所有 mcp-stata 後端**，不只是本工作階段的；忙時的強制重置也一樣。現在只結束本視窗已確認的後端行程樹（PR #22，rc.7.82）。在 `d020b036` 上用兩個工作階段實機跑過一次，確認了範圍：只有被 KILL 的視窗的行程樹結束，另一個視窗的 pid 不變、下一條命令照常執行。Windows 上那次 KILL 之後的恢復失敗，見[平台實測結果](#平台實測結果)開頭的說明和下面的限制。
- **人自己的 Run File 停不下來。** 它的進度通知「Running <檔案> [Cancel]」蓋住了 Terminal 的 Stop 按鈕（`b0bc49d` 的 macOS 複驗），通知的 **Cancel** 又沒有接到任何操作，執行一直到 375 s 被看門狗取消，工作階段被鎖。現在 Run File 或 Run Selection 通知裡的 **Cancel** 呼叫和 Terminal 按鈕同一個 Stop，只在開啟通知的那次執行還在進行時生效（同一個執行生命週期、同一個 request id）（PR #30，rc.7.87）。Run File 已在 macOS 的 `8739778` 上實機核過；Run Selection 只有單元測試。舊通知的 Cancel 停不了之後的新執行、也停不了接手的 agent 執行，這一點只有離線測試；11-06 實機核對時造不出這種狀態（舊通知總在新執行的通知出現前就關了）。
- **人停掉 agent 的執行，agent 拿到的是 `EXECUTION_UNCONFIRMED_NO_RETRY`。** 現在人在 VS Code 裡用 Terminal 的 Stop 按鈕或 **Stata: Cancel Current Request** 停掉 agent 的執行，agent 拿到 `STOPPED_NO_RETRY`（退出碼 2，不重試）。Run File 和 Run Selection 的通知屬於人自己的執行，停不了 agent 的執行。用戶端只在這些條件都成立時才給它：這次 Stop 屬於本次請求和本次執行，發生在這次提交之後，同一次 Stop 恢復了這次執行的執行前檢查點（同一個 run id、`restored` 為 true、reset generation 相同），工作階段重新就緒（PR #30）。已在 macOS 的 `8739778` 上用 Terminal 的 Stop 按鈕實機核過；**Stata: Cancel Current Request** 沒在 agent 的執行上實機試過。`b0bc49d` 複驗裡 Stop 之後約 2 s 出現的 HTTP 423 `checkpoint restore in progress`，來自經測試端點 `/debug-terminal-input` 發的命令；agent 用戶端要等工作階段就緒才傳送。
- **人輸入的報錯命令卡片標題是普通的「Stata Output」。** 現在和 agent 一樣顯示「Stata Output (failed)」（PR #30）。
- **高負載下，一次 CPU 取樣失敗就可能讓不輸出的長命令被取消。** worker CPU 時間的取樣失敗、過期或超時，會重置看門狗的 CPU 基線，相隔約 12 s 的兩次失敗就可能空出 60 s 以上不算進展，而 worker 其實一直在算。11-04 macOS 複驗時（負載均值約 200），`bootstrap _b, reps(400) nodots` 在 99 s 被取消。現在這樣的取樣不算進展，但保留基線，並按型別計數（`cpuErrorKinds`）。算進展仍要同一棵行程樹的兩次核實過的取樣；行程樹變了或有新紀錄，基線照樣重置（PR #31，rc.7.88）。`/status.watchdogCpu` 給出正在執行的守衛，以及最近一次 agent 和 Terminal 守衛的這些計數。在 PR head `db105f28` 上，負載均值 61–76 時三條不輸出的 `bootstrap` 都以 rc 0 完成，沒有取樣出錯。觸發取消的那種高負載沒有重現，所以這項修復在那種負載下只有單元測試支撐。11-06 在 macOS（`d5b03df`）上一條 105 s 沒有輸出的 `bootstrap` 有 CPU 進展、沒有取樣出錯地完成了，Windows（`d020b036`）上一條 192.8 s 沒有紀錄輸出的執行也一樣。
- **macOS：命令執行中點 KILL 或強制重置，舊的 Stata worker 曾經會以父行程 pid 1 繼續執行**，而 `/status` 和 `close` 都報告工作階段是乾淨的（`b82203d`，11-05）。KILL 和強制重置只結束 `mcp-stata` 服務行程，worker 只有在服務行程正常退出時才會跟著退出。現在強制重置先對後端行程樹拍一次 `ps` 快照：根行程必須是登記的 pid，是本擴充套件宿主的直接子行程，啟動不晚於登記後 5 s。結束服務行程之後，只對記下的、仍滿足以下條件的後代先發 SIGTERM 再發 SIGKILL：啟動時刻不變，工作目錄在本工作階段的 workspace 或 `mcp-temp` 裡，父行程是 pid 1 或記下的父行程。讀不到或確認不了的情況，例如登記讀不出、存活檢查出錯、有第二個活後端或一個活後端都沒有，都在 `/status.orphanWorkers` 裡列為 unresolved，不發訊號，也不報乾淨（PR #31，rc.7.89）。`close` 只報告，除了 VS Code 視窗之外不發任何訊號。結果裡有 `leftoverProcesses`、`orphanWorkers` 和 `orphanCleanup`（`mode: "report-only"`、`signalled: []`、`clean`、`unresolved`、`holders`）。行程讀取失敗、超時、往 stderr 輸出或只回傳部分結果時，都算「不明」，不算「空」。只有沒有 unresolved、而且對工作階段檔案的最後一次掃描讀成功並且沒有佔用者時，`clean` 才為 true。在最後一輪複核返工之前的 PR head `4a1ac2e` 上實機（macOS，11-05）：一條不輸出的命令跑到 20 s 時點 KILL，舊 worker 和它的 resource tracker 被結束；同一工作目錄裡一個命令列含 `spawn_main` 的測試行程沒有收到訊號，一次 `close` 把它列為 unresolved。之後那輪返工（堵上可能被讀成乾淨的幾種情況）有離線測試和變異測試。合併後的程式碼在 `d5b03df` 上複驗（11-06）：不輸出的命令執行中點 KILL，舊 worker 和它的 resource tracker 再次被結束，測試行程沒被動。那次複驗發現了下面兩條裡的缺陷。
- **macOS：`close` 在真實 workspace 上列不出活著的 worker 或佔用者**（11-06 複驗）。只要資料夾裡有一個沒有行程開啟的檔案，`lsof +d <workspace>` 就以退出碼 1 結束，同時照樣輸出它找到的行程。#31 把這種情況算作「不明」，所以在任何真實 workspace 上 `close` 都報 `identity-unreadable` 和 `holders: unknown`。現在目錄掃描在退出碼為 0 或 1 且 stderr 為空時讀取這些行；其他退出碼、有 stderr 輸出（比如打不開的資料夾）或超時仍算「不明」（PR #32）。只在 macOS lsof 4.91 上實機核過：一個佔著 workspace 的測試行程被列為 unresolved（`holders: present:1`、`clean: false`、什麼訊號都沒發）。`close` 仍然只報告、盡力而為，見下面的限制。
- **macOS：有後端行程被停住時，強制重置會帶走 VS Code 的擴充套件宿主**（11-06 複驗，4 次都出現）。本視窗的 Stata worker 被 SIGSTOP 停住時，看門狗取消升級為強制重置；服務行程結束約 1 s 後，擴充套件宿主退出（code 0），只剩 VS Code 主行程。原因有實測強力支援，但沒有直接觀測到（沒有抓到 SIGHUP）。在所測的啟動方式下（macOS，由 `tools/stata_session.py` 用隔離設定目錄啟動的視窗），視窗的所有行程，包括 mcp-stata 服務行程、它的 resource tracker 和 worker，都在 VS Code 主行程的行程群組裡。服務行程退出後，tracker 和 worker 被過繼給 launchd，仍留在這個組裡。這樣的成員退出時如果組裡還有別的成員被停住，核心就把這個組當作孤兒行程群組，向整個組發 SIGHUP 和 SIGCONT：擴充套件宿主和各個輔助行程結束，VS Code 主行程活下來。rc.7.89 的清理在 worker 被停住時結束了已過繼的 tracker，觸發了這一點。現在清理在每次發 SIGTERM 或 SIGKILL 之前先讀宿主的行程群組。被停住、且與記下的身分（pid 和啟動時刻）一致的成員先收到 SIGCONT，然後再讀一遍行程群組。有不是我們的成員被停住（`host-group-stopped`）或讀不到行程群組（`host-group-unknown`）時不發訊號，這一行保持 unresolved。每次讀完行程群組之後、每次發 SIGCONT 之前都檢查截止時間、取消和更新的重置（PR #33，rc.7.89-v4）。在 PR #33 的第一個 head `3c8e4f3` 上實機 2/2：宿主活了下來，**Stata: KILL** 解鎖了工作階段，下一條命令 rc 0，`close` 回傳 `CLOSED`；其中一次有一行 `host-group-unknown`，原因沒查到。新加的停止檢查只有離線測試和變異測試。
- **Windows：KILL 成功之後，視窗一直拒絕執行**（11-06 複驗）。命令在它剛結束掉的那個後端的連線上跑恢復 smoke，smoke 以 `transport-failed` 失敗，下一條命令得到 HTTP 423 `panic-kill-command-needs-smoke`；測試隨後關掉了視窗（沒有試第二次 KILL 或 `POST /recovery-smoke`）。現在範圍內的 KILL 成功後會先做一次強制重置：沿用這次 KILL 記下的結果，開啟新連線，工作階段保持「需要 smoke」；smoke 隨後在新連線上跑（PR #34，rc.7.90）。fail-closed 路徑和部分結束的情況不變。在 `main` `80e01c8` 上實機（11-07）跑過一次，兩個工作階段：被 KILL 的視窗自己恢復，下一條命令 rc 0；另一個視窗不受影響。

目前 `main` 上還沒解決的問題：

- **Stata 還在載入時交的命令。** `trueReady` 不等背景載入。Terminal 命令和 agent 的提交都會先等 Stata worker 進入 running；等過 2 s，Terminal 顯示「Waiting for Stata to finish loading…」，點 Terminal 的 Stop 按鈕或用 `POST /soft-stop` 都可以取消等待。等滿 300 s 或 warm-up 失敗時，命令在發出之前就被拒絕（`PRE_RUN_BACKEND_WARMUP_TIMEOUT` 或 `PRE_RUN_BACKEND_WARMUP_FAILED`，`payloadDispatched=false`）。只有不提供 `list_sessions` 的舊版 mcp-stata 才不經這項檢查直接放行（這是相容做法，不能證明 Stata 已就緒）。有 `list_sessions` 但連續失敗或超時時，warm-up 以 `FAILED` 結束，命令被拒絕；warm-up 剛結束時 worker 變了或確認不了，命令會再等一次，仍不行就拒絕。11-04 在 macOS 上實機確認了等待提示、等待中 Stop（經 `/soft-stop`）、超時和失敗拒絕；Windows 上確認了除失敗拒絕以外的幾項，等待提示只在 Output 紀錄裡核過；11-06 在 Windows（`d020b036`）上，失敗拒絕和真實 Terminal 面板裡的等待提示也都看到了。11-05 在 macOS（`b0bc49d`）上往 Terminal 面板裡輸入命令，等待期間 Stop 按鈕是可用的；點它之後命令以 `PRE_RUN_BACKEND_WARMUP_CANCELLED` 被拒絕，什麼都沒發出，下一條命令 rc 0。之前說「等待期間 Stop 按鈕被禁用」，來自一個測試端點（`/debug-terminal-input`）：它發命令時不經過面板的 Run 處理，面板就一直沒顯示命令在執行。這不是產品缺陷。
- **Windows KILL 的範圍只有兩次實機執行支援。** 在 `d020b036` 和 `80e01c8` 上各用兩個工作階段跑過一次：對視窗 A 點 KILL 只結束了 A 的後端行程樹，視窗 B 的 pid 不變，下一條命令 rc 0。兩次執行不構成統計上限。根行程按登記時刻（1 s 以內）認定，不是按記下的建立時間；身分比到毫秒；行程列表不是原子快照；結束之後只再掃一遍直接子行程。清理失敗或讀不到行程身分時，工作階段保持未就緒，`/recovery-smoke` 回傳 HTTP 423 `unresolved-cleanup`。
- **Windows：後端完全凍住時按 Stop 會鎖住工作階段。** 一個工作階段的後端行程全部被掛起時，`/soft-stop` 用了 58 s，回傳 500（`RECOVERY_FAILED`：靜默探針 5 s 超時），並強制重置了本工作階段自己的行程樹。之後工作階段一直以 HTTP 423（`soft-stop-needs-smoke`）拒絕命令，直到關掉視窗。紀錄給出的辦法是 **Stata: KILL** 或 `POST /force-reset`；在凍住的工作階段上兩者都沒試。PR #34 之後，KILL 成功時會在 smoke 之前重置連線，但這種 Stop 之後再 KILL 還沒有實機試過。慢但還活著的後端沒測。
- **Windows：在面板裡輸入、warm-up 期間被拒的命令，`/status.lastTerminalGuardFailure` 為空。** 拒絕只顯示在面板和紀錄裡。
- **macOS 的 KILL 和強制重置只按 pid 認後端**（PR #22 只改了 Windows）。 清理時，登記的 pid 的命令列裡含 `mcp-stata` 就結束它，不核對行程啟動時刻和父行程。如果這個 pid 正好被別的工作階段的 `mcp-stata` 複用，有可能被誤結束。
- **macOS 孤兒 worker 清理的限制。** 訊號發給裸 pid：一個行程在最後一次核對之後退出、它的 pid 在發訊號前被複用，這種情況排除不了；啟動時刻也只精確到 1 s。根行程規則是單邊的：本擴充套件宿主的另一個子行程如果在登記後 5 s 內拿到登記的 pid，排除不了。`close` 的收集和報告兩段各有 8 s 時限，管的是清理的行程讀取，不是整個呼叫：高負載下 `close` 仍可能在列執行個體時因 `ps` 超時拋錯，而不是回傳結論。收集時間用完的行一直記為 unresolved，即使那個行程之後正常退出了。`close` 已實機列出過一個佔著 workspace 的測試行程（11-06），還沒有列出過比視窗活得更久的真實 Stata worker：11-05 的測試裡 worker 總是隨 VS Code 退出而結束；11-06 一個用 SIGSTOP 停住的 worker 有一次比視窗活得更久，但當時那個建置版本的 `close` 列不出它（PR #32 已修），其餘幾次它都在退出過程中結束了。`close` 只報告、盡力而為：它只掃 workspace 資料夾和直接放在裡面的檔案（`lsof +d` 不遞迴），行程讀取不是原子的，而且只在 macOS lsof 4.91 上核過，所以 `holders: none` 和 `clean: true` 的意思是在這個範圍裡沒看到。自己動手結束行程之前，先用 `ps -o pid,ppid,lstart,command -p <pid>` 核對 unresolved 的那一行。Windows 不變（那裡 PR #22 結束本視窗整棵後端行程樹），這種情況沒在 Windows 上測過。
- **macOS：視窗裡另有行程被停住時，KILL 或清理不受支援。** PR #33 只保證強制重置不會在我們記下的行程被停住時結束組裡的成員。如果視窗裡的某個行程是被外部停住的（SIGSTOP、偵錯程式），之後的 **Stata: KILL** 或清理仍可能以同樣方式帶走擴充套件宿主（實機見過）。視窗裡一個被停住、但不是記下身分的行程會擋住清理（各行 unresolved），它不會被恢復。最後一次讀行程群組到發訊號之間 pid 被複用、或行程又被停住，這些情況排除不了。
- **worker CPU 訊號是一種近似。** CPU 在跑不等於在做有用的事：一直空轉、不輸出的執行，最多能佔著工作階段到紀錄連續 30 分鐘沒動靜為止。核實不了行程樹時（取樣期間有 pid 退出、超過 4 層或 16 個行程、父行程對不上），這次取樣不算進展，照 60 s 紀錄規則判斷。同一秒內的 pid 複用超出它所核對的啟動時刻的精度。11-04 在 macOS 上複驗 `main`（`b0bc49d`）：一條 57 s 不輸出的執行以 rc 0 完成，被凍結的 worker 仍被取消；高負載下一條更長的不輸出執行被取消了（見下一條）。
- **最高負載下不輸出的長命令，PR #31 之後還沒有實機複驗。** 11-04 的那次取消（負載均值約 200，99 s，`cpuErrors=2`）來自 CPU 取樣失敗重置了基線，PR #31 改了這一點（見上面已修復的一條）。11-06 不輸出的執行在 macOS（105 s 沒有輸出）和 Windows（192.8 s）上都有 CPU 進展地完成了，但那種負載和那些取樣失敗沒有重現，所以針對它們的修復只有單元測試支撐。看門狗取消之後工作階段仍會鎖住（HTTP 423 `guard-cancel-needs-smoke`），直到點 **Stata: KILL**；這個鎖是有意的，因為取消之後 Stata 裡的狀態是未知的。
- **人跑 Run File 或 Run Selection 時的進度通知會蓋住 Terminal 的 Stop 按鈕。** 通知裡的 **Cancel** 現在能停下執行（見上面已修復的一條）。點通知的正文沒有作用；Run Selection 上的 Cancel 只有單元測試；兩者都沒在 Windows 上核過。舊通知的 Cancel 停不了更新的執行，這一點只有離線測試：11-06 實機試了三次，舊通知總在新執行的通知出現前 4.7–10 s 就關了。
- **經 `POST /soft-stop` 或看門狗的 Stop，agent 拿到的是 `EXECUTION_UNCONFIRMED_NO_RETRY`**，不是 `STOPPED_NO_RETRY`；執行回執在 `stopReportedBy` 裡寫明來源。重新提交之前，先看 `/status` 的 `resetGeneration` 和執行回執。`STOPPED_NO_RETRY` 已在 Windows 的 `d020b036` 上（11-06）用 Terminal 的 Stop 按鈕核過。
- **Stata 報錯的回傳碼按保守條件確認；Windows 上只實機測了 agent 路徑。** 只有同時滿足這些條件才算確認：這次執行沒被取消（Stop、watchdog、Break、rc 1），紀錄是這次執行自己的，最後一行 `r(n)` 後面只有回顯的命令，完成 marker 沒有列印出來，回傳碼是正整數且等於 mcp-stata 給的 rc。mcp-stata 只有打了執行環境補丁（PR #28）才在 `task_done` 裡帶這個 rc，取自本次執行已經拿到的響應；沒打補丁的執行環境不帶 rc，報錯一律確認不了。其他情況 Terminal 路徑仍是 rc -1，agent 仍拿到 `EXECUTION_UNCONFIRMED_NO_RETRY`；報錯文字裡提到 cancel、timeout 或 stall 的也不確認。macOS 建置版本 `b82203d`（11-05）：agent 交的 `display nosuchvar` 回傳 `STATA_ERROR_CONFIRMED`、`stataRc` 111，下一條命令 rc 0；人輸入同一條報錯命令，執行以 rc 111 結束，下一條命令 rc 0；工作階段一直可用。這個建置版本不是現在的 `main`；同樣的檢查在 `d5b03df` 上（11-06）也通過了。Windows（`d020b036`，11-06）：agent 交的 `display nosuchvar` 回傳 `STATA_ERROR_CONFIRMED`、`stataRc` 111，下一條命令 rc 0；Stata 紀錄裡有 `r(111);`，擴充套件紀錄裡沒有報錯文字。人在 Windows 上輸入的報錯命令沒測。離線跨模組測試裡的 `task_done` 結果是手工構造的，介面部分是樁，所以它不是 MCP 傳輸測試，也不是端到端測試。
- **通用的紀錄解析器只認普通寫法 `r(n);`**，不認 mcp-stata 1.26.1 寫的 SMCL 寫法 `{search r(111), local:r(111);}`，只有新的報錯檢查兩種都認。報錯沒被確認時，release 時推斷的 rc、Run File 的收尾和 watchdog 的報錯檢查在這類紀錄裡仍然看不到 rc。
- **Terminal 裡能看到包裝行。** RESULT 頁會顯示每條命令前後加的行，比如 `display as text "___CODEX_RUN_DONE_…___"`、第二個 `r(111);` 和 `scalar _wb_rc_… = _rc`；agent 卡片的命令列裡還能看到用戶端的核驗 marker。它們來自擴充套件和 mcp-stata 執行環境對命令的包裝。完成檢查和一次執行的紀錄證據都依賴這層包裝，所以暫時沒有隱藏。
- **重開的工作階段可能換連接埠。** 剛 `close` 完，舊連接埠可能還處於 TIME_WAIT，啟動器就換下一個空閒連接埠。工具按工作階段名找工作階段。
- **Windows 派發開銷。** 在 Windows 上，每次 agent 提交比 Stata 本身的工作多花約 15 s（派發前檢查和執行回執核驗）；一條短命令從頭到尾要 17.4 s。20 輪 8 s 命令裡，每次提交的固定開銷是 12–18 s。
- **啟動服務可能要等 PyPI。** 擴充套件在啟動 Stata 服務之前，會先去 PyPI 查一次 `mcp-stata` 的版本。在這個請求會超時的機器上，超時時間會算進第一次啟動。
- **記憶體。** 每個工作階段都是完整的一份 VS Code 加 Stata。macOS 上 5 個工作階段 RSS 合計 3852–4000 MB（每個 718–850 MB）。在 16.8 GB 記憶體的 Windows 機器上，兩個空閒工作階段的工作集分別是 1.93 GB 和 2.16 GB，有負載時每個 2.00–2.39 GB。這種設定的機器開第三個工作階段前，先看可用記憶體。
- **工作區信任。** 新工作區要點一次 **Trust**，擴充套件才會啟動。
- **agent 宿主。** Codex 沒有針對 `.do` 檔案的按檔案 deny 規則，見[agent 改 Stata 檔案要經人審閱](#agent-改-stata-檔案要經人審閱)。
- **繼承自穩定版的：** 多行選區裡頂層的 `exit` 會結束整個選區，並被報成失敗；Data Browser 的 frame 名只在開啟瀏覽器時更新；只用 `graph use` 不會在 Terminal 裡生成圖卡片；不保證顯示的原始碼和實際執行的位元組完全一致。
- 維護的是 `dist/extension.js` 這個 bundle。另有一套參考原始碼建置，但它和 bundle 的功能是否一致沒有確認。

## 疑難排解

| 現象 | 怎麼辦 |
| --- | --- |
| `open` 回傳了 `LAUNCHED`，但 `--status` 連不上 | 視窗處於受限模式。在那個視窗裡點一次 **Trust** |
| `SESSION_LIMIT` | 已經有 5 個活工作階段，先 `close` 一個 |
| `NO_FREE_PORT` | `17601`–`17620` 都被別的 Next 設定目錄或別的程式佔了 |
| `DISK_RESERVE` | 可用磁碟低於啟動器的下限，什麼都沒建 |
| `RUNTIME_SOURCE_MISSING` | 先建 Stata 服務執行環境（見[安裝](#安裝)），或者傳 `--runtime-source` |
| `EXTENSIONS_LINK_MISMATCH` | 設定目錄的 `extensions` 連結指向了別的目錄。傳和上次一樣的 `--extensions-dir` |
| `SETTINGS_NOT_PLAIN_JSON` | 設定目錄的 `settings.json` 帶註釋或不是 JSON 物件，啟動器什麼都沒改 |
| `MULTIPLE_SESSIONS` | 有多個活工作階段。傳 `--session <名字>`，或者設 `STATA_WORKBENCH_SESSION` |
| `SESSION_IDENTITY_MISMATCH` | 登錄檔和 `/status` 對不上（比如視窗重新載入之後）。重新跑一次 `--status --session <名字>`；什麼都沒執行 |
| `candidate identity mismatch` | 裝好的 VSIX 不是你的儲存庫副本所固定的那個建置版本。切到 VSIX 對應的提交 |
| bridge 回傳 HTTP 401 或 403 | 請求要帶工作階段 token、`Host: 127.0.0.1:<端口>`，並且不能帶 `Origin`。用 agent 工具，它會從登錄檔讀 token |
| 狀態列 **Stata: STALE**，執行回傳 HTTP 423 | 點 **Stata: KILL** 並確認。它會強制重置本工作階段的後端，並自己跑恢復 smoke；Stata 記憶體裡的資料會丟 |
| Windows：開窗後第一條命令回傳 HTTP 504（`EXEC_PRELOG_STALL` 或 `EXEC_OUTCOME_UNKNOWN`），工作階段被鎖 | 點 **Stata: KILL** 解鎖；它只結束本視窗的後端。命令可能已經執行過，重交之前先看執行回執。如果設定目錄把 `loadStataOnStartup` 設成 `false`，下次 `open` 之前把這一項刪掉。見[已知限制](#已知限制) |
| Windows：點了 **Stata: KILL** 之後工作階段仍未就緒，`/recovery-smoke` 回傳 HTTP 423 `unresolved-cleanup` | KILL 沒能確認清理結果：有些行程認不準是不是本視窗的（這些沒有作為結束物件），或者已請求的結束、殘留檢查沒有得到確認。提示裡列出每個 pid 的啟動時間和核對用的 PowerShell 命令。啟動時間未知的 pid 不要為了解鎖去結束它，它可能屬於別的程式。關掉這個 VS Code 視窗、另開一個；這樣做不能證明列出的行程已經結束 |
| Terminal 顯示「Waiting for Stata to finish loading…」 | Stata 還在啟動。等它，或者點 Terminal 的 Stop 按鈕、用 `POST /soft-stop` 取消；這時什麼都還沒發出。等滿 300 s 命令會以 `PRE_RUN_BACKEND_WARMUP_TIMEOUT` 被拒絕，沒有發出 |
| agent 用戶端回傳 `REFUSED_NOT_DISPATCHED` | 擴充套件在發出之前拒絕了這次執行。看 `reasonCode`。`retryable` 為 true 時，等 `retryAfterMs` 之後再交；因 Stop 而拒絕的為 false |
| agent 用戶端回傳 `STATA_ERROR_CONFIRMED` | Stata 執行了這條命令，並以 `stataRc` 報錯拒絕。報錯文字在執行回執裡。改程式碼；報錯之前的命令可能已經改了資料 |
| agent 用戶端回傳 `STOPPED_NO_RETRY` | 人在 VS Code 裡停掉了這次執行，執行前檢查點已恢復。部分程式碼可能已經執行。重新提交之前先問那個人 |
| `close` 回傳 `OPENING` | 這個工作階段的 `open` 還在進行。等它回傳，再跑一次 `close` |
| `close` 回傳 `CLOSE_PENDING` | 那個視窗裡 VS Code 在問要不要儲存修改。先回答它，再跑一次 `close` |
| `No module named 'mcp.server.fastmcp'` | 執行環境裝成了 MCP 2.x。用約束檔案重灌 |
| agent 超時或結果不明 | 不要直接重交。先看執行回執和 `--events`；超時不能證明 Stata 沒執行 |

## 設定

啟動器往每個工作階段的設定目錄裡寫這些 VS Code 設定：

| 設定 | 值 | 含義 |
| --- | --- | --- |
| `stataMcp.visibleBridgePort` | 挑中的連接埠 | bridge 連接埠（擴充套件預設 `17601`） |
| `stataMcp.nextSessionName`、`stataMcp.nextProfilePath`、`stataMcp.nextMcpConfigPath` | 由啟動器寫 | 工作階段身分，不要手改 |
| `stataMcp.loadStataOnStartup` | 沒設過時寫 `true` | 開窗時在背景載入 Stata（Windows 11 上 connect 用了 54–66 s；`open` 之後 97–108 s 後端就緒）。`trueReady` 不等它 |
| `update.mode`、`extensions.autoUpdate`、`extensions.autoCheckUpdates` | 沒設過時寫 `none`、`false`、`false` | 不讓測試視窗更新 VS Code 或擴充套件 |

其他 `stataMcp.*` 設定（`stataPath`、`runFileWorkingDirectory`、`requestTimeoutMs`、
`enableExecuteTimeout`、`maxOutputLines` 等）和穩定版用法相同。

環境變數：

| 變數 | 預設值 | 含義 |
| --- | --- | --- |
| `STATA_WORKBENCH_NEXT_HOME` | `~/.stata-workbench-next` | 狀態目錄：設定目錄、登錄檔、執行紀錄、擴充套件 |
| `STATA_WORKBENCH_SESSION` | — | agent 工具要用的工作階段名或 id |
| `STATA_WORKBENCH_AGENT_NAME` | `agent` | 顯示在 agent 的 Terminal 卡片和事件流裡的名字 |
| `STATA_WORKBENCH_RUNTIME_SOURCE` | 本機執行環境（見[安裝](#安裝)） | `open` 複製給新工作階段的執行環境 |
| `STATA_WORKBENCH_CODE` | 標準位置的 VS Code | 要啟動的 VS Code |
| `STATA_WORKBENCH_TIMING_FILE` | — | 診斷用：擴充套件把 `[wb-timing]` 行同時追加寫進這個檔案 |

**Stata Workbench** 輸出頻道裡，Terminal 命令在首行輸出之前的每一步各有一行 `[wb-timing] {…}`
（入口、warm-up、工具呼叫、log path、首行輸出）。這些行只有固定欄位：時刻、id、狀態、錯誤類型或代碼，
不寫程式碼、輸出和錯誤訊息。它們是同步寫的，有一點 I/O 開銷。mcp-stata 內部的計時不屬於產品：
`scripts/stata_timing_patch.js` 只給一份新建的一次性執行環境副本插樁，供人工診斷用。

## 開發

```sh
npm ci --ignore-scripts
npm run check -- --keep-going
python3 -B -m unittest discover -s tools -p 'test_*.py'
npm run package
python3 -B tools/verify_release.py --packaged
```

`npm run package` 一步跑完全部檢查並生成 `stata-workbench-next-<版本>.vsix`。CI 在 macOS 15
（Apple Silicon 和 Intel）和 Windows Server 2022 上跑這些步驟，不需要 Stata、圖形介面或憑據，另外還跑一套
參考原始碼建置。圖片語料測試在私有語料裡沒有 `.do` 檔案時跳過，另外還在儲存庫裡的一小套合成語料上跑；
pre-flight 補丁測試只接受未打補丁或恰好打過一次補丁的本機執行環境。

對 bundle 的修改都寫成 `scripts/` 裡可讀的補丁指令碼，作用在維護的 `dist/extension.js` 上。
後加的補丁都能撤回，並在 `scripts/later_bundle_patches.js` 和 `scripts/patch_manager.js` 裡登記。
改了 bundle 之後，要重新整理 `release/runtime-manifest.json` 和 `tools/verified_workbench.py` 裡釘的
`BUNDLE_SHA256`；把補丁重放兩次，得到的位元組必須相同。

更多：[需要授權機器才能做的檢查](docs/next/LIVE-CHECKS.md)、
[跨平台說明](docs/CROSS_PLATFORM.md)、
[共享執行與併發](docs/shared-execution-and-concurrency.md)、
[釋出維護](docs/RELEASE.md)和[更新紀錄](CHANGELOG.md)。

## 授權條款

AGPL-3.0-or-later。派生自 [tmonk/stata-workbench](https://github.com/tmonk/stata-workbench)。
與 [hanlulong/stata-mcp](https://github.com/hanlulong/stata-mcp) 的設計比較在 [NOTICE](NOTICE) 裡致謝，
這並不表示兩者的執行環境可以互換。見 [LICENSE](LICENSE) 和 [SECURITY.md](SECURITY.md)。

不包含 Stata、Stata 授權、憑據或資料。bridge 只監聽 `127.0.0.1`，不是遠端服務，也不是多使用者服務。
