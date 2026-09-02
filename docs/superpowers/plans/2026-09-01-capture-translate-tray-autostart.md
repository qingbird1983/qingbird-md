# 截图翻译 + 托盘常驻 + 开机自启 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Glance 的截图翻译（热键→框选→有道 OCR→原生浮窗译文）平移进 qingbird-md-rust，并新增系统托盘常驻与开机自启，截图热键可自定义。

**Architecture:** 平移 Glance 的 `capture.rs`/`capture_window.rs`/`api.rs` 为 qingbird 的 `src-tauri/src/capture/` 模块（Windows-only，同步线程模型替代 Glance 的 tokio）；结果浮层沿用 winit+softbuffer 原生渲染（React 零改动）；托盘/自启/失败通知用官方插件；热键并入现有 `settings.hotkeys` 体系。

**Tech Stack:** Tauri 2（+tray-icon/image-png feature）、winit 0.30 + softbuffer 0.4、screenshots 0.8（BitBlt）、image 0.25（png+jpeg）、ureq 2（手拼 multipart）、md5 签名、tauri-plugin-autostart / -notification。

**Spec:** `docs/superpowers/specs/2026-09-01-capture-translate-tray-autostart-design.md`
**平移源码树:** `F:\AI\Glance-main\src-tauri\src\`（执行任务时直接读源文件对照）

## Global Constraints

- 平台：Windows-only（qingbird 仅发 NSIS）。平移时**删除** Glance 源码中所有 `#[cfg(target_os = "macos")]` / `#[cfg(target_os = "linux")]` 分支与 `dev_server`/`self_test` 相关物。
- 锁定版本：winit `0.30`（features `rwh_06`）、softbuffer `0.4`、screenshots `0.8`。不引入 reqwest/tokio/uuid。
- qingbird 是 edition 2024 + `panic="abort"`：平移代码不得含会 panic 的 `unwrap()`/`expect()`（`Mutex::lock` 的 `expect(poisoned)` 惯例除外）；`unsafe` 块写显式 `unsafe { }` 语法。
- HTTP 一律同步 ureq（阻塞调用必须发生在 `std::thread::spawn` 的线程上，同 `translate_text` 先例）。
- 语言方向固定 `from="auto"`, `to="zh-CHS"`。
- 每任务结束：`cargo test --workspace`（涉前端时加 `npm run build`）必须全绿后 `git commit`。
- 不改 `src/types/ipc.ts` 现有契约（本功能不加前端 IPC 命令）。

---

### Task 1: 依赖增量 + capture 模块骨架 + startup_arg.rs

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/capture/mod.rs`
- Create: `src-tauri/src/capture/startup_arg.rs`
- Modify: `src-tauri/src/lib.rs`（仅加 `mod capture;` 一行）
- Modify: `src-tauri/tauri.conf.json`（main 窗口加 `"visible": false`）

**Interfaces:**
- Produces: `capture::startup_arg::SILENT_START_ARG: &str`（= `"--minimized"`）、`capture::startup_arg::is_silent_launch<I, S: AsRef<OsStr>>(args: I) -> bool`。Task 9 消费。

- [ ] **Step 1: 改 Cargo.toml 依赖**

`[dependencies]` 中把现有 `tauri` 行替换并追加：

```toml
tauri = { version = "2", features = ["protocol-asset", "tray-icon", "image-png"] }
base64 = "0.22"
image = { version = "0.25", default-features = false, features = ["png", "jpeg"] }
screenshots = "0.8"
softbuffer = "0.4"
winit = { version = "0.30", features = ["rwh_06"] }
tauri-plugin-autostart = "2"
tauri-plugin-notification = "2"
```

文件末尾追加（调试构建截图提速：Glance 实测 BitBlt 473ms→50-100ms）：

```toml
[profile.dev.package.screenshots]
opt-level = 2

[profile.dev.package.image]
opt-level = 2

[profile.dev.package.softbuffer]
opt-level = 2

[profile.dev.package.winit]
opt-level = 2
```

`tauri.conf.json` 的 main 窗口对象加（Task 9 的 silent 启动依赖它；本任务先落配置，编译不受影响）：

```json
"visible": false
```

- [ ] **Step 2: 写 capture/startup_arg.rs（含失败测试）**

平移自 `F:\AI\Glance-main\src-tauri\src\startup.rs`（原文照搬，仅注释中文化）：

```rust
//! `--minimized` 静默启动参数判定（平移自 Glance startup.rs）。
//! 开机自启注册项带此参数运行，主窗口保持隐藏、仅驻留托盘。

use std::ffi::OsStr;

pub const SILENT_START_ARG: &str = "--minimized";

pub fn is_silent_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new(SILENT_START_ARG))
}

#[cfg(test)]
mod tests {
    use super::{is_silent_launch, SILENT_START_ARG};

    #[test]
    fn detects_autostart_argument() {
        assert!(is_silent_launch(["qingbird-md", SILENT_START_ARG]));
    }

    #[test]
    fn treats_normal_launch_as_visible() {
        assert!(!is_silent_launch(["qingbird-md"]));
    }

