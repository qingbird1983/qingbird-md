//! 主窗口 WebView 按需休眠（hibernate）。
//!
//! 关窗只 `hide()`（秒回），空闲 [`HIBERNATE_DELAY`] 后与前端握手落草稿，再
//! `destroy()` 把 WebView2 的内存还给系统；任意唤醒路径经 [`ensure_main_window`]
//! 原地复活或冷重建。
//!
//! **前提**：后台能力（托盘 / 全局热键 / 截图 winit 窗口 / 翻译缓存）无一依赖
//! 主窗口 WebView，销毁对它们零影响。改动时别破坏这个性质，否则整套方案失效。
//!
//! 设计要点见 `docs/webview-hibernate-plan.md`。
//!
//! P2-7h 拆分布局：state = 休眠状态机（计时/握手/销毁）；window = 建窗与
//! 冷重建；session = 快照类型与落盘；handoff = 前端 handoff 缓冲。

mod handoff;
mod session;
mod state;
mod window;

pub use handoff::{
    can_emit_document, mark_frontend_ready, push_pending_open, reset_frontend_ready,
    take_pending_open,
};
pub use session::{clear_snapshot, load_snapshot, save_snapshot, SessionSnapshot};
pub use state::{mark_ready, schedule};
pub use window::{ensure_main_window, MAIN_LABEL};
