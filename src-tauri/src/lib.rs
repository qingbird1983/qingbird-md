//! Tauri entry point: managed app state (`AppTxn`) + the first IPC commands
//! (file read/write, settings read/write). Workspace/editor commands land in
//! Task 6, dialogs Task 9, translation Task 8 — appended to `generate_handler!`.

mod dto;
mod editor;
mod fileopen;
mod markdown;
mod single_instance;
mod storage;
mod translate;
mod workspace;

use std::fs::File;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use translate::cache::Cache;

/// Managed shared state, registered via `.manage(AppTxn::new(lock))`.
///
/// `ponytail:` cache/cancel/running/gen are unread until Tasks 7-10 wire the
/// translation pipeline; `#[allow(dead_code)]` keeps that wiring out of Task 5.
#[allow(dead_code)]
struct AppTxn {
    cache: Mutex<Cache>,            // 翻译缓存共享
    cancel: Arc<AtomicBool>,        // 当前批次取消旗标
    running: Arc<AtomicBool>,
    /// 代次：新一轮翻译 +1；事件里带上，前端丢弃过期。
    /// Rust 2024 保留字，raw identifier（序列化不涉及，仅内部状态）。
    r#gen: AtomicU64,
    lock_file: Mutex<Option<File>>, // 单实例锁持有物，保进程生命周期
}

impl Default for AppTxn {
    fn default() -> Self {
        Self {
            cache: Mutex::new(Cache::new()),
            cancel: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            r#gen: AtomicU64::new(0),
            lock_file: Mutex::new(None),
        }
    }
}

impl AppTxn {
    fn new(lock: Option<File>) -> Self {
        let s = Self::default();
        *s.lock_file.lock().expect("lock_file mutex poisoned") = lock;
        s
    }
}

// ---- 文件 ----

#[tauri::command]
fn open_file(path: String) -> Result<dto::DocDTO, String> {
    let p = std::path::PathBuf::from(&path);
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(dto::doc_dto(&p, content))
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---- 设置 ----

#[tauri::command]
fn load_settings() -> storage::Settings {
    storage::load_settings()
}

#[tauri::command]
fn save_settings(settings: storage::Settings) {
    storage::save_settings(&settings);
}

#[tauri::command]
fn get_user_data_dir() -> String {
    storage::user_data_dir().to_string_lossy().into_owned()
}

pub fn run() {
    let lock = single_instance::acquire_lock();
    if lock.is_none() {
        // Second launch: hand a file-association path to the running instance.
        if let Some(p) = fileopen::file_arg_from_args(std::env::args().skip(1)) {
            single_instance::write_pending(&p);
        }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppTxn::new(lock))
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            load_settings,
            save_settings,
            get_user_data_dir,
            // Task 7-11 追加于此
        ])
        .setup(|_app| {
            // Task 10: 启动 pending 轮询线程 / 文件关联首打开（暂略）
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn txn_defaults_are_quiescent() {
        let t = AppTxn::default();
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        assert!(!t.cancel.load(Ordering::Relaxed));
        assert!(!t.running.load(Ordering::Relaxed));
        assert!(t.cache.lock().unwrap().is_empty());
        assert!(t.lock_file.lock().unwrap().is_none());
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
        assert!(t.lock_file.lock().unwrap().is_some());
        // generation starts fresh even when a lock is held
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
    }
}
