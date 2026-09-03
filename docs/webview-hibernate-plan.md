# 主窗口 WebView 按需休眠（hibernate）实施计划

> 分支：`feat-webview-hibernate`（自 `main` @ `2ec8a58` 切出）
> 注意：**分支名不要用斜杠**。本机 `git checkout -b feat/webview-hibernate` 会改写 `.git/HEAD` 却不生成 `.git/refs/heads/feat/` 下的 ref 文件，导致 HEAD 成孤儿、171 个已跟踪文件被误报为 `new file`（此时 commit 会产生无父提交的新根）。项目沿用不含斜杠的命名（`main` / `origin-main` / `salvage-snapshot`）。
> 备份：`F:/AIwork/git-backups/qingbird-md-20260902-pre-hibernate.bundle`（全分支 bundle，7.4 MB）
> 实施备份：`F:/AIwork/git-backups/qingbird-md-20260903-pre-impl.bundle`
> 状态：**已实施（步骤 1–8 全部落地）**。沙箱自动化验收完成（见 §3.7），
> 真机视觉项待第 5 节清单收尾。实施中发现的计划外问题已补进第 3.5 节，改动代码前必读。

---

## 1. 目标与结论

### 1.1 要解决的问题

当前主窗口关闭 = 只 `hide()`，WebView2 实例连同整个 React 世界（CodeMirror、解析后的 DOM、翻译态）**全程常驻内存**。程序开机自启驻留托盘时，这份内存可能一整天都没被真正用过一次。

### 1.2 可行性结论

**可行，且后台能力零影响。** 已逐项核实后台路径，无一依赖 WebView：

| 后台能力 | 实现位置 | 依赖 WebView |
| --- | --- | --- |
| 系统托盘 | `src-tauri/src/tray.rs` | 否 |
| 全局快捷键 | `src-tauri/src/hotkeys.rs`（RegisterHotKey） | 否 |
| 截图翻译浮窗 | `src-tauri/src/capture/window.rs`（winit 原生窗口） | 否 |
| 翻译引擎 / 单实例 handoff | `std::thread` + ureq，`lib.rs:885` | 否 |
| 翻译缓存 | `AppTxn.cache`，落盘于 `storage::cache_path()` | 否（`lib.rs:63` 加载、`558`/`721` 保存） |

> 翻译缓存落盘这一点很关键：WebView 销毁后重建，重译会命中磁盘缓存，恢复成本远低于「全部重翻」。

### 1.3 采用方案：L0 + L1 组合

- **L0 静默启动不建 WebView**：`--minimized`（开机自启）启动后不在内存里养一个从没显示过的 WebView。
- **L1 延迟卸载**：关窗先 `hide()` 保秒回；**空闲 5 分钟**且完成草稿落盘后，才 `destroy()` 真正释放。

不做 L2（任意时刻无条件销毁 + 全量 session 持久化）——复杂度与收益不成比例，且唤醒延迟是真实体感代价。

---

## 2. 现状代码事实（改动前必读）

| 位置 | 现状 |
| --- | --- |
| `src-tauri/tauri.conf.json` | `app.windows[0]`：`label="main"`, `1280×860`, `decorations:false`, `visible:false` |
| `src-tauri/src/lib.rs:798` | `let silent = capture::startup_arg::is_silent_launch(std::env::args());` |
| `src-tauri/src/lib.rs:827-848` | `on_page_load`：`!silent` 时首帧 show；`initial` 文件延迟 500ms emit `document-changed` |
| `src-tauri/src/lib.rs:911-922` | `CloseRequested` → `api.prevent_close()` + `w.hide()`（**这就是常驻的根源**） |
| `src-tauri/src/lib.rs:925` | `.run(tauri::generate_context!())`（需改为 `.build()?.run(cb)` 才能接管 `ExitRequested`） |
| `src-tauri/src/capture/orchestrate.rs:123` | `show_main_window`：`get_webview_window("main")` → 无则静默失效 |
| `src-tauri/src/lib.rs:893` | 单实例 handoff：同上，窗口不存在时 handoff 静默丢失 |
| `src-tauri/src/tray.rs:36,44` | 托盘「显示主窗口」菜单 + 左键：同上 |
| `src/stores/useDocStore.ts:19-37` | `OpenTab`：全部只在内存，`settings` 落盘项仅 `last_file` / `workspace` |

### 依赖版本（已核实 API 存在）

