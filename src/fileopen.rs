//! Native file dialogs (open/save a markdown file) via `rfd`.

use std::path::PathBuf;

/// Show a native open-file dialog filtered to markdown files. Returns the
/// chosen path, or `None` if the user cancels.
pub fn pick_markdown_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file()
}

/// Show a native directory picker for a workspace folder.
pub fn pick_folder() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_folder()
}

/// Show a native save dialog for a markdown file. Returns the chosen path,
/// or `None` if the user cancels.
pub fn pick_save_path(default_name: &str) -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(default_name)
        .save_file()
}
