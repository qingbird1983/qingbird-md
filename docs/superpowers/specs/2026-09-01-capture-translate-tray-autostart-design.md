# 截图翻译 + 托盘常驻 + 开机自启 设计

日期：2026-09-01
来源：集成 `F:\AI\Glance-main`（Glance，Tauri 2 + Rust 截图翻译工具）的截图翻译能力到 qingbird-md-rust，并新增系统托盘常驻与开机自启。

## 1. 目标

1. **截图翻译**：全局快捷键 → 全屏选区 → 有道 OCR 翻译 → 译文浮窗覆盖在原位置（Glance 同款交互）。
2. **系统托盘**：右下角常驻图标，关闭主窗口 = 隐藏到托盘（程序驻留，热键随时可用）。
3. **开机自启**：默认关闭，托盘菜单勾选开关；开机静默启动（不弹主窗口，仅托盘）。
4. **快捷键可自定义**：截图翻译热键并入现有 `settings.hotkeys` 体系，设置弹窗可录制。

## 2. 已确认决策（对话记录）

| 决策点 | 结论 |
|--------|------|
| OCR 通道 | 直接用 Glance 的有道免费通道（`clientele="deskdict"` + 硬编码签名 secret），零凭据开箱即用。**已知风险**：逆向有道词典 PC 客户端的非官方接口，可能随版本更新失效；失效只影响截图翻译，改动收敛在 `capture/ocr.rs` 一个文件，将来再换。 |
| 主窗口 ✕ 行为 | 隐藏到托盘（`prevent_close`），程序常驻。 |
| 自启动默认状态 | 默认关；托盘菜单勾选项开关；启动带 `--minimized` 参数时静默进托盘。 |
| 集成方案 | 方案 A：Rust 模块平移 + 原生渲染浮层。React 前端除设置弹窗加热键行外**零改动**。 |
| 截图热键 | 并入 `settings.hotkeys`（键 `"capture"`），默认 `Ctrl+Shift+X`，老用户设置缺失时补默认值。 |

### 明确不做（YAGNI）

- Glance 的翻译历史、截图复制到剪贴板（`begin_copy_capture`）。
- Glance 自带的 bing/llm/内置文本翻译引擎（qingbird 已有 7 源翻译体系）。
- OCR 凭据设置 UI（免凭据通道不需要）。
- 引入 reqwest/tokio（multipart 手拼，HTTP 复用同步 ureq）。

## 3. 模块布局

```
src-tauri/src/
├── capture/            # 新模块（平移自 Glance，按 qingbird 风格适配 edition 2024）
│   ├── mod.rs
│   ├── screen.rs       # ← Glance capture.rs：BitBlt 截屏（screenshots crate）、光标所在显示器检测
│   ├── window.rs       # ← Glance capture_window.rs：winit 全屏选区窗口 + 结果浮层（原生渲染）
│   ├── ocr.rs          # ← Glance api.rs：有道 OCR 客户端（改 ureq + 手拼 multipart）
│   └── startup_arg.rs  # ← Glance startup.rs：--minimized 参数判定
├── tray.rs             # 新：托盘图标 + 菜单 + 关窗隐藏接线（~50 行）
├── hotkeys.rs          # 扩展：注册循环对 "capture" 特判回调（触发截图而非 emit 模式事件）
├── storage.rs          # Settings 加 autostart: bool（默认 false）+ capture 热键默认值补缺
├── single_instance.rs  # 扩展：第二实例无文件参数时写「仅唤醒窗口」标记
└── lib.rs              # setup 接线：托盘、autostart 插件、热键、--minimized 静默启动
```

### 依赖增量（Cargo.toml）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `screenshots` | 0.8 | BitBlt 截屏（Glance 同版本） |
| `winit` | 0.30 | 选区窗口/浮窗（Glance 同版本，锁定防 API 漂移） |
| `softbuffer` | 0.4 | 原生像素渲染 |
| `image` | 0.25，`default-features = false, features = ["png"]` | PNG 编码 |
| `base64` | 0.22 | OCR 签名（base64 头/尾 10 字符摘要） |
| `tauri-plugin-autostart` | 2 | 开机自启 |
| `tauri-plugin-notification` | 2 | 截图失败系统通知（§9） |
| tauri features | 加 `"tray-icon"` | 托盘 |