- `tauri 2.11.5`、`wry 0.55.1`、`tauri-runtime 2.11.3`、`winit 0.30`
- `WebviewWindow::destroy(&self)` — `webview_window.rs:2222`
- `WebviewWindowBuilder::from_config(&manager, &WindowConfig)` — `webview_window.rs:150`
- `RunEvent::ExitRequested { code: Option<i32>, api }` + `api.prevent_exit()` — `app.rs:225` / `app.rs:90`
- `Manager::on_window_close` 真正从 manager map 移除 window + webviews — `manager/mod.rs:653`（真释放，不是假卸载）

---

## 3. 设计

### 3.1 模块划分

新增 `src-tauri/src/hibernate.rs`，集中承载休眠状态机与快照 IO，**不污染 `AppTxn`**。

```
hibernate.rs
  ├─ HIBERNATE_AT: Mutex<Option<Instant>>   计划休眠时刻；None = 无计划
  ├─ schedule(app, delay)                   关窗时调用
  ├─ cancel()                               任何唤醒路径调用
  ├─ ensure_main_window(app) -> Window      唯一的「取窗口」入口（含重建）
  ├─ spawn_main_window(app) -> Window       from_config 重建 + 重挂事件钩子
  └─ session.rs（或并入 hibernate.rs）
       ├─ SessionSnapshot / SessionTab / SessionUi   serde 结构
       ├─ save_snapshot(app, snap) -> Result<(), String>
       ├─ load_snapshot(app) -> Result<Option<SessionSnapshot>, String>
       └─ clear_snapshot(app)                        恢复成功后删除
```

### 3.2 休眠状态机

```
窗口可见 ──用户关闭──> Hidden（hide，5min 计时开始）
                          │
            唤醒（托盘/热键/handoff/二次启动）
                          ├──────────────> 取消计时 → 显示（~50ms 秒回）
                          │
                     计时到点
                          ↓
                 握手：emit session-hibernate
                          ↓
              前端收集 → save_session → hibernate_ready
                          ↓
                    destroy()  → Hibernated（WebView 归零）
                          │
                    任意唤醒请求
                          ↓
                  spawn_main_window（~0.5–2s 冷重建）
```

**计时实现**：后台线程 + 每秒轮询 `HIBERNATE_AT`。不用 `sleep(5min)`——唤醒时必须能立即取消。

**握手超时兜底**：`mpsc::Receiver::recv_timeout(3s)`。前端无响应（页面卡死/未升级的旧前端）时**直接 destroy 并打日志**，绝不因为前端不配合就永远不释放内存。

### 3.3 脏数据策略（已定：落草稿）

**只落脏 tab 的 content，干净 tab 只存 path。** 常见「看完就关」场景草稿文件极小；有改动的内容也不丢。

```rust
pub struct SessionTab {
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    /// Some = 未保存内容（草稿）；None = 干净，重建时从 path 重读
    pub content: Option<String>,
    pub mtime: Option<i64>,
    pub encoding: Option<String>,
    pub view: String,        // "source" | "preview" | "split"
    pub mode: String,        // "original" | "translation" | "bilingual"
    pub cursor_sel: [u32; 2],
    pub scroll_top: f64,
}

pub struct SessionUi {
    pub show_nav: bool,
    pub show_outline: bool,
    pub sidebar_width: f64,
    pub outline_width: f64,
    pub split_ratio: f64,
}

pub struct SessionSnapshot {
    pub version: u32,        // 恒为 1；未来结构变更据此迁移或丢弃
    pub saved_at: i64,
    pub tabs: Vec<SessionTab>,
    pub active_id: Option<String>,
    pub workspace_root: Option<String>,
    pub ui: SessionUi,
}
```

草稿路径：`storage::user_data_dir()/qingbird-session.json`（与 `qingbird-settings.json`、`qingbird-cache.json` 同目录）。

**不落盘**：`parseResult` / `htmlCache` / `doneHtml` / `translations`。理由：
- 解析结果可由 content 重算（`useDocStore.ensureParsed` 已有此路径）；
- 翻译结果走磁盘缓存（`AppTxn.cache`），重译命中缓存，成本远低于首次。

### 3.4 草稿生命周期语义（明确边界）

- **hibernate 时**落草稿；**恢复成功后立即删除**（一次性快照）。
- **托盘主动退出不落草稿**。理由：hibernate 是「用户没打算结束、系统替他省内存」，此时保住内容正确；主动退出是用户的明确意图，不该在下次冷启动冒出旧内容。
- 恢复时若任一 tab 带 `content`（脏），弹 toast：`已恢复上次未保存的内容`。

