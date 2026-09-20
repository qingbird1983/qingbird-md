//! 截图窗口子系统（P2-7k 拆分布局）：session = 命令/事件类型与事件循环
//! 单例；pixels = 每帧像素绘制；encode = 裁剪与 PNG 编码（commands.rs 消费）；
//! 本文件 = 会话状态机（CaptureHandler + ApplicationHandler 单遍事件处理）。

use std::num::NonZeroU32;
use std::sync::{mpsc, Arc};

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::ActiveEventLoop;
use winit::window::{Fullscreen, Window, WindowId, WindowLevel};

mod encode;
mod pixels;
mod session;

pub use encode::{crop_rgba, encode_png};
pub use session::{capture_proxy, start_capture, CaptureCommand, CaptureEvent};

use encode::normalize_rect;
use pixels::{darken_pixels, redraw_session, rgba_to_softbuffer};

// ── Internal handler ──────────────────────────────────────────────────────────

/// Possible states the handler can be in.
enum HandlerState {
    /// No active capture; window is closed.
    Idle,
    /// Active capture: window exists, user is selecting.
    Selecting(CaptureSession),
}

struct CaptureSession {
    img_w: u32,
    img_h: u32,
    original_pixels: Vec<u32>,
    darkened_pixels: Vec<u32>,
    event_tx: mpsc::Sender<CaptureEvent>,
    window: Arc<Window>,
    surface: Surface<Arc<Window>, Arc<Window>>,
    // Drag state
    drag_start: Option<PhysicalPosition<f64>>,
    selection: Option<(u32, u32, u32, u32)>,
    is_dragging: bool,
    mouse_pos: PhysicalPosition<f64>,
    // Result overlay
    result: Option<ResultOverlay>,
    // Loading animation
    loading: bool,
    loading_start: Option<std::time::Instant>,
    // Track whether the surface has been resized to the window's real physical size.
    surface_ready: bool,
    // Track whether the window has been made visible after the first successful paint.
    shown: bool,
}

struct ResultOverlay {
    pixels: Vec<u32>,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    /// Whether the translated overlay is currently shown. When false, the
    /// original (un-translated) screenshot region is shown instead, letting the
    /// user toggle between original text and translation via right-click.
    visible: bool,
}

struct CaptureHandler {
    state: HandlerState,
    /// Kept alive for the lifetime of the handler so the softbuffer Context lives.
    _ctx_storage: Option<Context<Arc<Window>>>,
}

impl CaptureHandler {
    fn idle() -> Self {
        Self {
            state: HandlerState::Idle,
            _ctx_storage: None,
        }
    }

    /// Create a new capture window for the given RGBA snapshot.
    fn open_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        rgba: Vec<u8>,
        img_w: u32,
        img_h: u32,
        _scale_factor: f64,
        monitor_x: i32,
        monitor_y: i32,
        event_tx: mpsc::Sender<CaptureEvent>,
    ) {
        // Find the monitor handle matching the given coordinates
        let target_monitor = event_loop.available_monitors().find(|m| {
            let pos = m.position();
            pos.x == monitor_x && pos.y == monitor_y
        });

        let fullscreen = match target_monitor {
            Some(m) => Fullscreen::Borderless(Some(m)),
            None => Fullscreen::Borderless(None),
        };

        let attrs = Window::default_attributes()
            .with_title("Capture")
            .with_decorations(false)
            .with_resizable(false)
            .with_fullscreen(Some(fullscreen))
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_visible(false);

        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                eprintln!("[capture] ERROR Failed to create capture window: {e}");
                let _ = event_tx.send(CaptureEvent::Cancelled);
                return;
            }
        };

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

        let original_pixels = rgba_to_softbuffer(&rgba);
        let darkened_pixels = darken_pixels(&original_pixels, 0.55);

        self._ctx_storage = Some(ctx);
        self.state = HandlerState::Selecting(CaptureSession {
            img_w,
            img_h,
            original_pixels,
            darkened_pixels,
            event_tx,
            window,
            surface,
            drag_start: None,
            selection: None,
            is_dragging: false,
            mouse_pos: PhysicalPosition::new(0.0, 0.0),
            result: None,
            loading: false,
            loading_start: None,
            surface_ready: false,
            shown: false,
        });

        // Pre-paint before showing the window to avoid white flash.
        // Windows does not send WM_SIZE to invisible windows, so we must resize
        // the surface ourselves using the known screenshot dimensions.
        if let HandlerState::Selecting(ref mut session) = self.state {
            if let (Some(nz_w), Some(nz_h)) = (NonZeroU32::new(img_w), NonZeroU32::new(img_h)) {
                if session.surface.resize(nz_w, nz_h).is_ok() {
                    session.surface_ready = true;
                    if let Ok(mut buffer) = session.surface.buffer_mut() {
                        if buffer.len() == (img_w * img_h) as usize {
                            buffer.copy_from_slice(&session.darkened_pixels);
                            let _ = buffer.present();
                            session.shown = true;
                            session.window.set_visible(true);
                        }
                    }
                }
            }
        }
    }

    fn close_window(&mut self) {
        // Dropping the session closes the window (Arc<Window> refcount → 0).
        self.state = HandlerState::Idle;
        self._ctx_storage = None;
        // 截图 buffer（1920×1080 RGBA + softbuffer u32 像素、PNG 编码临时缓冲、
        // 译文图解码后 RGBA）drop 后 Windows 堆不主动归还，主动 trim 把工作集
        // 还给 OS——下次冷启动/截图时再硬缺页回来，体感无差。
        crate::trim::trim_working_set();
    }
}