    #[test]
    fn requires_an_exact_argument_match() {
        assert!(!is_silent_launch(["qingbird-md", "--minimized=true"]));
    }
}
```

`capture/mod.rs`：

```rust
//! 截图翻译子系统（平移自 Glance，Windows-only）。
pub mod startup_arg;
```

`lib.rs` 顶部 mod 声明区加 `mod capture;`。

- [ ] **Step 3: 跑测试确认通过**

Run: `cargo test -p qingbird-md capture::startup_arg`
Expected: 3 passed。然后 `cargo build` 确认新依赖解析无冲突（winit/screenshots 首次编译较久属正常）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/capture/ src-tauri/src/lib.rs
git commit -m "feat(capture): 依赖增量 + capture 模块骨架 + --minimized 判定"
```

---

### Task 2: storage.rs — autostart 字段 + capture 热键默认补缺

**Files:**
- Modify: `src-tauri/src/storage.rs`

**Interfaces:**
- Produces: `Settings.autostart: bool`（默认 false）；`load_settings_from` 保证返回的 `hotkeys` 含 `"capture"` 键（缺失时补 `"Ctrl+Shift+X"`；显式空串=用户禁用，不补）。Task 8/9 消费。

- [ ] **Step 1: 写失败测试**

在 `storage.rs` 的 `mod tests` 追加：

```rust
#[test]
fn capture_hotkey_defaults_added_when_missing() {
    // 老用户设置文件无 capture 键 → 加载后补默认值（spec §8）
    let dir = std::env::temp_dir().join(format!("qingbird-hk-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("qingbird-settings.json");
    std::fs::write(&p, r#"{"provider":"auto"}"#).unwrap();
    let s = load_settings_from(&p);
    assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
    // 显式空串 = 用户禁用，不得覆盖
    std::fs::write(&p, r#"{"hotkeys":{"capture":""}}"#).unwrap();
    let s2 = load_settings_from(&p);
    assert_eq!(s2.hotkeys.get("capture").map(String::as_str), Some(""));
    // autostart 缺字段 → false
    assert!(!s2.autostart);
}

#[test]
fn default_settings_carry_capture_hotkey() {
    let s = Settings::default();
    assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
    assert!(!s.autostart);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p qingbird-md storage::`
Expected: FAIL（无 autostart 字段 / 无 capture 键）

- [ ] **Step 3: 实现**

`Settings` 结构体加字段（`theme` 之后）：

```rust
    /// 开机自启（托盘菜单开关；持久化权威，启动时 apply 到 autostart 插件）。
    #[serde(default)]
    pub autostart: bool,
```

`Default` 实现加 `autostart: false,`，且 `hotkeys` 初始化改为：

```rust
            hotkeys: HashMap::from([("capture".to_string(), "Ctrl+Shift+X".to_string())]),
```

`load_settings_from` 的 `Ok(v) => return v` 分支改为：

```rust
            Ok(mut v) => {
                // capture 热键补缺：老设置文件升级后开箱即用；显式空串=禁用不补
                v.hotkeys
                    .entry("capture".to_string())
                    .or_insert_with(|| "Ctrl+Shift+X".to_string());
                return v;
            }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test -p qingbird-md storage::`
