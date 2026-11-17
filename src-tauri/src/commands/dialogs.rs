//! 对话框薄壳（tauri-plugin-dialog）+ 预览外链白名单——同族归置：都是
//! 「前端请求系统侧动作」的薄壳（选文件 / 存文件 / 交给系统默认程序打开）。

use tauri_plugin_dialog::{DialogExt, FilePath};

/// 取文件名（末段）的小写扩展名；无点、点开头（.gitignore）、加点结尾都算无扩展名。
fn name_extension(name: &str) -> Option<String> {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty())
}

/// 保存对话框默认名：无后缀补 .md（新建文档「未命名」场景），有后缀原样保留
/// （HTML 导出的 xxx.html、翻译导出的 xxx.md/.bilingual.md 走这里不会被改）。
/// 返回（补好后缀的默认名, 最终后缀）。
fn save_default_spec(default_name: &str) -> (String, String) {
    match name_extension(default_name) {
        Some(ext) => (default_name.to_string(), ext),
        None => (format!("{default_name}.md"), "md".to_string()),
    }
}

/// 对话框返回路径的兜底：若用户把后缀删了，按既定后缀补回；已有任意后缀则尊重用户输入。
fn ensure_saved_extension(path: String, ext: &str) -> String {
    if name_extension(&path).is_some() {
        return path;
    }
    format!("{path}.{ext}")
}

/// 按后缀选保存对话框过滤器；md/markdown/txt 归 Markdown（与 pick_file 同口径）。
fn filter_for_ext(ext: &str) -> (&'static str, &'static [&'static str]) {
    match ext {
        "html" | "htm" => ("HTML", &["html", "htm"]),
        "txt" => ("Text", &["txt"]),
        _ => ("Markdown", &["md", "markdown", "txt"]),
    }
}

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
///
/// 默认名无后缀时补 .md 并挂 Markdown 过滤器，且对返回值兜底补后缀——这样新建
/// 文档（默认名「未命名」）直接回车即可存成 .md，不必每次手填。带后缀的默认名
/// （HTML 导出的 xxx.html / 翻译导出的 xxx.bilingual.md）原样保留、按后缀选过滤器。
#[tauri::command]
pub async fn pick_save_path(default_name: String, window: tauri::Window) -> Option<String> {
    let (seeded_name, ext) = save_default_spec(&default_name);
    let (filter_name, filter_exts) = filter_for_ext(&ext);
    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(seeded_name)
        .add_filter(filter_name, filter_exts)
        .blocking_save_file();
    dialog_result_to_path(chosen).map(|p| ensure_saved_extension(p, &ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 保存对话框：新建文档默认补 .md，导出场景按后缀保留 ----

    #[test]
    fn save_default_spec_adds_md_when_no_extension() {
        // 新建文档默认名「未命名」→ 补 .md
        assert_eq!(
            save_default_spec("未命名"),
            ("未命名.md".into(), "md".into())
        );
        assert_eq!(
            save_default_spec("我的笔记"),
            ("我的笔记.md".into(), "md".into())
        );
    }

    #[test]
    fn save_default_spec_keeps_existing_extension() {
        // HTML / 翻译导出带后缀，不能被改成 .md
        assert_eq!(
            save_default_spec("文章.html"),
            ("文章.html".into(), "html".into())
        );
        assert_eq!(save_default_spec("doc.md"), ("doc.md".into(), "md".into()));
        assert_eq!(
            save_default_spec("doc.en.bilingual.md"),
            ("doc.en.bilingual.md".into(), "md".into())
        );
    }

    #[test]
    fn ensure_saved_extension_fills_only_when_missing() {
        assert_eq!(
            ensure_saved_extension("C:\\doc\\笔记".into(), "md"),
            "C:\\doc\\笔记.md"
        );
        // 用户显式保留的后缀（含非 md）要尊重，不强行追加
        assert_eq!(
            ensure_saved_extension("C:\\doc\\a.txt".into(), "md"),
            "C:\\doc\\a.txt"
        );
        assert_eq!(
            ensure_saved_extension("C:\\doc\\a.md".into(), "md"),
            "C:\\doc\\a.md"
        );
    }

    #[test]
    fn filter_for_ext_matches_extension() {
        assert_eq!(filter_for_ext("md").0, "Markdown");
        assert_eq!(filter_for_ext("html").0, "HTML");
        assert_eq!(filter_for_ext("txt").0, "Text");
    }

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
