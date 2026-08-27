//! Single-instance file-association handoff: scan CLI arguments for a file to
//! open (a second launch writes the pending path for the running instance, see
//! `single_instance.rs`). Native open/save dialogs live as tauri-plugin-dialog
//! commands in `lib.rs`.

use std::path::PathBuf;

/// Scan command-line arguments for an existing `.md`/`.markdown`/`.txt` file
/// (used when Windows launches the app through a file association).
pub fn file_arg_from_args(args: impl Iterator<Item = String>) -> Option<PathBuf> {
    for a in args {
        if a.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(&a);
        if let Some(ext) = p.extension() {
            let e = ext.to_string_lossy().to_lowercase();
            if (e == "md" || e == "markdown" || e == "txt") && p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