Expected: 全部 PASS（含既有 5 个测试不回归）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/storage.rs
git commit -m "feat(settings): autostart 字段 + capture 热键默认补缺"
```

---

### Task 3: single_instance.rs — 托盘驻留后的双击唤醒

**Files:**
- Modify: `src-tauri/src/single_instance.rs`
- Modify: `src-tauri/src/lib.rs`（`run()` 第二实例分支 + 轮询线程）

**Interfaces:**
- Produces: `single_instance::write_show_wake()`（第二实例无文件参数时调用）；约定 pending 文件内容为字面量 `show` 时=仅唤醒窗口。Task 9 的托盘驻留体验依赖此行为（否则驻留后双击图标无响应）。

- [ ] **Step 1: 写失败测试**

`single_instance.rs` 的 `mod tests` 追加：

```rust
    #[test]
    fn show_wake_marker_roundtrip() {
        let dir = std::env::temp_dir().join(format!("qingbird-wake-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let pfile = dir.join("p.txt");
        // write_show_wake 的路径可注入版本：写标记 → 读回 == "show"
        fs::write(&pfile, b"show").unwrap();
        let s = fs::read_to_string(&pfile).unwrap();
        assert_eq!(s.trim(), "show");
    }
```

（`write_show_wake` 本体走固定 appdata 路径无法单测，逻辑仅两行 `fs::write`，由 roundtrip 测试锁约定。）

- [ ] **Step 2: 实现**

`single_instance.rs` 在 `write_pending` 后追加：

```rust
/// Ask the running instance to just show its main window (second launch
/// without a file argument — tray-resident app must respond to icon clicks).
pub fn write_show_wake() {
    let _ = fs::create_dir_all(user_data_dir());
    let _ = fs::write(pending_path(), b"show");
}

/// Pending payload sentinel: contents exactly `show` mean "wake the window
/// only", anything else is a file path to open.
pub fn is_show_wake(p: &Path) -> bool {
    p.to_string_lossy() == "show"
}
```

`lib.rs` 的 `run()` 中第二实例分支（`if lock.is_none()` 内）改为：

```rust
        if let Some(p) = file_arg {
            single_instance::write_pending(&p);
        } else {
            // 无文件参数：仅唤醒驻留托盘的首实例主窗口
            single_instance::write_show_wake();
        }
```

（轮询线程消费 `is_show_wake` 在 Task 9 接线时一并完成——本任务先落标记端，轮询处暂不分支也不会错：现有代码会把 `"show"` 当路径 emit，前端打开失败静默，Task 9 修正。）

- [ ] **Step 3: 跑测试 + 编译**

Run: `cargo test -p qingbird-md single_instance:: && cargo build`
Expected: PASS，编译通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/single_instance.rs src-tauri/src/lib.rs
git commit -m "feat(single-instance): 第二实例无文件参数时写唤醒标记"
```

---

### Task 4: capture/screen.rs — BitBlt 截屏平移

**Files:**
- Create: `src-tauri/src/capture/screen.rs`
- Modify: `src-tauri/src/capture/mod.rs`

**Interfaces:**
- Produces:
  - `screen::MonitorInfo { scale_factor: f64, x: i32, y: i32, width: u32, height: u32 }`
  - `screen::CursorMonitorResult { screen: screenshots::Screen, monitor: MonitorInfo }`
  - `screen::find_cursor_monitor() -> Result<CursorMonitorResult, String>`
  - `screen::capture_screen_to_memory(screen: screenshots::Screen) -> Result<(Vec<u8>, u32, u32), String>`（RGBA 字节, 宽, 高）
- Consumes: 无（crate 底座）。Task 7 消费。

- [ ] **Step 1: 平移 Windows 分支**

源：`F:\AI\Glance-main\src-tauri\src\capture.rs` 的 **非 macOS 分支**（57-76、156-182、227-243、306-336 行）。目标文件（删 macOS/Linux cfg 分支、tracing→eprintln、错误类型 String）：

```rust
//! BitBlt 截屏 + 光标所在显示器检测（平移自 Glance capture.rs，Windows-only）。

use screenshots::Screen;

#[derive(Clone, Copy)]
pub struct MonitorInfo {
    pub scale_factor: f64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct CursorMonitorResult {
    pub screen: Screen,
    pub monitor: MonitorInfo,
}

/// 光标当前所在显示器（截图盖哪块屏）。
pub fn find_cursor_monitor() -> Result<CursorMonitorResult, String> {
    let (cursor_x, cursor_y) = get_cursor_position()
        .map_err(|e| format!("failed to get cursor position: {e}"))?;
    let screen = Screen::from_point(cursor_x, cursor_y)
        .map_err(|e| format!("no screen at cursor ({cursor_x},{cursor_y}): {e}"))?;
    let info = &screen.display_info;
    Ok(CursorMonitorResult {
        screen,
        monitor: MonitorInfo {
            scale_factor: info.scale_factor as f64,
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
        },
    })
}

/// 主显示器兜底。
pub fn find_primary_screen() -> Result<CursorMonitorResult, String> {
    let screens = Screen::all().map_err(|e| e.to_string())?;
    let primary = screens
        .into_iter()
        .find(|s| s.display_info.is_primary)
        .ok_or_else(|| "no primary monitor found".to_string())?;
    let info = &primary.display_info;
    Ok(CursorMonitorResult {
        monitor: MonitorInfo {
            scale_factor: info.scale_factor as f64,
            x: info.x,
            y: info.y,
            width: info.width,
            height: info.height,
        },
        screen: primary,
    })
}

#[cfg(target_os = "windows")]
fn get_cursor_position() -> Result<(i32, i32), String> {
    #[repr(C)]
    struct Point { x: i32, y: i32 }
    extern "system" {
        fn GetCursorPos(lpPoint: *mut Point) -> i32;
    }
    let mut pt = Point { x: 0, y: 0 };
    // 失败返回 0：不 panic（abort profile 下 panic 即闪退），报错由上层处理
    let ok = unsafe { GetCursorPos(&mut pt) };
    if ok == 0 {
        return Err("GetCursorPos failed".into());
    }
    Ok((pt.x, pt.y))
}

#[cfg(not(target_os = "windows"))]
fn get_cursor_position() -> Result<(i32, i32), String> {
    Err("cursor position only supported on Windows".into())
}

/// 截屏到内存 RGBA（无文件 IO）。
pub fn capture_screen_to_memory(screen: Screen) -> Result<(Vec<u8>, u32, u32), String> {
    let t0 = std::time::Instant::now();
    let capture = screen.capture().map_err(|e| e.to_string())?;
    let w = capture.width();
    let h = capture.height();
    let rgba = capture.into_raw();
    eprintln!(
        "[capture] {}x{} ({:.1} MB) in {:?}",
        w,
        h,
        rgba.len() as f64 / 1_048_576.0,
        t0.elapsed()
    );
    Ok((rgba, w, h))
}
```

`capture/mod.rs` 加 `pub mod screen;`。

- [ ] **Step 2: 编译验证**

Run: `cargo build`
Expected: 通过。截屏依赖真实显示器，不写单测（Task 11 手测覆盖）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/
git commit -m "feat(capture): 平移 BitBlt 截屏与显示器检测（Windows）"
```

---

### Task 5: capture/window.rs — winit 选区窗口 + 结果浮层平移

**Files:**
- Create: `src-tauri/src/capture/window.rs`
- Modify: `src-tauri/src/capture/mod.rs`

**Interfaces:**
- Produces（全部原样平移自 Glance capture_window.rs 的公开面）:
  - `pub enum CaptureCommand { StartCapture { rgba: Vec<u8>, img_w: u32, img_h: u32, scale_factor: f64, monitor_x: i32, monitor_y: i32, event_tx: mpsc::Sender<CaptureEvent> }, ShowResult { rgba_bytes: Vec<u8>, x: u32, y: u32, w: u32, h: u32 }, ShowLoading, Close }`
  - `pub enum CaptureEvent { Selection { x: u32, y: u32, w: u32, h: u32 }, Cancelled }`
  - `pub fn capture_proxy() -> EventLoopProxy<CaptureCommand>`
  - `pub fn start_capture(rgba, img_w, img_h, scale_factor, monitor_x, monitor_y, event_tx)`
  - `pub fn crop_rgba(rgba: &[u8], img_w: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8>`
  - `pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String>`
- Consumes: 无。Task 7 消费。

- [ ] **Step 1: 整文件平移 + 定点改写**

以 `F:\AI\Glance-main\src-tauri\src\capture_window.rs`（753 行）为基底复制到 `src-tauri/src/capture/window.rs`，应用以下改写（其余逐行保留，含全部中文行为注释）：

1. **删** `use crate::error::{AppError, AppResult};`；`encode_png` 签名改为：

```rust
pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    use image::{ImageBuffer, RgbaImage};
    let img: RgbaImage = ImageBuffer::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| "invalid RGBA dimensions for PNG".to_string())?;
    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("PNG encode error: {e}"))?;
    Ok(png_bytes)
}
```

2. **tracing 全部换 eprintln**：`tracing::error!(...)` → `eprintln!("[capture] ERROR ...")`；`tracing::debug!` / `tracing::info!` 调试行保留为 `eprintln!` 或整行删除（推荐删除，保留 4 处 error 级）。
3. **event_loop build 的 expect**：`expect("failed to build winit event loop")` 与 `expect("capture event loop crashed")` 是进程级致命（事件循环死了截图功能整体失效），abort 下直接退出可接受——**保留**。
4. `Context::new(...)` / `Surface::new(...)` 的 expect 改为错误上送（窗口创建失败不该炸进程）：

```rust
        let ctx = match Context::new(window.clone()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[capture] softbuffer context: {e}");
                let _ = event_tx.send(CaptureEvent::Cancelled);
                return;
            }
        };
        let surface = match Surface::new(&ctx, window.clone()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[capture] softbuffer surface: {e}");
                let _ = event_tx.send(CaptureEvent::Cancelled);
                return;
            }
        };
