//! Native file dialogs (open/save a markdown file) via `rfd`.
//! Stubbed out — will be replaced by tauri-plugin-dialog in later tasks.

use std::path::PathBuf;

/// Show a native open-file dialog filtered to markdown files. Returns the
/// chosen path, or `None` if the user cancels.
pub fn pick_markdown_file() -> Option<PathBuf> {
    // TODO: replace with tauri-plugin-dialog (Task 5)
    None
}

/// Show a native directory picker for a workspace folder.
pub fn pick_folder() -> Option<PathBuf> {
    // TODO: replace with tauri-plugin-dialog (Task 5)
    None
}

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

/// Show a native save dialog for a markdown file. Returns the chosen path,
/// or `None` if the user cancels.
pub fn pick_save_path(_default_name: &str) -> Option<PathBuf> {
    // TODO: replace with tauri-plugin-dialog (Task 5)
    None
}
