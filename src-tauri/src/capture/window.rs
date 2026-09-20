use std::num::NonZeroU32;
use std::sync::{mpsc, Arc, OnceLock};

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Fullscreen, Window, WindowId, WindowLevel};

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

// ── Per-frame rendering ───────────────────────────────────────────────────────

fn redraw_session(session: &mut CaptureSession) {
    if !session.surface_ready {
        return;
    }

    let mut buffer = match session.surface.buffer_mut() {
        Ok(b) => b,
        Err(_) => return,
    };

    let buf_len = buffer.len();
    let expected = (session.img_w * session.img_h) as usize;

    if buf_len != expected {
        buffer.fill(0);
        let _ = buffer.present();
        return;
    }

    let width = session.img_w;
    let height = session.img_h;

    // Start with darkened screenshot.
    buffer.copy_from_slice(&session.darkened_pixels);

    // If there's a result overlay, paint the translation on top — or, when the
    // user has toggled it off, show the original (un-darkened) screenshot region
    // so they can read the source text. Right-click inside the region flips this.
    // The selection border is drawn in both states so toggling never removes it.
    if let Some(ref res) = session.result {
        if res.visible {
            // res.pixels is a compact res.w×res.h image — stride equals res.w, offset (0,0).
            blit_pixels(
                &mut buffer,
                width,
                &res.pixels,
                res.w,
                0,
                0,
                res.x,
                res.y,
                res.w,
                res.h,
            );
        } else if let Some((sx, sy, sw, sh)) = session.selection {
            // Show the original screenshot for the selected region (bright, not dimmed).
            blit_pixels(
                &mut buffer,
                width,
                &session.original_pixels,
                session.img_w,
                sx,
                sy,
                sx,
                sy,
                sw,
                sh,
            );
        }
        if let Some((sx, sy, sw, sh)) = session.selection {
            draw_border(&mut buffer, width, height, sx, sy, sw, sh, 0x004A9EFF, 2);
        }
        let _ = buffer.present();
        return;
    }

    // Determine current selection rect.
    let sel = if session.is_dragging {
        session
            .drag_start
            .map(|start| normalize_rect(start, session.mouse_pos))
    } else {
        session.selection
    };

    if let Some((sx, sy, sw, sh)) = sel {
        if sw > 0 && sh > 0 {
            // original_pixels is the full img_w×img_h screenshot — stride = img_w,
            // source origin = (sx, sy) so we read the correct region.
            blit_pixels(
                &mut buffer,
                width,
                &session.original_pixels,
                session.img_w,
                sx,
                sy,
                sx,
                sy,
                sw,
                sh,
            );
            draw_border(&mut buffer, width, height, sx, sy, sw, sh, 0x004A9EFF, 2);
        }
    }

    // Loading spinner overlay.
    if session.loading {
        if let Some((sx, sy, sw, sh)) = session.selection {
            let elapsed = session
                .loading_start
                .map(|t| t.elapsed().as_secs_f32())
                .unwrap_or(0.0);
            draw_spinner(&mut buffer, width, height, sx, sy, sw, sh, elapsed);
        }
        session.window.request_redraw();
    }

    let _ = buffer.present();

    // Reveal the window only after the first successful paint — prevents the
    // white-flash that occurs when the OS shows the window before pixels are ready.
    if !session.shown {
        session.shown = true;
        session.window.set_visible(true);
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

// ── Pixel helpers ─────────────────────────────────────────────────────────────

/// Convert RGBA bytes (as returned by `screenshots` crate) to softbuffer's 0x00RRGGBB u32s.
fn rgba_to_softbuffer(rgba: &[u8]) -> Vec<u32> {
    rgba.chunks_exact(4)
        .map(|px| ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | (px[2] as u32))
        .collect()
}

fn darken_pixels(pixels: &[u32], factor: f32) -> Vec<u32> {
    pixels
        .iter()
        .map(|&p| {
            let r = (((p >> 16) & 0xFF) as f32 * factor) as u32;
            let g = (((p >> 8) & 0xFF) as f32 * factor) as u32;
            let b = ((p & 0xFF) as f32 * factor) as u32;
            (r << 16) | (g << 8) | b
        })
        .collect()
}

/// Blit a rectangular region from `src` into `dst`.
///
/// - `src_stride`: row stride of `src` in pixels (may differ from `w` when `src` is a
///   sub-region of a larger image, e.g. the full-resolution screenshot).
/// - `src_ox`, `src_oy`: pixel offset within `src` where reading starts.
fn blit_pixels(
    dst: &mut [u32],
    dst_w: u32,
    src: &[u32],
    src_stride: u32,
    src_ox: u32,
    src_oy: u32,
    dx: u32,
    dy: u32,
    w: u32,
    h: u32,
) {
    let dst_w = dst_w as usize;
    let src_stride = src_stride as usize;
    let len = w as usize;
    for row in 0..(h as usize) {
        let dst_start = (dy as usize + row) * dst_w + dx as usize;
        let src_start = (src_oy as usize + row) * src_stride + src_ox as usize;
        if dst_start + len <= dst.len() && src_start + len <= src.len() {
            dst[dst_start..dst_start + len].copy_from_slice(&src[src_start..src_start + len]);
        }
    }
}

fn draw_border(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    color: u32,
    thickness: u32,
) {
    let bw = buf_w as usize;
    let x2 = (x + w).min(buf_w);
    let y2 = (y + h).min(buf_h);
    for t in 0..thickness {
        let top = (y + t) as usize;
        let bot = y2.saturating_sub(1).saturating_sub(t) as usize;
        for col in x..x2 {
            let c = col as usize;
            if top < buf_h as usize {
                let i = top * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
            if bot != top && bot < buf_h as usize {
                let i = bot * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
        }
        let left = (x + t) as usize;
        let right = x2.saturating_sub(1).saturating_sub(t) as usize;
        for row in y..y2 {
            let r = row as usize;
            if r < buf_h as usize {
                let li = r * bw + left;
                if li < buf.len() {
                    buf[li] = color;
                }
                if right != left {
                    let ri = r * bw + right;
                    if ri < buf.len() {
                        buf[ri] = color;
                    }
                }
            }
        }
    }
}

/// Draw a spinning arc loader centered on the selection rect.
fn draw_spinner(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    sx: u32,
    sy: u32,
    sw: u32,
    sh: u32,
    elapsed: f32,
) {
    let cx = sx as f32 + sw as f32 / 2.0;
    let cy = sy as f32 + sh as f32 / 2.0;
    let r = (sw.min(sh) as f32 * 0.15).clamp(12.0, 28.0);
    let line_w = 3u32;
    let arc_span = std::f32::consts::PI * 1.5; // 270°
    let angle_start = elapsed * std::f32::consts::TAU; // 1 rotation/sec

    let steps = ((r + line_w as f32) * std::f32::consts::TAU * 2.0) as usize + 8;
    for i in 0..steps {
        let a = angle_start + (i as f32 / steps as f32) * arc_span;
        for w in 0..line_w {
            let rr = r - line_w as f32 / 2.0 + w as f32;
            let px = (cx + rr * a.cos()).round() as i32;
            let py = (cy + rr * a.sin()).round() as i32;
            if px >= 0 && py >= 0 && px < buf_w as i32 && py < buf_h as i32 {
                let idx = py as usize * buf_w as usize + px as usize;
                if idx < buf.len() {
                    buf[idx] = 0x004A9EFF;
                }
            }
        }
    }
}

fn normalize_rect(a: PhysicalPosition<f64>, b: PhysicalPosition<f64>) -> (u32, u32, u32, u32) {
    let x1 = a.x.min(b.x).max(0.0) as u32;
    let y1 = a.y.min(b.y).max(0.0) as u32;
    let x2 = a.x.max(b.x).max(0.0) as u32;
    let y2 = a.y.max(b.y).max(0.0) as u32;
    (x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
}

// ── Crop / encode helpers (used by commands.rs) ───────────────────────────────

pub fn crop_rgba(rgba: &[u8], img_w: u32, x: u32, y: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in y..(y + h) {
        let start = ((row * img_w + x) * 4) as usize;
        let end = start + (w * 4) as usize;
        if end <= rgba.len() {
            out.extend_from_slice(&rgba[start..end]);
        }
    }
    out
}

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

    // ---- P2-7k: blit_pixels / draw_border 边界守卫（纯函数离线可测）----

    #[test]
    fn blit_pixels_honors_stride_and_source_offset() {
        // src 4x2（stride=4），取 (1,0) 起的 2x2 贴到 dst 2x3 的 (0,1)：
        // 行 0 不动；行 1 = src 行 0 偏移 1 起 [2,3]；行 2 = src 行 1 偏移 1 起 [6,7]
        let src = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let mut dst = vec![0u32; 6];
        blit_pixels(&mut dst, 2, &src, 4, 1, 0, 0, 1, 2, 2);
        assert_eq!(dst, vec![0, 0, 2, 3, 6, 7]);
    }

    #[test]
    fn blit_pixels_clips_rows_crossing_the_bottom_edge() {
        // dst 2x2、dy=1 起贴 2x2：第一行落在 dst 第 2 行（界内），第二行
        // 越过底边被行级护栏整行跳过——内容不回卷、不 panic
        let src = vec![1, 2, 3, 4];
        let mut dst = vec![0u32; 4];
        blit_pixels(&mut dst, 2, &src, 2, 0, 0, 0, 1, 2, 2);
        assert_eq!(dst, vec![0, 0, 1, 2]);
    }

    #[test]
    fn blit_pixels_tolerates_empty_buffers_and_zero_size() {
        // 全零尺寸：循环体不执行，空缓冲不 panic
        let mut dst: Vec<u32> = vec![];
        blit_pixels(&mut dst, 0, &[], 0, 0, 0, 0, 0, 0, 0);
        assert!(dst.is_empty());
        // 非零尺寸但 src 为空：行级护栏整段跳过，dst 原样
        let mut dst2 = vec![7u32; 4];
        blit_pixels(&mut dst2, 2, &[], 2, 0, 0, 0, 0, 2, 2);
        assert_eq!(dst2, vec![7, 7, 7, 7]);
    }

    #[test]
    fn draw_border_outlines_rect_and_interior_stays_clean() {
        let mut buf = vec![0u32; 25]; // 5x5
        draw_border(&mut buf, 5, 5, 1, 1, 3, 3, 0xFF, 1);
        assert_eq!(buf[2 * 5 + 2], 0, "3x3 描边厚度 1：中心不得着色");
        for (x, y) in [(1, 1), (2, 1), (3, 1), (1, 2), (3, 2), (1, 3), (2, 3), (3, 3)] {
            assert_eq!(buf[y * 5 + x], 0xFF, "({x},{y}) 应着色");
        }
    }

    #[test]
    fn draw_border_thickness_beyond_rect_fills_without_panic() {
        // 厚度 10 大于 3x3 矩形：bot==top / right==left 的互斥守卫防重复写，
        // 整幅应被同一颜色填满且不 panic
        let mut buf = vec![0u32; 9];
        draw_border(&mut buf, 3, 3, 0, 0, 3, 3, 0xAB, 10);
        assert!(buf.iter().all(|&p| p == 0xAB));
    }

    #[test]
    fn draw_border_clips_to_buffer_and_skips_fully_outside() {
        let mut buf = vec![0u32; 16]; // 4x4
        // 右下越界的部分裁剪：只有落在缓冲内的 2x2 角着色
        draw_border(&mut buf, 4, 4, 2, 2, 5, 5, 0xFF, 1);
        assert_eq!(buf[2 * 4 + 2], 0xFF);
        assert_eq!(buf[3 * 4 + 3], 0xFF);
        assert_eq!(buf[0], 0);
        assert_eq!(buf[4 + 1], 0);
        // 完全在缓冲外（x 已超宽 → 列区间为空）：整体 no-op
        draw_border(&mut buf, 4, 4, 10, 10, 3, 3, 0xFF00, 2);
        assert!(buf.iter().all(|&p| p != 0xFF00));
    }
}