```

5. **删 macOS cfg 块**（`#[cfg(target_os = "macos")] let attrs = ...`）。
6. `WindowEvent::Resized` 里 `NonZeroU32::new(size.width).unwrap()` 改防御：

```rust
            WindowEvent::Resized(size) => {
                if let (Some(nz_w), Some(nz_h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) {
                    let _ = session.surface.resize(nz_w, nz_h);
                    session.surface_ready = true;
                    session.window.request_redraw();
                }
            }
```

- [ ] **Step 2: 纯函数单测**

`window.rs` 末尾追加（crop/normalize 是纯逻辑，值得锁行为；像素绘制靠 Task 11 手测）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rect_orders_and_clamps() {
        use winit::dpi::PhysicalPosition;
        let a = PhysicalPosition::new(30.0, 10.0);
        let b = PhysicalPosition::new(10.0, 40.0);
        assert_eq!(normalize_rect(a, b), (10, 10, 20, 30));
        // 负坐标钳到 0
        let n = PhysicalPosition::new(-5.0, -1.0);
        assert_eq!(normalize_rect(n, a), (0, 0, 30, 10));
    }

    #[test]
    fn crop_rgba_extracts_rows() {
        // 4x2 图，每像素 4 字节：取第二行前两个像素
        let img: Vec<u8> = (0..8u8).flat_map(|i| [i, 0, 0, 255]).collect();
        let crop = crop_rgba(&img, 4, 0, 1, 2, 1);
        assert_eq!(crop, vec![4u8, 0, 0, 255, 5, 0, 0, 255]);
        // 越界行安全跳过（不 panic）：y=1,h=2 的第二行整行越界
        assert_eq!(crop_rgba(&img, 4, 3, 1, 5, 2).len(), 0);
    }

    #[test]
    fn rgba_to_softbuffer_packs_rgb_and_drops_alpha() {
        assert_eq!(rgba_to_softbuffer(&[0x12, 0x34, 0x56, 0xAA]), vec![0x123456]);
    }
}
```

- [ ] **Step 3: 跑测试**

Run: `cargo test -p qingbird-md capture::window`
Expected: 3 passed。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture/
git commit -m "feat(capture): 平移 winit 选区窗口与结果浮层"
```

---

### Task 6: capture/ocr.rs — 有道 OCR（ureq + 手拼 multipart + md5 签名）

**Files:**
- Create: `src-tauri/src/capture/ocr.rs`
- Modify: `src-tauri/src/capture/mod.rs`

**Interfaces:**
- Produces:
  - `ocr::OcrResult { image_base64: String }`
  - `ocr::translate_image(png: &[u8], from: &str, to: &str) -> Result<OcrResult, String>`（阻塞，须在 worker 线程调用）
