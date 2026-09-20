//! 对话框薄壳（tauri-plugin-dialog）+ 预览外链白名单——同族归置：都是
//! 「前端请求系统侧动作」的薄壳（选文件 / 存文件 / 交给系统默认程序打开）。

use tauri_plugin_dialog::{DialogExt, FilePath};

// ---- 链接外部打开（T25：点 Markdown 链接整窗导航的修复）----

/// URL 是否可用系统默认方式打开。白名单 http/https/mailto/tel——一切其它
/// scheme（`javascript:`、`data:`、`vbscript:`、相对路径等）都返回 false：
/// WebView 永不执行或导航到它们。
pub(crate) fn is_openable_url(url: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel")
}

/// 用系统默认浏览器/程序打开外部链接。前端点击 Markdown 链接会走这里；
/// scheme 白名单在 Rust 侧再兜一道，防止 `javascript:` 之类经任何路径执行。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err(format!("blocked url: {url}"));
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

// ---- 对话框（Task 9，tauri-plugin-dialog）----

/// Convert a dialog result into a path string: `FilePath::Path` -> string,
/// everything else (`Url`, `None`) -> None.
fn dialog_result_to_path(chosen: Option<FilePath>) -> Option<String> {
    match chosen {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// Native open-file dialog filtered to markdown-ish files.
///
/// blocking API 禁止主线程调用（会冻结事件循环），故命令为 async——
/// 跑在 tauri::async_runtime 的 worker 线程上。
#[tauri::command]
pub async fn pick_file(window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .set_parent(&window)
        .blocking_pick_file();
    dialog_result_to_path(chosen)
}

/// Native directory picker for a workspace folder.
#[tauri::command]
pub async fn pick_folder(window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder();
    dialog_result_to_path(chosen)
}

/// Native save dialog seeded with a default filename.
#[tauri::command]
pub async fn pick_save_path(default_name: String, window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .blocking_save_file();
    dialog_result_to_path(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- T25: 预览链接外部打开（点链接不得整窗导航）----

    #[test]
    fn openable_url_whitelists_http_mailto_tel() {
        assert!(is_openable_url("https://gitee.com/muyan1983/qingbird-md"));
        assert!(is_openable_url("http://a.b/c?x=1#y"));
        assert!(is_openable_url("mailto:a@b.c"));
        assert!(is_openable_url("tel:+8613800000000"));
    }

    #[test]
    fn openable_url_rejects_dangerous_or_relative() {
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("data:text/html,<b>x</b>"));
        assert!(!is_openable_url("vbscript:msgbox(1)"));
        assert!(!is_openable_url("docs/a.md")); // 相对路径：无 base 无法 parse
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("   "));
    }
}