impl ApplicationHandler<CaptureCommand> for CaptureHandler {
    fn resumed(&mut self, _event_loop: &ActiveEventLoop) {}

    fn window_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        let session = match &mut self.state {
            HandlerState::Selecting(s) => s,
            HandlerState::Idle => return,
        };

        match event {
            // ── Once the OS tells us the window's real physical size, mark surface ready.
            WindowEvent::Resized(size) => {
                if let (Some(nz_w), Some(nz_h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) {
                    let _ = session.surface.resize(nz_w, nz_h);
                    session.surface_ready = true;
                    session.window.request_redraw();
                }
            }

            WindowEvent::RedrawRequested => {
                redraw_session(session);
            }

            WindowEvent::KeyboardInput {
                event: key_event, ..
            } => {
                use winit::keyboard::{KeyCode, PhysicalKey};
                if key_event.state == ElementState::Pressed {
                    if let PhysicalKey::Code(KeyCode::Escape) = key_event.physical_key {
                        let _ = session.event_tx.send(CaptureEvent::Cancelled);
                        self.close_window();
                    }
                }
            }

            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => {
                match state {
                    ElementState::Pressed => {
                        session.drag_start = Some(session.mouse_pos);
                        session.is_dragging = true;
                        session.selection = None;
                        session.result = None;
                    }
                    ElementState::Released => {
                        if session.is_dragging {
                            if let Some(start) = session.drag_start {
                                let rect = normalize_rect(start, session.mouse_pos);
                                session.selection = Some(rect);
                            }
                            session.is_dragging = false;
                            session.drag_start = None;
                            finish_selection(session);
                        }
                    }
                }
                session.window.request_redraw();
            }

            WindowEvent::CursorMoved { position, .. } => {
                session.mouse_pos = position;
                if session.is_dragging {
                    session.window.request_redraw();
                }
            }

            // Right-click: when a translation result is shown and the cursor is
            // inside the selected region, toggle between translation and original
            // text. Otherwise, right-click cancels the capture.
            //
            // Handle this on Released (not Pressed): closing the window on the
            // press would let the button-up event fall through to whatever window
            // is now underneath, triggering its native context menu. Consuming
            // both press and release here keeps the right-click fully contained.
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Right,
                ..
            } => {
                let inside_result = session
                    .result
                    .is_some()
                    .then(|| session.selection)
                    .flatten()
                    .map(|(sx, sy, sw, sh)| {
                        let mx = session.mouse_pos.x;
                        let my = session.mouse_pos.y;
                        mx >= sx as f64
                            && mx < (sx + sw) as f64
                            && my >= sy as f64
                            && my < (sy + sh) as f64
                    })
                    .unwrap_or(false);

                if inside_result {
                    if let Some(res) = &mut session.result {
                        res.visible = !res.visible;
                    }
                    session.window.request_redraw();
                } else {
                    let _ = session.event_tx.send(CaptureEvent::Cancelled);
                    self.close_window();
                }
            }

            WindowEvent::CloseRequested => {
                let _ = session.event_tx.send(CaptureEvent::Cancelled);
                self.close_window();
            }

            _ => {}
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: CaptureCommand) {
        match event {
            CaptureCommand::StartCapture {
                rgba,
                img_w,
                img_h,
                scale_factor,
                monitor_x,
                monitor_y,
                event_tx,
            } => {
                // Always close any previous window before opening a new one.
                self.close_window();
                self.open_window(event_loop, rgba, img_w, img_h, scale_factor, monitor_x, monitor_y, event_tx);
            }

            CaptureCommand::ShowResult {
                rgba_bytes,
                x,
                y,
                w,
                h,
            } => {
                if let HandlerState::Selecting(session) = &mut self.state {
                    let pixels = rgba_to_softbuffer(&rgba_bytes);
                    session.result = Some(ResultOverlay { pixels, x, y, w, h, visible: true });
                    session.loading = false;
                    session.window.request_redraw();
                }
            }

            CaptureCommand::ShowLoading => {
                if let HandlerState::Selecting(session) = &mut self.state {
                    session.loading = true;
                    session.loading_start = Some(std::time::Instant::now());
                    session.window.request_redraw();
                }
            }

            CaptureCommand::Close => {
                if let HandlerState::Selecting(session) = &mut self.state {
                    let _ = session.event_tx.send(CaptureEvent::Cancelled);
                }
                self.close_window();
            }
        }
    }
}

fn finish_selection(session: &CaptureSession) {
    if let Some((x, y, w, h)) = session.selection {
        if w > 4 && h > 4 {
            let _ = session
                .event_tx
                .send(CaptureEvent::Selection { x, y, w, h });
        }
    }
}