- Consumes: 无。Task 7 消费。

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_hex_matches_known_vector() {
        // MD5("abc") 公认测试向量
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn upload_sign_is_stable_hex_and_salt_sensitive() {
        let png = b"0123456789";
        let s1 = upload_sign(png, "42");
        let s2 = upload_sign(png, "42");
        let s3 = upload_sign(png, "43");
        assert_eq!(s1, s2, "同输入同 salt 必须同签名");
        assert_ne!(s1, s3, "salt 参与签名");
        assert_eq!(s1.len(), 32);
        assert!(s1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn salt_is_nonempty_numeric() {
        let a = salt_string();
        assert!(!a.is_empty());
        assert!(a.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn multipart_body_structure() {
        let body = multipart_body(
            "BOUNDARY",
            b"\x89PNG-binary\xff",
            &[("clientele", CLIENTELE.to_string()), ("salt", "42".into())],
        );
        let s = String::from_utf8_lossy(&body);
        assert!(s.contains("--BOUNDARY\r\nContent-Disposition: form-data; name=\"clientele\"\r\n\r\ndeskdict\r\n"));
        assert!(s.contains("name=\"salt\"\r\n\r\n42\r\n"));
        // 文件段：头 + 原始字节（二进制不破坏）+ 收尾
        assert!(s.contains("name=\"multipartFile\"; filename=\"capture.png\"\r\nContent-Type: image/png\r\n\r\n"));
        assert!(body.windows(9).any(|w| w == b"\x89PNG-bin".as_slice()));
        assert!(body.ends_with(b"\r\n--BOUNDARY--\r\n"));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p qingbird-md capture::ocr`
Expected: FAIL（模块未实现）

- [ ] **Step 3: 实现**

```rust
//! 有道 OCR 图片翻译客户端（平移自 Glance api.rs，reqwest→ureq 同步改造）。
//!
//! 已知风险（spec §2）：走有道词典 PC 客户端通道（clientele=deskdict + 抓包
//! secret），非官方接口，可能随版本更新失效——失效只影响截图翻译，换通道
//! 只改本文件。

use base64::Engine;
use md5::{Digest, Md5};
use serde::Deserialize;

const ENDPOINT: &str = "https://ocrtran.youdao.com/ocr/imgtranocr";
const IMAGE_TRANSLATE_SECRET: &str = "VPaHE3kX_vl4BhgYiu2n";
pub const CLIENTELE: &str = "deskdict";
// 有道接口校验 UA（Glance 抓包结论），照搬 Chrome UA
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub struct OcrResult {
    /// 翻译后整图（JPEG）的 base64——浮窗直接绘制。
    pub image_base64: String,
}

/// 阻塞网络调用：必须在 worker 线程上跑。
pub fn translate_image(png: &[u8], from: &str, to: &str) -> Result<OcrResult, String> {
    let salt = salt_string();
    let sign = upload_sign(png, &salt);
    let boundary = "qingbird-capture-9f2e7a1b";
    let fields = [
        ("clientele", CLIENTELE.to_string()),
        ("salt", salt),
        ("sign", sign),
        ("from", from.to_string()),
        ("to", to.to_string()),
        ("isSaveHistory", "false".to_string()), // qingbird 不存有道云端历史
        ("isSyncSaveHistory", "false".to_string()),
        ("funDesc", "photo_translate".to_string()),
    ];
    let body = multipart_body(boundary, png, &fields);

    let resp = ureq::post(ENDPOINT)
        .set("User-Agent", USER_AGENT)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .timeout(std::time::Duration::from_secs(30))
        .send(body.as_slice())
        .map_err(|e| format!("有道 OCR 请求失败: {e}"))?;
    let text = resp
        .into_string()
        .map_err(|e| format!("有道 OCR 响应读取失败: {e}"))?;
    parse_response(&text)
}

#[derive(Debug, Deserialize)]
struct RawResponse {
    #[serde(default, rename = "errorCode")]
    error_code: String,
    #[serde(default)]
    image: String,
}

fn parse_response(text: &str) -> Result<OcrResult, String> {
    let raw: RawResponse =
        serde_json::from_str(text).map_err(|e| format!("有道 OCR 响应解析失败: {e}"))?;
    if raw.error_code != "0" {
        return Err(format!("有道 OCR errorCode={}", raw.error_code));
    }
    if raw.image.is_empty() {
        return Err("未识别到文字".into());
    }
    Ok(OcrResult { image_base64: raw.image })
}

/// 平移自 Glance build_upload_sign：
/// md5(clientele + b64[..10] + b64.len() + b64[len-10..] + salt + SECRET)
fn upload_sign(png: &[u8], salt: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let digest_src = format!("{}{}{}", &b64[..10], b64.len(), &b64[b64.len() - 10..]);
    md5_hex(&format!("{CLIENTELE}{digest_src}{salt}{IMAGE_TRANSLATE_SECRET}"))
}

fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// salt：纳秒时间戳字符串（有道仅要求唯一性；替代 Glance 的 uuid 依赖）。
fn salt_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

fn multipart_body(boundary: &str, png: &[u8], fields: &[(&str, String)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"multipartFile\"; filename=\"capture.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}
```

`capture/mod.rs` 加 `pub mod ocr;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test -p qingbird-md capture::ocr`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/capture/
git commit -m "feat(capture): 有道 OCR 客户端（ureq multipart + md5 签名）"
```

---

### Task 7: capture/orchestrate.rs — 截图→OCR→浮窗编排

**Files:**
- Create: `src-tauri/src/capture/orchestrate.rs`
- Modify: `src-tauri/src/capture/mod.rs`

**Interfaces:**
- Produces: `orchestrate::begin(app: tauri::AppHandle) -> Result<(), String>`——非阻塞（内部 spawn 线程）；重复触发返回 Err。Task 8（热键）/ Task 9（托盘）消费。
- Consumes: Task 4 `screen::*`、Task 5 `window::{start_capture, capture_proxy, CaptureCommand, CaptureEvent, crop_rgba, encode_png}`、Task 6 `ocr::translate_image`。

- [ ] **Step 1: 实现**

```rust
//! 截图翻译编排：热键/托盘入口 → 截屏 → 选区窗口事件循环 → OCR → 结果浮窗。
//! 平移自 Glance commands.rs 的 begin_capture_impl + handle_capture_events，
//! tokio spawn_blocking → std::thread（qingbird 同步架构）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use base64::Engine;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use super::ocr;
use super::screen;
use super::window::{self, CaptureCommand, CaptureEvent};

/// 单飞互斥：已有会话时忽略再次触发。
static CAPTURING: AtomicBool = AtomicBool::new(false);

/// 入口（非阻塞）：截屏与后续流程在独立线程，热键回调（主线程）立即返回。
pub fn begin(app: tauri::AppHandle) -> Result<(), String> {
    CAPTURING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有截图会话进行中".to_string())?;
    std::thread::Builder::new()
        .name("capture-flow".into())
        .spawn(move || {
            if let Err(e) = run_flow(app) {
                eprintln!("[capture] flow failed: {e}");
            }
            CAPTURING.store(false, Ordering::SeqCst);
        })
        .map(|_| ())
        .map_err(|e| format!("capture thread spawn failed: {e}"))
}

fn run_flow(app: tauri::AppHandle) -> Result<(), String> {
    // 主窗口在前台则先隐藏（别把自己截进去），会话结束恢复
    let restore_main = hide_main_window(&app);

    let found = screen::find_cursor_monitor()?;
    let monitor = found.monitor;
    let (rgba, img_w, img_h) = screen::capture_screen_to_memory(found.screen)?;

    let (event_tx, event_rx) = mpsc::channel::<CaptureEvent>();
    window::start_capture(rgba, img_w, img_h, monitor.scale_factor, monitor.x, monitor.y, event_tx);

    // 事件循环：Selection → OCR → ShowResult；Cancelled/错误 → 收尾
    while let Ok(event) = event_rx.recv() {
        match event {
            CaptureEvent::Selection { x, y, w, h } => {
                let _ = window::capture_proxy().send_event(CaptureCommand::ShowLoading);
                match translate_selection(&rgba, img_w, x, y, w, h) {
                    Ok((result_rgba, rw, rh)) => {
                        let _ = window::capture_proxy().send_event(CaptureCommand::ShowResult {
                            rgba_bytes: result_rgba,
                            x,
                            y,
                            w: rw,
                            h: rh,
                        });
                    }
                    Err(e) => {
                        eprintln!("[capture] translate failed: {e}");
                        notify_error(&app, &e);
                        let _ = window::capture_proxy().send_event(CaptureCommand::Close);
                        break;
                    }
                }
            }
            CaptureEvent::Cancelled => break,
        }
    }

    if restore_main {
        show_main_window(&app);
    }
    Ok(())
}

/// 裁剪 → PNG → 有道 OCR → base64 解码 → RGBA（阻塞，运行在 capture-flow 线程）。
fn translate_selection(
    rgba: &[u8],
    img_w: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(Vec<u8>, u32, u32), String> {
    let crop = window::crop_rgba(rgba, img_w, x, y, w, h);
    let png = window::encode_png(&crop, w, h)?;
    let result = ocr::translate_image(&png, "auto", "zh-CHS")?;
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(result.image_base64.as_bytes())
        .map_err(|e| format!("译文图 base64 解码失败: {e}"))?;
    decode_image_rgba(&jpeg)
}

/// 有道返回 JPEG（ImageReader 自动探测格式）。
fn decode_image_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let img = reader
        .decode()
        .map_err(|e| format!("译文图解码失败: {e}"))?
        .to_rgba8();
    let (w, h) = (img.width(), img.height());
    Ok((img.into_raw(), w, h))
}

fn hide_main_window(app: &tauri::AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.hide();
        }
        visible
    } else {
        false
    }
}

pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn notify_error(app: &tauri::AppHandle, err: &str) {
    let _ = app
        .notification()
        .builder()
        .title("截图翻译失败")
        .body(err)
        .show();
}
```

（语言方向第一版固定写死在 `translate_selection` 的 `"auto"`/`"zh-CHS"`，不读设置——将来加语言选择时再接 `storage::load_settings()`。）

`capture/mod.rs` 加 `pub mod orchestrate;`。

- [ ] **Step 2: 编译 + 现有测试回归**

Run: `cargo test -p qingbird-md capture:: && cargo build`
Expected: 编译通过（`Manager`/`NotificationExt` trait 导入解析成功），既有 capture 测试无回归。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture/
git commit -m "feat(capture): 截图→OCR→浮窗编排（单飞互斥 + 失败通知）"
```

---

### Task 8: hotkeys.rs — capture 热键特判注册

**Files:**
- Modify: `src-tauri/src/hotkeys.rs`

**Interfaces:**
- Consumes: Task 2（`settings.hotkeys["capture"]`）、Task 7（`orchestrate::begin`）。
- Produces: 全局热键按下即触发截图（无新事件类型）。

- [ ] **Step 1: 实现**

`hotkeys.rs` 的 `sync()` 在 `MODES` 循环之后追加（`unregister_all` 已在循环前覆盖）：

```rust
    // capture：特判回调——不 emit hotkey-mode，直接触发截图（worker 线程，
    // 主线程回调立即返回；orchestrate::begin 内部自带单飞互斥）。
    if let Some(combo) = settings.hotkeys.get("capture") {
        if registrable(combo) {
            if let Err(e) = gs.on_shortcut(combo.as_str(), |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        if let Err(e) = crate::capture::orchestrate::begin(app) {
                            eprintln!("capture hotkey: {e}");
                        }
                    });
                }
            }) {
                eprintln!("register global hotkey {combo} (capture): {e}");
            }
        } // 空/Meta：与模式热键同口径静默跳过
    }
```

- [ ] **Step 2: 回归测试**

Run: `cargo test -p qingbird-md hotkeys`
Expected: 既有 2 个测试 PASS（registrable 逻辑未动）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/hotkeys.rs
git commit -m "feat(hotkeys): capture 全局热键触发截图翻译"
```

---

### Task 9: tray.rs + lib.rs 接线（托盘 / 自启 / 静默启动 / 关窗驻留）

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`（plugins、setup、on_page_load、轮询线程）
- Modify: `src-tauri/Cargo.toml`（无——Task 1 已加依赖与 feature）

**Interfaces:**
- Consumes: Task 1（`startup_arg::is_silent_launch`、autostart/notification 插件）、Task 7（`orchestrate::{begin, show_main_window}`）、Task 3（`is_show_wake`）、Task 2（`settings.autostart`）。
- Produces: 托盘图标（显示主窗口/截图翻译/开机自启☑/退出）、左键点击=显示主窗口、✕=隐藏、`--minimized` 静默驻留。

- [ ] **Step 1: 实现 tray.rs**

```rust
//! 系统托盘：常驻图标 + 菜单 + 关窗隐藏（spec §5）。
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::ManagerExt;

use crate::capture::orchestrate;
use crate::storage;

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let capture = MenuItemBuilder::with_id("capture", "截图翻译").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "开机自启")
        .checked(storage::load_settings().autostart)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &capture, &autostart, &quit])
        .build()?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("青鸟 Markdown")
        .menu(&menu)
        // 左键=显示窗口，右键=菜单。若编译报该 API 不存在（tauri 2.2 及更早），
        // 改用已废弃等价物 `.menu_on_left_click(false)`
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => orchestrate::show_main_window(app),
            "capture" => trigger_capture(app),
            "autostart" => toggle_autostart(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                orchestrate::show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn trigger_capture(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = orchestrate::begin(app) {
            eprintln!("tray capture: {e}");
        }
    });
}