---

### 3.5 实施补充：计划外又挖出四个坑（均已修）

实施时逐行读 Tauri 源码，发现原计划的「四个坑」之外还有四处会真实翻车的地方。
它们都已落地修复，改动本模块前必读。

**坑 5 — `silent` 标志也要复位，不只是 shown 闩。**
`--minimized` 的判定结果原本是 `run()` 里的局部 `bool`，被 `on_page_load` 闭包
捕获成常量。L0 把启动时那个窗口 destroy 掉之后，从托盘唤醒会走到
`spawn_main_window`，而 `!silent` 恒为 false → 重建的窗口**永远不显示**
（进程活着、托盘活着、就是看不到窗）。现改为模块级 `SILENT: AtomicBool`，
与 `SHOWN` 一起由 `reset_startup_flags()` 复位。

**坑 6 — 冷重建必须在主线程。**
`tauri-runtime-wry` 的 `create_window` 在**后台线程**下只把建窗任务异步派发到
事件循环，而紧随其后的 `create_webview` 是**同步**查窗口表的——窗口还没建出来，
直接 `WindowNotFound`。主线程下 `send_user_message` 特判为同步执行，两步顺序
才有保证。因此 `ensure_main_window` / `spawn_main_window` 要求主线程调用：
托盘菜单与左键事件天然满足；单实例 handoff 的轮询线程必须
`app.run_on_main_thread(...)` 包一层（已在 `lib.rs` 落地）。

**坑 7 — 休眠态的 handoff 文件会丢。**
`emit` 无缓冲也无重放：窗口不存在时发出去就等于丢。休眠态下双击 `.md`，原逻辑
`emit("document-changed")` 没人接收，文件永远打不开。现改为：窗口不存在时把
路径存进 `hibernate::PENDING_OPEN`，冷重建后的前端在 `openDocFromArgs` 里用
`take_pending_open` 取走。顺序上**先恢复快照、再打开待打开文件**——后者是用户
刚刚双击的目标，它的 `openTab` 会把焦点抢到自己身上。

**坑 8 — 草稿文件的两处泄漏。**
- 休眠被取消（用户抢在 3s 握手窗口内唤醒）时，前端已落草稿但销毁放弃 →
  草稿残留到下次冷启动，冒出用户早就不用的旧内容。现放弃销毁时一并删除。
- 休眠态下从托盘主动退出，磁盘上同样留着一份草稿。现 `quit` 分支先
  `clear_snapshot()` 再 `exit(0)`，守住「主动退出不落草稿」的语义。

> 进程被强杀的残留草稿仍会在下次启动恢复——这是有意的：内容不丢。

### 3.6 验收辅助

休眠延迟可用环境变量覆盖，避免真机验收干等 5 分钟：

```powershell
$env:QINGBIRD_HIBERNATE_DELAY_SECS = "20"
npm run tauri dev
```

不设或解析失败即回默认 5 分钟（`hibernate::HIBERNATE_DELAY`，单点可调）。

**关键状态转换有 stderr 日志**（从控制台直接跑 exe 即可观察，桌面验收对照用）：

```
[wb] 窗口关闭请求已拦下（隐藏 + 排定休眠）     ← 点 × 之后
[hibernate] 关窗：排定 {n}s 后销毁 WebView     ← schedule()
[hibernate] 唤醒：取消待卸载计时                ← 倒计时中被唤醒（秒回路径）
[hibernate] 唤醒：窗口存活，直接显示
[hibernate] 到点：发起休眠握手（等前端落草稿 3s）← do_hibernate()
[hibernate] 主窗口已销毁（WebView 内存归还）    ← destroy 成功
[hibernate] 前端握手超时，强制销毁（草稿可能不完整）← 前端 3s 未应答的兜底
[hibernate] 销毁前检测到唤醒，放弃本次休眠       ← cancel 抢在销毁前
[hibernate] 主窗口冷重建完成                    ← spawn_main_window
```

### 3.7 沙箱自动化验收记录（2026-09-03）

改动全落在 `feat-webview-hibernate` 分支后，在隔离沙箱里做了进程级自动化验证
（同会话 .NET `ProcessStartInfo` 直启 + 轮询 `WorkingSet64`/`MainWindowHandle`/
WebView2 进程组内存）。结论：

