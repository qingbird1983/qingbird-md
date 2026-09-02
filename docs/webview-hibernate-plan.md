# 主窗口 WebView 按需休眠（hibernate）实施计划

> 分支：`feat-webview-hibernate`（自 `main` @ `2ec8a58` 切出）
> 注意：**分支名不要用斜杠**。本机 `git checkout -b feat/webview-hibernate` 会改写 `.git/HEAD` 却不生成 `.git/refs/heads/feat/` 下的 ref 文件，导致 HEAD 成孤儿、171 个已跟踪文件被误报为 `new file`（此时 commit 会产生无父提交的新根）。项目沿用不含斜杠的命名（`main` / `origin-main` / `salvage-snapshot`）。
> 备份：`F:/AIwork/git-backups/qingbird-md-20260902-pre-hibernate.bundle`（全分支 bundle，7.4 MB）
> 状态：**未实施**，本文档为实施蓝图。照第 4 节顺序逐步落地即可。

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

- [ ] 开机自启（`--minimized`）后：托盘可用、截图翻译可用，任务管理器看不到明显 WebView 内存占用
- [ ] 关主窗口 → 托盘仍活；5 分钟内点托盘 → **秒回**（~50ms，无重建）
- [ ] 关主窗口 → 静置 5 分钟 → 内存下降 → 点托盘 → 窗口重建，内容/光标/滚动/面板宽度恢复
- [ ] 有未保存改动时关窗休眠 → 重建后内容仍在，toast 提示
- [ ] 托盘「退出」能正常结束进程（**坑 1 的回归测试**）
- [ ] **连续关窗两次**：第二次关窗后进程仍在、托盘仍活（**坑 3 的回归测试**）
- [ ] 休眠后触发截图翻译：流程完整，结果浮窗正常
- [ ] 休眠状态下从资源管理器双击 .md（单实例 handoff）：窗口能重建并打开该文件
- [ ] 休眠后按全局热键切阅读模式：不报错（窗口不存在时 emit 无人接收，静默）

### 内存验证

```powershell
Get-Process qingbird-md | Select-Object WorkingSet64, PrivateMemorySize64
```

分别记录：刚启动 / 关窗后 / 休眠后 / 唤醒后。WebView2 与 Tauri 主进程同进程（wry 默认），内存体现在主进程私有工作集上。**预期休眠后下降 100 MB 量级**（视文档大小与翻译态而定）。

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