/// 开关开机自启：插件注册表为即时权威，settings.autostart 为持久化权威。
/// 勾选框被 Tauri 自动翻转；enable/disable 失败时回滚勾选并保留旧设置。
fn toggle_autostart(app: &tauri::AppHandle) {
    let mut s = storage::load_settings();
    let new_val = !s.autostart;
    let result = if new_val {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match result {
        Ok(()) => {
            s.autostart = new_val;
            if let Err(e) = storage::save_settings(&s) {
                eprintln!("save autostart setting: {e}");
            }
        }
        Err(e) => {
            eprintln!("autostart toggle: {e}");
            if let Some(kind) = app.menu().and_then(|m| m.get("autostart")) {
                if let tauri::menu::MenuItemKind::Check(c) = kind {
                    let _ = c.set_checked(s.autostart);
                }
            }
        }
    }
}
```

- [ ] **Step 2: lib.rs 接线**

`run()` 中 `let file_arg = ...` 之前加：

```rust
    let silent = capture::startup_arg::is_silent_launch(std::env::args());
```

Builder 上加两个插件（在现有 `.plugin(tauri_plugin_dialog::init())` 旁）：

```rust
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![capture::startup_arg::SILENT_START_ARG]),
        ))
        .plugin(tauri_plugin_notification::init())