**已验证（进程级客观事实）：**
- 主窗口被关掉/销毁后**进程驻留不退出**（`ExitRequested(code=None) → prevent_exit`
  生效）：多次实测 alive 恒为 true，最长存活 2m46s+。
- `schedule → do_hibernate → destroy` 全链路可执行：早期一次后台跑实测打出
  `[hibernate] 前端握手超时，强制销毁`，进程随后仍存活。
- 二次实例 handoff：第二实例正常写完 pending 后自退（`secondExited=True`），
  第一实例 WS +11MB、WebView2 进程组 +23MB——冷重建已启动。
- 全程无 `qingbird-session.json` 残留（无脏 tab 时握手未落盘，符合设计）。

**沙箱环境的两个硬限制（非代码问题，真机不受影响）：**
- 沙箱窗口站非交互，「点 × / WM_CLOSE → Tauri CloseRequested」链路无法保真驱动，
  钩子日志在沙箱里不可复现。**关窗→休眠→唤醒闭环必须真机过一遍。**
- 跨工具调用进程不可见（后台 Bash 起的进程，PowerShell/前台 Bash 都查不到），
  验收脚本必须与被测进程同会话。

**实测纠正 §5 的一处错误**：Windows 上 WebView2 是**独立 `msedgewebview2.exe`
进程组**，不是 wry 默认同进程。`qingbird-md.exe` 自身 WorkingSet 恒在 ~36MB
（启动/关窗/休眠全程不变），**主进程工作集测不出 WebView 内存**——必须量
`msedgewebview2.exe` 合计（并扣除基线，本机 WorkBuddy 等宿主会带 ~1.5GB 噪声）。

---

## 4. 实施步骤

> 每步完成后 `cargo check -p qingbird-md` 通过再进下一步。

### 步骤 1 — 接管 `ExitRequested`（**先做这个，否则后面全崩**）

`lib.rs:925` 改为：

```rust
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // code = None  → 用户关掉了最后一个窗口（我们要休眠，不许退出）
                // code = Some  → 程序调用 app.exit()（托盘「退出」，必须放行）
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
```

**验收**：托盘「退出」能正常结束进程；关掉主窗口进程不退出。

### 步骤 2 — 新增 `hibernate.rs` 骨架

含 `HIBERNATE_AT`、`schedule`、`cancel`、`ensure_main_window`、`spawn_main_window`。

`ensure_main_window` 必须成为**唯一入口**，三处调用点全部改用它：

| 原调用点 | 改为 |
| --- | --- |
| `capture/orchestrate.rs:123` `show_main_window` | `hibernate::ensure_main_window(app)` |
| `lib.rs:893` 单实例 handoff | 同上 |
| `tray.rs:36` / `tray.rs:44` | 同上 |

```rust
pub fn ensure_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("main") {
        cancel();                       // 取消待卸载计时
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(w);
    }
    spawn_main_window(app)              // 已休眠 → 冷重建
}
```

### 步骤 3 — `spawn_main_window`（**四个坑里占了三个**）

```rust
fn spawn_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    // 坑 2：必须重置 shown 闩，否则重建出来的窗口永远不 show。
    // （run() 里的 shown: Arc<Mutex<bool>> 需改为可跨模块访问，见步骤 3a）
    crate::reset_shown_flag();

    let conf = app
        .config()
        .app
        .windows
        .iter()
        .find(|c| c.label == "main")
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;

    let win = tauri::WebviewWindowBuilder::from_config(app, &conf)?.build()?;

    // 坑 3：新窗口是全新对象，CloseRequested 钩子必须重挂，
    //       否则第二次关窗会真的把应用关掉。
    let h = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = h.get_webview_window("main") {
                let _ = w.hide();
            }
            schedule(&h);               // 开始 5 分钟倒计时
        }
    });

    Ok(win)
}
```

**步骤 3a**：`run()` 里的 `shown: Arc<Mutex<bool>>` 目前是局部变量。改为模块级 `static SHOWN: Mutex<bool>`（或塞进 managed state），让 `spawn_main_window` 能重置它。

**注意**：`on_page_load` 的 `initial` 文件位在首次加载时已被 `take()`，重建时为 `None`，不会误重放——无需额外处理。`document-changed` handoff 走步骤 2 的新入口。

### 步骤 4 — L0：静默启动不建窗

