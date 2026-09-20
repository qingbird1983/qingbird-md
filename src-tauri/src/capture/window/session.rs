//! 截图命令/事件类型与事件循环单例（Windows 下每进程只允许一个
//! EventLoop，故整个应用生命周期跑在专属后台线程上，捕获经 proxy 派发）。

use std::sync::{mpsc, OnceLock};

use winit::event_loop::{EventLoop, EventLoopProxy};

use super::CaptureHandler;

// ── Public types ──────────────────────────────────────────────────────────────

/// Commands sent into the event loop (from async tasks or begin_capture).
pub enum CaptureCommand {
    /// Begin a new capture session with fresh screenshot data.
    StartCapture {
        rgba: Vec<u8>,
        img_w: u32,
        img_h: u32,
        scale_factor: f64,
        monitor_x: i32,
        monitor_y: i32,
        event_tx: mpsc::Sender<CaptureEvent>,
    },
    /// Display a translated result image over the selection area.
    ShowResult {
        rgba_bytes: Vec<u8>,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    },
    /// Show a spinning loader over the current selection while API call is in progress.
    ShowLoading,
    /// Close the current capture window.
    Close,
}

/// Events emitted from the capture window to Rust async tasks.
pub enum CaptureEvent {
    /// User finished dragging a selection.
    Selection { x: u32, y: u32, w: u32, h: u32 },
    /// User pressed ESC or the window was closed.
    Cancelled,
}

// ── Singleton event loop ───────────────────────────────────────────────────────
//
// winit on Windows only allows ONE EventLoop per process (building a second one
// panics with "RecreationAttempt"). We keep a single background thread running
// the event loop for the entire app lifetime. Individual captures are started by
// sending CaptureCommand::StartCapture through the proxy.

static CAPTURE_PROXY: OnceLock<EventLoopProxy<CaptureCommand>> = OnceLock::new();

/// Get (or lazily create) the singleton event-loop proxy.
/// The event loop lives on a dedicated background thread for the app's lifetime.
///
/// REL-6 降级：原实现四处 `expect`——线程 spawn 失败 / winit 创建失败 /
/// 循环提前崩溃都会把 panic 扔进调用线程，而发起截图的 orchestrate 线程
/// panic 后 `CAPTURING` 旗标永不复位，截图会话从此永久卡死。现在失败只落
/// 日志并返回 `Err`；初始化失败不占 [`CAPTURE_PROXY`]，下次调用还能重试。
pub fn capture_proxy() -> Result<EventLoopProxy<CaptureCommand>, String> {
    if let Some(proxy) = CAPTURE_PROXY.get() {
        return Ok(proxy.clone());
    }
    let (proxy_tx, proxy_rx) = mpsc::sync_channel::<EventLoopProxy<CaptureCommand>>(1);
    let spawned = std::thread::Builder::new()
        .name("capture-event-loop".into())
        .spawn(move || {
            use winit::platform::windows::EventLoopBuilderExtWindows;
            let event_loop = match EventLoop::<CaptureCommand>::with_user_event()
                .with_any_thread(true)
                .build()
            {
                Ok(event_loop) => event_loop,
                Err(e) => {
                    eprintln!("[capture] winit 事件循环创建失败: {e}");
                    return; // proxy_tx 随闭包结束被丢弃，等待方 recv 到关闭
                }
            };

            let proxy = event_loop.create_proxy();
            let _ = proxy_tx.send(proxy);

            let mut handler = CaptureHandler::idle();
            if let Err(e) = event_loop.run_app(&mut handler) {
                // 循环崩溃后 CAPTURE_PROXY 里留的是死代理：后续 send_event 一律
                // 返回 false，由 start_capture 转成 Cancelled 让在飞会话收尾
                eprintln!("[capture] 截图事件循环崩溃: {e}");
            }
        });
    if let Err(e) = spawned {
        return Err(format!("capture 事件循环线程 spawn 失败: {e}"));
    }
    let proxy = proxy_rx
        .recv()
        .map_err(|_| "capture 事件循环在交出代理前退出".to_string())?;
    let _ = CAPTURE_PROXY.set(proxy.clone());
    Ok(proxy)
}

/// Begin a new capture session.  Does not block — the window appears asynchronously.
///
/// REL-6：事件循环不可用（初始化失败，或已崩溃导致 send_event 返回 false）时
/// 向编排层回一条 [`CaptureEvent::Cancelled`]——发起方阻塞在 `event_rx.recv()`
/// 上，永远收不到事件就连同 `CAPTURING` 旗标一起永久挂起。
pub fn start_capture(
    rgba: Vec<u8>,
    img_w: u32,
    img_h: u32,
    scale_factor: f64,
    monitor_x: i32,
    monitor_y: i32,
    event_tx: mpsc::Sender<CaptureEvent>,
) {
    let cancel_on_failure = event_tx.clone();
    let dispatched = capture_proxy().map(|proxy| {
        proxy.send_event(CaptureCommand::StartCapture {
            rgba,
            img_w,
            img_h,
            scale_factor,
            monitor_x,
            monitor_y,
            event_tx,
        })
    });
    match &dispatched {
        Ok(Ok(())) => {}
        Ok(Err(_)) => eprintln!("[capture] 事件循环已退出，无法发起截图会话"),
        Err(e) => eprintln!("[capture] 截图事件循环不可用: {e}"),
    }
    if !matches!(dispatched, Ok(Ok(()))) {
        let _ = cancel_on_failure.send(CaptureEvent::Cancelled);
    }
}