```

`on_page_load` 闭包整体替换（现有 500ms 延迟 emit 逻辑原样并入，前面加 show 闩）：

```rust
    let initial = Mutex::new(file_arg);
    let shown = Mutex::new(false);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_page_load(move |wv, ev| {
            if !matches!(ev.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            // 非静默启动：首帧就绪后显示主窗口（visible:false 配置的补偿，
            // 消除 webview 白屏；静默启动永不 show，驻留托盘）
            if !silent && !*shown.lock().expect("shown mutex poisoned") {
                *shown.lock().expect("shown mutex poisoned") = true;
                if let Some(w) = wv.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            if let Some(p) = initial.lock().expect("initial file mutex poisoned").take() {
                // 延迟发射；detached 线程不阻塞事件循环（现有逻辑原样）
                let wv = wv.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = wv.emit("document-changed", changed_payload(&p));
                });
            }
        })
```

（文件参数闩旁的 `let shown = Mutex::new(false);` 加在现有 `let initial = ...` 之后；`silent` 闭包捕获自 Step 开头计算的变量。）

`setup` 闭包内追加（热键同步之后）。`lib.rs` 顶部 use 区加 `use tauri_plugin_autostart::ManagerExt;`：

```rust
            // 托盘 + 自启状态同步 + 关窗隐藏
            tray::setup(app)?;
            let s = storage::load_settings();
            if s.autostart {
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("apply autostart: {e}");
                }
            }
            if let Some(main) = app.get_webview_window("main") {
                let h = app.handle().clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 关闭=隐藏到托盘（spec §5）；真退出走托盘菜单「退出」
                        api.prevent_close();
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }
```

轮询线程的 handoff 分支改（消费 Task 3 的 `is_show_wake`）：

```rust
                if let Some(p) = single_instance::take_pending() {
                    if !single_instance::is_show_wake(&p) {
                        let _ = h.emit("document-changed", changed_payload(&p));
                    }
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
```

lib.rs 顶部 mod 声明区加 `mod tray;`。

- [ ] **Step 3: 编译 + 全测试**

Run: `cargo test --workspace && cargo build`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "feat(tray): 托盘常驻 + 开机自启 + 静默启动 + 关窗隐藏"
```

---

### Task 10: 前端 — 设置弹窗截图热键行 + App.tsx 跳过 capture

**Files:**
- Modify: `src/components/SettingsModal.tsx:13-17`（HOTKEY_MODES）与分组注释行（~283）
- Modify: `src/App.tsx:132-140`（应用内匹配循环）

**Interfaces:**
- Consumes: Task 2（`hotkeys.capture` 经 settings-updated 下发）；现有录制器组件无接口变化。

- [ ] **Step 1: SettingsModal.tsx**

```ts
const HOTKEY_MODES: Array<[string, string]> = [
  ["original", "原文"],
  ["translation", "译文"],
  ["bilingual", "中英对照"],
  ["capture", "截图翻译"],
];
```

分组注释文案 `阅读模式快捷键（点击后按下组合键，须含 Ctrl/Alt/Shift）` 改为 `快捷键（点击后按下组合键，须含 Ctrl/Alt/Shift）`。

- [ ] **Step 2: App.tsx 应用内匹配跳过 capture**

```ts
      for (const [mode, combo] of Object.entries(hk)) {
        if (mode === "capture") continue; // 全局热键，Rust 侧注册处理
        if (comboMatches(e, combo)) {
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: tsc 严格编译 + vite 构建通过。

- [ ] **Step 4: Commit**

```bash
git add src/components/SettingsModal.tsx src/App.tsx
git commit -m "feat(ui): 设置弹窗截图翻译热键录制行"
```

---

### Task 11: 回归清单 + 全量验证

**Files:**
- Modify: `docs/regression-checklist.md`（追加一节）
- Modify: `CHANGELOG.md`（Unreleased 或最新版本下追加）

- [ ] **Step 1: regression-checklist.md 追加**

```markdown
## 截图翻译 / 托盘 / 自启（2026-09-01）

- [ ] 热键（默认 Ctrl+Shift+X）→ 暗化遮罩全屏 → 拖拽框选 → 转圈 → 浮窗显示中文译文
- [ ] Esc / 右键（框选前）取消，无残留窗口
- [ ] 译文浮窗内右键：译文 ↔ 原图切换；点击任意处关闭
- [ ] 设置弹窗录制截图热键（如 Alt+Q）→ 保存后立即生效；含 Win 键 → toast 拒绝
- [ ] 老设置文件升级后 capture 热键自动为 Ctrl+Shift+X（无需手动设置）
- [ ] 关闭主窗口 → 程序驻留托盘 → 托盘左键恢复；驻留期间热键可用
- [ ] 驻留后双击桌面图标 → 主窗口弹回
- [ ] 托盘菜单：显示主窗口 / 截图翻译 / 开机自启勾选 / 退出 全部生效
- [ ] 勾选开机自启 → 注册表 HKCU\...\Run 出现条目（带 --minimized）；取消勾选移除
- [ ] `--minimized` 启动 → 仅托盘无主窗口；正常启动 → 主窗口正常显示且无白屏闪烁
- [ ] 断网截图 → 系统通知「截图翻译失败」，无残留窗口；恢复网络后可重试
- [ ] 多显示器：光标在副屏按热键 → 遮罩盖在副屏
- [ ] 翻译过程中再次按热键 → 被忽略（无第二个选区窗口）
```

- [ ] **Step 2: CHANGELOG.md 追加条目**

在最新版本段加：

```markdown
- 新增：截图翻译（全局热键框选屏幕，有道 OCR 实时译文浮窗覆盖原位；热键可在设置中自定义）
- 新增：系统托盘常驻（关闭主窗口=隐藏到托盘；菜单含显示窗口/截图翻译/开机自启/退出）
- 新增：开机自启动（默认关闭，托盘菜单开关；开机静默驻留托盘）
```

- [ ] **Step 3: 全量验证**

Run: `cargo test --workspace`（全绿）→ `npm run build`（通过）→ `npx tauri build`（NSIS 产出无错）。
手测按 Step 1 清单逐条人工勾选（截图/托盘/自启无法自动化）。

- [ ] **Step 4: Commit**

```bash
git add docs/regression-checklist.md CHANGELOG.md
git commit -m "docs: 截图翻译/托盘/自启 回归清单与变更记录"
```
