//! Native file dialogs (open a markdown file) via `rfd`.

use std::path::PathBuf;

/// Show a native open-file dialog filtered to markdown files. Returns the
/// chosen path, or `None` if the user cancels.
pub fn pick_markdown_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file()
}
