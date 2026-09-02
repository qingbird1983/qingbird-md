//! BitBlt 截屏 + 光标所在显示器检测（平移自 Glance capture.rs，Windows-only）。

use screenshots::Screen;

#[derive(Clone, Copy)]
pub struct MonitorInfo {
    pub scale_factor: f64,
    pub x: i32,
    pub y: i32,
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
        },
    })
}

#[cfg(target_os = "windows")]
fn get_cursor_position() -> Result<(i32, i32), String> {
    #[repr(C)]
    struct Point { x: i32, y: i32 }
    // edition 2024 要求 extern 块为 unsafe（Glance 原文为 extern "system"）
    unsafe extern "system" {
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
