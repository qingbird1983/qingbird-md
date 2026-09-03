//! 截图翻译编排：热键/托盘入口 → 截屏 → 选区窗口事件循环 → OCR → 结果浮窗。
//! 平移自 Glance commands.rs 的 begin_capture_impl + handle_capture_events，
//! tokio spawn_blocking → std::thread（qingbird 同步架构）。
//! 有意偏离：Glance 会先隐藏其主窗口再截屏；qingbird 主窗口承载待翻译文档，
//! 保持可见（见 run_flow 注释）。
//! Task 8（热键）已消费 begin，模块级 dead_code allow 已随之移除。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use base64::Engine;
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
        .map_err(|e| {
            // spawn 失败必须复位旗标，否则单飞永久卡死（后续 begin 全部 Err）
            CAPTURING.store(false, Ordering::SeqCst);
            format!("capture thread spawn failed: {e}")
        })
}

fn run_flow(app: tauri::AppHandle) -> Result<(), String> {
    // 与 Glance 不同：青鸟的主窗口就是截图目标（翻译当前文档），保持可见，
    // 让文档出现在截屏画面与半透明遮罩之下，不做隐藏/恢复。
    // 截屏前的早期失败也必须可见（spec §9）：显示器检测/截屏失败 → 通知。
    // 选区/翻译失败已在事件循环内各自收尾。
    let found = match screen::find_cursor_monitor() {
        Ok(f) => f,
        Err(e) => return early_fail(&app, e),
    };
    let monitor = found.monitor;
    let (rgba, img_w, img_h) = match screen::capture_screen_to_memory(found.screen) {
        Ok(v) => v,
        Err(e) => return early_fail(&app, e),
    };

    // rgba 需保留供选区裁剪，start_capture 按值接收故传克隆（每次会话一次拷贝）
    let (event_tx, event_rx) = mpsc::channel::<CaptureEvent>();
    window::start_capture(rgba.clone(), img_w, img_h, monitor.scale_factor, monitor.x, monitor.y, event_tx);

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

fn notify_error(app: &tauri::AppHandle, err: &str) {
    let _ = app
        .notification()
        .builder()
        .title("截图翻译失败")
        .body(err)
        .show();
}

/// 早期失败收尾（截屏前）：可见通知后返回错误。
/// 日志由 begin 的线程闭包在 run_flow 返回 Err 时统一打印，此处不重复。
fn early_fail(app: &tauri::AppHandle, e: String) -> Result<(), String> {
    notify_error(app, &e);
    Err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 白色 JPEG（image crate Jpeg 编码器产物，离线固定字节，628 B）。
    const JPEG_1X1_WHITE: &[u8] = &[
        255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 2, 0, 0, 1,
        0, 1, 0, 0, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17,
        0, 2, 17, 1, 3, 17, 1, 255, 219, 0, 67, 0, 8, 6, 6, 7,
        6, 5, 8, 7, 7, 7, 9, 9, 8, 10, 12, 20, 13, 12, 11, 11,
        12, 25, 18, 19, 15, 20, 29, 26, 31, 30, 29, 26, 28, 28, 32, 36,
        46, 39, 32, 34, 44, 35, 28, 28, 40, 55, 41, 44, 48, 49, 52, 52,
        52, 31, 39, 57, 61, 56, 50, 60, 46, 51, 52, 50, 255, 219, 0, 67,
        1, 9, 9, 9, 12, 11, 12, 24, 13, 13, 24, 50, 33, 28, 33, 50,
        50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
        50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
        50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50,
        50, 255, 196, 0, 31, 0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0,
        0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
        10, 11, 255, 196, 0, 181, 16, 0, 2, 1, 3, 3, 2, 4, 3, 5,
        5, 4, 4, 0, 0, 1, 125, 1, 2, 3, 0, 4, 17, 5, 18, 33,
        49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35,
        66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130, 9, 10, 22, 23,
        24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58,
        67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90,
        99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122,
        131, 132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153,
        154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183,
        184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211, 212, 213,
        214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241,
        242, 243, 244, 245, 246, 247, 248, 249, 250, 255, 196, 0, 31, 1, 0, 3,
        1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1,
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 255, 196, 0, 181, 17, 0,
        2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119, 0,
        1, 2, 3, 17, 4, 5, 33, 49, 6, 18, 65, 81, 7, 97, 113, 19,
        34, 50, 129, 8, 20, 66, 145, 161, 177, 193, 9, 35, 51, 82, 240, 21,
        98, 114, 209, 10, 22, 36, 52, 225, 37, 241, 23, 24, 25, 26, 38, 39,
        40, 41, 42, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73,
        74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105,
        106, 115, 116, 117, 118, 119, 120, 121, 122, 130, 131, 132, 133, 134, 135, 136,
        137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166,
        167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196,
        197, 198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 226,
        227, 228, 229, 230, 231, 232, 233, 234, 242, 243, 244, 245, 246, 247, 248, 249,
        250, 255, 218, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 247,
        250, 0, 255, 217,
    ];

    #[test]
    fn decode_image_rgba_reads_1x1_jpeg() {
        // 离线往返：ImageReader 自动探测 JPEG → RGBA（模拟有道译文图解码路径）
        let (rgba, w, h) = decode_image_rgba(JPEG_1X1_WHITE).expect("1x1 JPEG 应可解码");
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgba.len(), 4);
        // JPEG 有损：白色允许轻微偏移；alpha 恒为 255
        assert_eq!(rgba[3], 255);
        for ch in &rgba[..3] {
            assert!(*ch >= 250, "白色 JPEG 解码出非白像素: {rgba:?}");
        }
    }
}
