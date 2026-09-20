//! 主窗口建窗与冷重建：唤醒唯一入口、导航白名单、从配置冷建窗口。

use std::time::Duration;

use tauri::Manager;

use super::handoff::reset_frontend_ready;
use super::state::cancel;

/// 主窗口 label（`tauri.conf.json` 未显式写 label，取 Tauri 默认值 "main"）。
pub const MAIN_LABEL: &str = "main";

/// 前端握手超时：到点后等这么久没收到 `hibernate_ready` 就强行销毁。
/// 内存释放优先于草稿完整性——绝不因为前端不配合就永远不释放内存。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

// ---- 唤醒入口 ----

/// 取主窗口的**唯一入口**：活着就唤醒并取消待卸载计时；已休眠则冷重建。
///
/// 坑 4：所有「把主窗口拉回前台」的调用点都必须收敛到这里，否则休眠后
/// `get_webview_window` 返回 None，唤醒路径静默失效。
///
/// **必须在主线程调用**（托盘菜单/左键事件天然满足；后台线程请用
/// `AppHandle::run_on_main_thread` 包一层）。原因见 `spawn_main_window`。
pub fn ensure_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        cancel(); // 待卸载计时作废：5 分钟内是秒回
        eprintln!("[hibernate] 唤醒：窗口存活，直接显示");
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(w);
    }
    spawn_main_window(app)
}

/// 冷重建窗口的导航白名单：本地资源放行，外部站点拦下。
///
/// **坑（本次白屏事故的根因）**：Windows 生产构建的前端资源 URL 是
/// `http://tauri.localhost/`（macOS/Linux 才是 `tauri://localhost`，见
/// tauri-2.11.5 `manager::get_app_url`）。早先这里的 host 白名单只认
/// 恰为 `localhost` / `127.0.0.1` 两种，`tauri.localhost` 落空 → 发布版
/// 冷重建窗口的**首次**导航就被拦下，页面永远是空白。
///
/// dev 下 URL 是 `localhost:5173`，恰好命中白名单，所以开发期怎么测都正常
/// ——只有走 `npx tauri build` 的发布版（含开机自启驻留后双击 .md 这条路径）
/// 才会白屏。改动此函数前先跑它的单测。
pub fn is_local_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "app" => true,
        "http" | "https" => matches!(url.host_str(), Some(h) if is_local_host(h)),
        _ => false,
    }
}

/// 本机 host 判定：`localhost` 及其任意子域（`tauri.localhost` 靠这条放行）、
/// 回环 IP。`.localhost` 结尾严格匹配，防 `tauri.localhost.evil.com` 混进来。
fn is_local_host(host: &str) -> bool {
    // IPv6 字面量在 URL 里带方括号（`[::1]`），host_str 会原样保留。
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h == "localhost" || h == "127.0.0.1" || h == "::1" || h.ends_with(".localhost")
}

/// 从 `tauri.conf.json` 的窗口配置冷重建主窗口。
///
/// **必须在主线程调用**：`create_window` 在后台线程下只是把建窗任务异步派发
/// 到事件循环，而紧随其后的 `create_webview` 是同步查窗口表的——此时窗口还没
/// 建出来，直接 `WindowNotFound`。主线程下 `send_user_message` 会同步执行，两步
/// 顺序才有保证。
pub fn spawn_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    cancel();
    // 坑 2：启动标志必须复位。SHOWN 是一次性闩，不清则首帧不 show；SILENT 不清
    //        则重建出来的窗口仍被当作开机自启的静默窗口，同样永远不显示。
    //        症状：进程活着、托盘活着、就是看不到窗。
    crate::reset_startup_flags();
    // 新窗口的页面要重新加载一遍：在前端取走 pending 之前，handoff 一律缓冲。
    reset_frontend_ready();

    let conf = app
        .config()
        .app
        .windows
        .iter()
        .find(|c| c.label == MAIN_LABEL)
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;

    let win = tauri::WebviewWindowBuilder::from_config(app, &conf)?
        // T25：冷重建窗口是 builder 阶段，能挂导航拦截——外部站点一律拦下
        // （前端 capture 拦截失效时的兜底；初始 config 窗口运行时无 setter，
        // 只能靠前端，见 docs/）。放行：本地资源协议 + dev server localhost。
        .on_navigation(is_local_navigation)
        .build()?;

    // 坑 3：新窗口是全新对象，CloseRequested 钩子必须重挂，否则第二次关窗
    //       会真的把应用关掉（关窗隐藏行为丢失）。
    crate::hook_main_window_close(&win);
    eprintln!("[hibernate] 主窗口冷重建完成");
    Ok(win)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Url;

    // ---- is_local_navigation（白屏事故回归）----

    fn local(url: &str) -> bool {
        is_local_navigation(&Url::parse(url).unwrap())
    }

    #[test]
    fn windows_release_asset_url_must_pass() {
        // 事故根因：发布版 app url 是 http://tauri.localhost/
        assert!(local("http://tauri.localhost/"));
        assert!(local("http://tauri.localhost/index.html"));
        assert!(local("https://tauri.localhost/assets/index-a1b2c3.js"));
    }

    #[test]
    fn macos_custom_protocol_passes() {
        assert!(local("tauri://localhost/index.html"));
        assert!(local("asset://localhost/foo.png"));
        assert!(local("app://localhost/"));
    }

    #[test]
    fn dev_server_and_loopback_pass() {
        assert!(local("http://localhost:5173/"));
        assert!(local("http://127.0.0.1:1420/"));
        assert!(local("http://[::1]:5173/"));
    }

    #[test]
    fn external_sites_are_blocked() {
        assert!(!local("https://example.com/"));
        assert!(!local("http://evil.com/x"));
        assert!(!local("https://github.com/"));
    }

    #[test]
    fn localhost_lookalike_suffix_is_blocked() {
        // 后缀匹配必须锚在 . 上，否则子域伪造能绕过白名单
        assert!(!local("https://tauri.localhost.evil.com/"));
        assert!(!local("https://notlocalhost/"));
        assert!(!local("https://localhost.evil.com/"));
    }

    #[test]
    fn unknown_schemes_are_blocked() {
        assert!(!local("file:///C:/Windows/x.png"));
        assert!(!local("ftp://localhost/x"));
    }
}