不复用的 Glance 依赖：`reqwest`（拖 tokio 全家桶）、`uuid`（salt 用时间戳纳秒替代）、`md5` 0.7（用现有 `md-5` 0.11 RustCrypto）。

## 4. 截图翻译数据流

```
全局热键（hotkeys.rs "capture" 条目，按下触发）
  → 独立线程 capture::start_capture()（Glance 的 EventLoopProxy 模式，winit 循环与 tauri 循环并存）
  → winit 全屏无边框窗口盖住光标所在显示器（背景 = 屏幕快照 + 暗化遮罩）
  → 鼠标拖拽框选；Esc / 右键取消
  → 裁剪 RGBA → PNG 编码 → ureq POST 有道 OCR（手拼 multipart/form-data）
  → 有道返回 { image: 翻译后整图 base64, resRegions: [{boundingBox, context, tranContent}] }
  → 无边框浮窗定位到框选物理坐标，绘制翻译后整图（原生，无 webview）
  → 点击 / Esc 关闭浮窗
```

OCR 调用为 `#[tauri::command(async)]` / 独立线程上跑阻塞 HTTP（同 `translate_text` 先例），不占 tauri 主线程。

### 有道接口细节（平移自 Glance api.rs）

- `POST https://ocrtran.youdao.com/ocr/imgtranocr`，multipart 字段：`multipartFile`(PNG)、`clientele="deskdict"`、`salt`（时间戳纳秒字符串）、`sign`、`from`、`to`、`isSaveHistory=false`（qingbird 不存有道云端历史）。
- `sign = md5(clientele + b64[..10] + b64.len() + b64[len-10..] + salt + SECRET)`，`SECRET` 硬编码（Glance 抓包值）。
- `errorCode != "0"` → Err（错误信息带 code）。
- 语言方向：第一版固定 `from=auto, to=zh-CHS`（青鸟定位中英互译；截图英文→出中文是主路径）。Glance 的多语言选择 UI 不搬，将来有需求再加设置项。

## 5. 托盘设计（tray.rs）

- `TrayIconBuilder` + 图标 `icons/icon-source.png`，tooltip「青鸟 Markdown」。
- 菜单：
  - 显示主窗口
  - 截图翻译（等价于按全局热键）
  - ☑ 开机自启（`CheckMenuItem`，勾选状态 = `settings.autostart`）
  - 退出（`app.exit(0)`）
- 左键点击托盘 = 显示主窗口。
- 主窗口 `on_window_event(CloseRequested)` → `prevent_close` + `hide()`（**仅隐藏**，不杀翻译/查词进行中的状态）。

## 6. 开机自启

- `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"]))`。
- 持久化权威 = `settings.autostart`：启动时仅当 `settings.autostart` 为 true 时调用 enable（无需反向 disable——没有其他写 Run 键的路径）；托盘菜单点击 → 取反 → apply → 落盘（Rust 侧直接改 `storage::Settings.autostart` 后保存，不 emit `settings-updated`——前端无此状态展示）。
- `startup_arg.rs::is_silent_launch(args)`：命令行含精确 `--minimized` → 主窗口不显示，静默驻留托盘（Glance 同款，含 3 个平移单测）。

## 7. 单实例唤醒（托盘驻留的配套修复）

现状：驻留托盘后用户再次双击桌面图标 → 第二实例 `acquire_lock` 失败 → 无文件参数直接 return → **首实例无反应**（隐藏窗口拉不出来）。

修复：第二实例无文件参数时也写 pending 标记（约定特殊值，如 `show`）；`lib.rs` 轮询线程收到非文件路径标记 → 仅 `show + unminimize + focus`，不派发 `document-changed`。`--minimized` 静默启动的实例同理可被唤醒。

## 8. 设置与前端改动

### storage.rs

