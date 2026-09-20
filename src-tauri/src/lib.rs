//! Tauri entry point: managed app state (`AppTxn`) + the IPC command modules
//! and the startup/window assembly.
//!
//! P2-7d 拆分布局：commands/{file,workspace_ops,dialogs,settings} 收命令四族，
//! window_boot 收启动标志与 Builder 装配（run）；本文件只剩 AppTxn、mod 声明、
//! 旧路径再导出与 generate_handler 的装配调用。

mod atomic_write;
mod bridge;
mod capture;
mod commands;
mod dto;
mod editor;
mod fileopen;
mod hibernate;
mod hotkeys;
mod markdown;
mod single_instance;
mod storage;
mod tray;
mod translate;
mod trim;
mod window_boot;
mod workspace;

use std::fs::File;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use translate::cache::Cache;

// P2-7d 拆分后的旧路径保留：hibernate.rs（冷重建复位/重挂钩子）、main.rs
// （qingbird_md_lib::run）与 tests/asset_scope.rs（两个测试薄壳）经此处继续
// 以原路径可达，全仓调用点零改动。
pub use window_boot::run;
pub(crate) use window_boot::{hook_main_window_close, reset_startup_flags};
#[doc(hidden)]
pub use commands::file::{register_workspace_root_for_test, resolve_image_for_test};

/// Managed shared state, registered via `.manage(AppTxn::new(lock))`.
///
/// `lock_file` 仅做 RAII 持有：acquire_lock 返回的 File 留在字段里活到进程
/// 退出（释放即丢单实例锁），构造后无路径再读它。Mutex 是过度封装。
pub struct AppTxn {
    /// 翻译缓存共享。Arc 包一层：Task 8 后台 worker 克隆 Arc 出去，收尾时
    /// 短暂锁回写新键并落盘——绝不跨网络请求持锁。
    pub(crate) cache: Arc<Mutex<Cache>>,
    pub(crate) cancel: Arc<AtomicBool>, // 当前批次取消旗标
    pub(crate) running: Arc<AtomicBool>,
    /// 代次：新一轮翻译 +1；事件里带上，前端丢弃过期。
    /// Rust 2024 保留字，raw identifier（序列化不涉及，仅内部状态）。
    pub(crate) r#gen: AtomicU64,
    // 仅做 RAII 持有（单实例锁活到进程退出），构造后无路径再读它。
    #[allow(dead_code)]
    lock_file: Option<File>,
}

impl AppTxn {
    pub(crate) fn new(lock: Option<File>) -> Self {
        // 启动时接续上次落盘的翻译记忆（save 在 worker 收尾/clear_cache 时写回）。
        Self {
            cache: Arc::new(Mutex::new(Cache::load(&storage::cache_path()))),
            cancel: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            r#gen: AtomicU64::new(0),
            lock_file: lock,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn txn_new_is_quiescent_when_no_lock() {
        let t = AppTxn::new(None);
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        assert!(!t.cancel.load(Ordering::Relaxed));
        assert!(!t.running.load(Ordering::Relaxed));
        assert!(t.lock_file.is_none());
    }

    #[test]
    fn txn_holds_the_single_instance_lock() {
        let dir = std::env::temp_dir().join(format!("qingbird-txn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(dir.join("lock"))
            .unwrap();
        let t = AppTxn::new(Some(f));
        assert!(t.lock_file.is_some());
        // generation starts fresh even when a lock is held
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
    }
}
