//! 前端 handoff：休眠/加载窗口期内的待打开路径缓冲与就绪标志。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

use super::window::MAIN_LABEL;

/// 休眠期间到达的待打开文件（单实例 handoff）。
///
/// `emit` 无缓冲也无重放：窗口不存在时发出去就等于丢。休眠态收到 handoff
/// 文件路径时先存在这里，冷重建后的前端启动阶段用 `take_pending_open` 取走。
static PENDING_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 冷重建出来的 WebView 的前端就绪标志。
///
/// `false` = 窗口/页面还没跑完（React 未挂载、`document-changed` 监听未注册）。
/// 这段窗口期里 emit 同样是「发出去就等于丢」，所以 handoff 必须先落
/// [`PENDING_OPEN`] 缓冲；前端 `take_pending_open` 时转 `true`。
///
/// 初值为 `false`：进程刚启动时页面同样在加载，与冷重建是同一类窗口期。
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);

/// 冷重建后等前端取走 pending 的兜底时长。
///
/// 超时即复位就绪标志（回落到直接 emit）：宁可极端情况下丢一次 handoff，
/// 也不能因为前端永远不调 `take_pending_open` 而让文件关联彻底静默。
const FRONTEND_READY_TIMEOUT: Duration = Duration::from_secs(10);

/// 标记「前端未就绪」并起超时兜底。
///
/// 调用点有两个：进程启动（页面在加载）与冷重建（全新 WebView 要重新加载）。
/// 兜底线程到点无条件复位为就绪——宁可极端情况下丢一次 handoff，也不能因为
/// 前端永远不调 `take_pending_open` 而让文件关联彻底静默。
pub fn reset_frontend_ready() {
    FRONTEND_READY.store(false, Ordering::SeqCst);
    let flag: &'static AtomicBool = &FRONTEND_READY;
    std::thread::spawn(move || {
        std::thread::sleep(FRONTEND_READY_TIMEOUT);
        flag.store(true, Ordering::SeqCst);
    });
}

/// 前端已起来（调过 `take_pending_open`）：后续 handoff 可以直接 emit。
pub fn mark_frontend_ready() {
    FRONTEND_READY.store(true, Ordering::SeqCst);
}

/// handoff 到达时能否直接 emit `document-changed`：既要有活着的 WebView，
/// 又要它里面的前端已经挂好监听（[`FRONTEND_READY`]）。两者缺一就该走
/// [`push_pending_open`] 缓冲。
pub fn can_emit_document(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(MAIN_LABEL).is_some() && FRONTEND_READY.load(Ordering::SeqCst)
}

/// 存入一个待打开路径（休眠态 handoff 用）。
pub fn push_pending_open(path: String) {
    PENDING_OPEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(path);
}

/// 取走全部待打开路径（前端启动阶段调用；取走即清空，不重复打开）。
pub fn take_pending_open() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPEN.lock().unwrap_or_else(|e| e.into_inner()))
}