```rust
pub struct Settings {
    // ... 既有字段不动 ...
    #[serde(default)]           // 老设置文件缺字段 → false
    pub autostart: bool,
}
```

`hotkeys` HashMap 新键 `"capture"`：`load_settings_from` 对缺失的 `capture` 键补默认 `"Ctrl+Shift+X"`（新装与老升级用户都开箱即用；用户显式清空热键后不再补——补缺仅当键不存在，值为空串即用户意图）。

### 前端（唯一改动点）

- `SettingsModal.tsx`：热键录制列表（`HOTKEY_MODES` 遍历渲染）加一行 `["capture", "截图翻译"]`；分组注释「阅读模式快捷键」改「快捷键」。录制器/Meta 拒绝 toast/须含 Ctrl/Alt/Shift 约束全部复用，零新逻辑。
- 保存即生效：复用现有 `save_settings → hotkeys::sync` 全量重注册链路。

### hotkeys.rs

`MODES` 三项循环照旧 emit `hotkey-mode`；`"capture"` 特判：回调直接调 `capture::start_capture()`（spawn 线程，不阻塞主线程）。Meta/空值拒绝逻辑复用 `registrable`。

## 9. 错误处理

| 场景 | 行为 |
|------|------|
| OCR 网络失败 / `errorCode != 0` | 选区窗口立即关闭 + 系统通知提示错误（`tauri-plugin-notification` 官方插件，一行接入——Tauri 2 托盘无内置气泡 API）；主窗口 toast 不依赖（窗口可能隐藏）。 |
| 截屏/显示器检测失败 | 同上：关窗 + 气泡。 |
| 浮窗绘制失败 | 关窗（静默，OCR 结果已在云端可用侧失效可重试）。 |
| 翻译中再次按热键 | 忽略第二次触发（选区/浮窗互斥，`start_capture` 入口原子检查）。 |
| 平移代码的 unwrap | 逐一清除（qingbird `panic="abort"`，panic 即闪退不可接受）。 |

## 10. 平移适配清单（Glance → qingbird）

- edition 2021 → 2024：`unsafe` 块语法、static 作用域收紧处逐一修正。
- reqwest async → ureq 同步：`api.rs` 重写为阻塞调用；multipart body 手拼（boundary + 分段头 + 字节体，单测锁结构）。
- md5 0.7 → md-5 0.11：`Md5::digest` 输出 hex 小写（与 Glance `format!("{:x}", md5::compute(..))` 等价）。
- uuid salt → `SystemTime::now()` 纳秒字符串。
- winit 0.30 + softbuffer 0.4 版本锁定不动。
- Glance 的 `self_test.rs` / 调试 dump 不搬。

## 11. 测试与验证

### 单测（cargo test --workspace）

- `ocr.rs`：`build_upload_sign` 已知输入输出对（平移 Glance 签名逻辑后回归）；multipart body 结构（boundary 唯一、字段齐全、文件段二进制完整）。
- `startup_arg.rs`：`--minimized` 精确匹配 / 正常启动 / `--minimized=true` 不误判（平移 Glance 3 测试）。
- `storage.rs`：老设置文件无 `capture` 键 → 加载后补默认 `Ctrl+Shift+X`；`autostart` 缺字段 → false。
- `hotkeys.rs`：现有测试不动，`registrable` 对 capture 键同口径。

### 构建

- `cargo test --workspace` 全绿；`npm run build`（tsc 严格 + vite）通过；`npx tauri build` 产出 NSIS。

### 手测（追加 docs/regression-checklist.md）

1. 热键截图 → 框选 → 浮窗显示译文；Esc/右键取消。
2. 设置弹窗录制截图热键 → 保存即生效；含 Win 键 → toast 拒绝。
3. 关闭主窗口 → 托盘驻留 → 托盘左键/菜单恢复；热键仍可用。
4. 托盘「开机自启」勾选 → 注册表 Run 项生效；取消勾选移除。
5. `--minimized` 启动 → 仅托盘，无主窗口。
6. 驻留后双击桌面图标 → 主窗口唤醒。
7. 断网截图 → 气泡报错、无残留窗口。