`setup` 开头（`lib.rs:881`）：

```rust
if silent {
    // 开机自启：不在内存里养一个从未显示过的 WebView。
    // setup 在窗口创建之后运行，此处同步 destroy 是安全的。
    // destroy 会触发 ExitRequested(code=None)，由步骤 1 的 prevent_exit 兜住。
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
}
```

**L0 的取舍说明（已决策）**：不是「配置里不建窗口」，而是「建了立刻销毁」。因为 `from_config` 依赖 `app.config().app.windows`，清空 conf 就拿不到重建配置。代价是启动时多一次 WebView 初始化（几百 ms + 内存峰值），对开机场景可忽略；换来配置仍集中在 `tauri.conf.json`，重建时配置一致性有保障。

### 步骤 5 — 休眠握手（Rust 侧）

```
计时到点
  → app.emit("session-hibernate", ())
  → rx.recv_timeout(3s) 等前端 hibernate_ready
      Ok(())        → destroy()
      Timeout       → 记 eprintln 后 destroy()（内存释放优先于草稿完整性）
```

新增命令（挂到 `invoke_handler`）：
- `save_session(snap: SessionSnapshot) -> Result<(), String>`
- `hibernate_ready() -> Result<(), String>`
- `load_session() -> Result<Option<SessionSnapshot>, String>`
- `clear_session() -> Result<(), String>`

### 步骤 6 — 前端：休眠监听与快照上报

`src/App.tsx` 的初始化 `useEffect` 内新增：

```ts
void api.listenHibernate(async () => {
  const snap = collectSnapshot();     // 同步读 zustand，无 await
  await api.saveSession(snap);
  await api.hibernateReady();
});
```

新增 `src/lib/session.ts`：`collectSnapshot()` 从 `useDocStore` / `useUiStore` / `useWorkspaceStore` 读当前状态组装快照。

字段来源：
- tab 字段 ← `useDocStore.tabs`（`OpenTab`，`useDocStore.ts:19-37`）
- `content` 仅在 `t.content !== t.savedContent`（脏）时写入，干净时 `null`
- ui 字段 ← `useUiStore`：`showNav` / `showOutline` / `sidebarWidth` / `outlineWidth` / `splitRatio`
- `workspace_root` ← `useWorkspaceStore.root`

### 步骤 7 — 前端：恢复

`useDocStore.openDocFromArgs()` 内，恢复优先于启动参数文件：

```
load_session()
  ├─ None            → 走原有 initial 文件逻辑
  └─ Some(snap)
       ├─ version !== 1 → 丢弃，走原有逻辑
       ├─ 逐 tab 恢复：content 为 null → openTab(path)；否则直接注入 content 并标脏
       ├─ activeId → switchTab
       ├─ ui / workspace 回填
       ├─ 有脏 tab → toast「已恢复上次未保存的内容」
       └─ clear_session()
```

**注意**：`openTab` 是 `async`（走 `api.openFile`），恢复多标签页时注意并发顺序与 `activeId` 的最后设置，别让 `switchTab` 抢跑。

### 步骤 8 — 可离线测试

项目约定「测试必须可离线」。以下逻辑抽成纯函数并配单测：

| 纯函数 | 用例 |
| --- | --- |
| `should_hibernate(now, scheduled_at) -> bool` | 未到点 false；到点 true；无计划 false |
| `SessionSnapshot` serde 往返 | 脏/干净 tab 混合、`version` 校验 |
| 草稿路径构造 | 与 `user_data_dir()` 一致 |
| `snapshot_dirty_count(snap) -> usize` | 用于决定恢复时是否弹 toast |

窗口生命周期相关（`destroy` / `from_config`）无法离线测——靠第 5 节手工验收清单。

---

## 5. 验收清单

### 功能

> 标注：[沙箱✓] = 隔离沙箱进程级已验；其余待真机（窗口可见性/内容恢复/交互）
> 无法在无桌面沙箱里保真验证，逐条过完打勾即可。

