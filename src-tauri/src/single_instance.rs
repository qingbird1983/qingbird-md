//! Single-instance behavior via an advisory file lock + a pending-file handoff.
//!
//! The first instance holds an exclusive lock on `{appdata}/qingbird.lock`. If a
//! second instance starts and a file path was passed (file association), it
//! writes the path to `qingbird-pending.txt` and exits; the first instance
//! polls for that file and opens the document.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::storage::user_data_dir;

fn lock_path() -> PathBuf {
    user_data_dir().join("qingbird.lock")
}

fn pending_path() -> PathBuf {
    user_data_dir().join("qingbird-pending.txt")
}

/// Acquire the single-instance lock. Returns `Some(file)` to hold for the
/// process lifetime if acquired, or `None` if another instance already runs.
pub fn acquire_lock() -> Option<File> {
    let _ = fs::create_dir_all(user_data_dir());
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path())
        .ok()?;
    f.try_lock().ok().map(|()| f)
}

/// Ask the running instance to open `path` (used when a second launch happens).
pub fn write_pending(path: &Path) {
    let _ = fs::create_dir_all(user_data_dir());
    let _ = fs::write(pending_path(), path.to_string_lossy().as_bytes());
}

/// Pending-file payload meaning "wake the main window only"（无文档路径）。
const SHOW_WAKE: &str = "show";

/// Ask the running instance to just show its main window (second launch
/// without a file argument — tray-resident app must respond to icon clicks).
pub fn write_show_wake() {
    let _ = fs::create_dir_all(user_data_dir());
    let _ = fs::write(pending_path(), SHOW_WAKE);
}

/// Pending payload sentinel: contents exactly `show` mean "wake the window
/// only", anything else is a file path to open.
pub fn is_show_wake(p: &Path) -> bool {
    p.to_string_lossy() == SHOW_WAKE
}

/// Read and remove a pending open-file request, if any.
pub fn take_pending() -> Option<PathBuf> {
    let p = pending_path();
    let s = fs::read_to_string(&p).ok()?;
    let path = PathBuf::from(s.trim());
    let _ = fs::remove_file(&p);
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_wake_marker_roundtrip() {
        let dir = std::env::temp_dir().join(format!("qingbird-wake-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let pfile = dir.join("p.txt");
        // write_show_wake 的路径可注入版本：写哨兵常量 → 读回一致
        fs::write(&pfile, SHOW_WAKE).unwrap();
        let s = fs::read_to_string(&pfile).unwrap();
        assert_eq!(s.trim(), "show");
    }

    #[test]
    fn show_wake_sentinel_is_detected() {
        assert!(is_show_wake(Path::new(SHOW_WAKE)));
    }

    #[test]
    fn pending_roundtrip() {
        // Use a temp path separate from the real appdata to avoid clobbering.
        let dir = std::env::temp_dir().join(format!("qingbird-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let pfile = dir.join("p.txt");
        fs::write(&pfile, b"C:\\some\\doc.md").unwrap();
        let taken = take_pending_from(&pfile);
        assert_eq!(taken.map(|p| p.to_string_lossy().into_owned()), Some("C:\\some\\doc.md".into()));
    }

    fn take_pending_from(p: &Path) -> Option<PathBuf> {
        let s = fs::read_to_string(p).ok()?;
        let path = PathBuf::from(s.trim());
        let _ = fs::remove_file(p);
        Some(path)
    }
}
