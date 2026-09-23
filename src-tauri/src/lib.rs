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

use translate::cache_sqlite::SqliteCache;

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
    /// 翻译缓存共享（S9 起为 SQLite 后端）。Arc 包一层：后台 worker 克隆 Arc 出去，
    /// 收尾时短暂锁回写新键并 `flush`——绝不跨网络请求持锁。
    pub(crate) cache: Arc<Mutex<SqliteCache>>,
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
        Self::new_with_paths(lock, &storage::cache_db_path(), &storage::cache_path())
    }

    /// 路径注入版：生产用 [`Self::new`]（真实 `%APPDATA%` 路径），单测传临时路径，
    /// 绝不在测试里读写用户真实缓存 / 重命名用户文件。
    pub(crate) fn new_with_paths(
        lock: Option<File>,
        db_path: &std::path::Path,
        json_path: &std::path::Path,
    ) -> Self {
        // 启动装载：开 SQLite 库（不存在则建）。开不动（文件被占/权限/损坏）时
        // 降级为内存库——绝不因缓存后端崩掉整个应用（本会话不落盘，可接受）。
        let mut opened_durable = true;
        let mut cache = match SqliteCache::open_or_create(db_path) {
            Ok(c) => c,
            Err(e) => {
                opened_durable = false;
                eprintln!("[cache] SQLite 开库失败，本会话降级为内存库：{e}");
                SqliteCache::open_in_memory().expect("内存库不应失败")
            }
        };
        // 一次性导入旧 JSON（红线 6/7）。仅当库为空才导；导入成功且确为持久库时，
        // 才把旧 JSON 重命名为 `.imported-<ts>` 保留（不删，回滚依赖；降级内存库时
        // 保留源文件，否则下次仍旧开不动就永久丢缓存）。
        match cache.import_json_if_empty(json_path) {
            Ok(n) if n > 0 => {
                eprintln!("[cache] 已从旧 JSON 导入 {n} 条译文缓存");
                if opened_durable {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let bak = json_path.with_extension(format!("json.imported-{ts}"));
                    match std::fs::rename(json_path, &bak) {
                        Ok(()) => eprintln!("[cache] 旧 JSON 保留为 {}", bak.display()),
                        Err(e) => eprintln!("[cache] 旧 JSON 改名保留失败：{e}（下次启动会重试导入）"),
                    }
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("[cache] 导入旧 JSON 失败：{e}"),
        }
        Self {
            cache: Arc::new(Mutex::new(cache)),
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
        // 临时路径：绝不在单测里碰用户真实 %APPDATA% 缓存 / 改名用户 JSON。
        let dir = std::env::temp_dir().join(format!("qingbird-txn-quiet-{}", std::process::id()));
        let t = AppTxn::new_with_paths(None, &dir.join("cache.db"), &dir.join("cache.json"));
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        assert!(!t.cancel.load(Ordering::Relaxed));
        assert!(!t.running.load(Ordering::Relaxed));
        assert!(t.lock_file.is_none());
        let _ = std::fs::remove_dir_all(&dir);
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
        let t = AppTxn::new_with_paths(Some(f), &dir.join("cache.db"), &dir.join("cache.json"));
        assert!(t.lock_file.is_some());
        // generation starts fresh even when a lock is held
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