- [ ] 开机自启（`--minimized`）后：托盘可用、截图翻译可用，任务管理器看不到明显 WebView 内存占用
- [ ] 关主窗口 → 托盘仍活；5 分钟内点托盘 → **秒回**（~50ms，无重建）
- [ ] 关主窗口 → 静置 5 分钟 → 内存下降 → 点托盘 → 窗口重建，内容/光标/滚动/面板宽度恢复（进程驻留 [沙箱✓]；重建启动 [沙箱✓]）
- [ ] 有未保存改动时关窗休眠 → 重建后内容仍在，toast 提示
- [ ] 托盘「退出」能正常结束进程（**坑 1 的回归测试**）
- [ ] **连续关窗两次**：第二次关窗后进程仍在、托盘仍活（**坑 3 的回归测试**）
- [ ] 休眠后触发截图翻译：流程完整，结果浮窗正常
- [ ] 休眠状态下从资源管理器双击 .md（单实例 handoff）：窗口能重建并打开该文件（handoff 传递 + 唤醒 [沙箱✓]；文件打开与置顶待真机）
- [ ] 休眠后按全局热键切阅读模式：不报错（窗口不存在时 emit 无人接收，静默）

#### 实施中新增坑的回归项

- [ ] 开机自启（`--minimized`）后点托盘「显示主窗口」：**窗口真的可见**
      （坑 5 回归：SILENT 标志未复位时窗口重建但永不显示）
- [ ] 休眠态双击 `.md`：窗口重建 **且** 该文件被打开并处于激活标签
      （坑 6 + 坑 7 回归：主线程约束 + handoff 待打开队列）
- [ ] 关窗后在 5 分钟内唤醒、再正常退出：user-data 目录下**没有**
      `qingbird-session.json` 残留（坑 8 回归：取消休眠要删草稿）
- [ ] 休眠态下直接托盘「退出」：同样无草稿残留（坑 8 回归）

### 内存验证

```powershell
# WebView2 是独立 msedgewebview2.exe 进程组，量它的合计（扣除基线）才是真实指标。
# 基线：验收前先跑一次下面两行，记录 webview 合计作基数（本机其他 WebView2 宿主 ~1.5GB）。
$app = Get-Process qingbird-md
$wv  = Get-Process msedgewebview2 -ErrorAction SilentlyContinue
"app   : {0,8} MB" -f [math]::Round($app.WorkingSet64/1MB,1)
"webview2: {0,8} MB" -f [math]::Round((($wv | Measure-Object WorkingSet64 -Sum).Sum)/1MB,1)
```

分别记录：刚启动 / 关窗后（应仍在，秒回能力保留）/ 休眠后（**WebView2 进程组
应下降 100 MB 量级甚至归零**）/ 唤醒后（回升）。`qingbird-md.exe` 自身 ~36MB
恒定，不随 WebView 生灭变化，别拿它当指标。

### 回归

- `docs/regression-checklist.md` 全量过一遍（重点：翻译、划词、保存冲突检测、工作区）
- `cargo test -p qingbird-md`

---

## 6. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 坑 1：托盘退出失效 | 步骤 1 的 `code.is_none()` 判断。验收清单已列回归项 |
| 坑 2：重建窗口永不显示 | `spawn_main_window` 重置 `shown` 闩 |
| 坑 3：二次关窗真退出 | 重建时重挂 `CloseRequested` 钩子 |
| 坑 4：休眠后唤醒路径失效 | 三处调用点统一收敛到 `ensure_main_window` |
| 前端未升级就触发休眠 | 3s 握手超时兜底 destroy，不卡死 |
| 唤醒冷延迟 0.5–2s | L1 延迟卸载已缓解（5 分钟内是秒回）。若体感不能接受，把延迟调大到 15–30 分钟（`HIBERNATE_DELAY` 常量单点可调） |
| 草稿文件损坏/版本不符 | `version` 校验失败即丢弃，走原有冷启动路径，不阻塞启动 |

**回滚**：
```bash
git checkout main                      # 分支未合并，main 完全未受影响
git branch -D feat/webview-hibernate   # 需要彻底放弃时
```
极端情况（分支也坏了）从 bundle 恢复：
```bash
git clone F:/AIwork/git-backups/qingbird-md-20260902-pre-hibernate.bundle qingbird-md-recover
```

---

## 7. 未做（有意排除）

- **L2 任意时刻无条件销毁**：唤醒延迟是真实体感代价，且需要全量 session 持久化，复杂度跳一个量级。若 L1 实测收益不足再评估。
- **翻译态（`translations` / `doneHtml`）落盘**：解析可重算、翻译走磁盘缓存，落盘性价比低，且会让草稿文件体积失控。
- **Linux / macOS 适配**：`ExitRequested` 与窗口销毁行为有平台差异（尤其 macOS 的 activation policy）。本计划仅针对 Windows 目标。
