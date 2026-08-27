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
use std::path::PathBuf;
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

// ---- 工作区 ----

/// Walk a workspace folder into the frontend file tree (`.md`/`.markdown`
/// `.txt` only; dotfiles and vendored/build dirs skipped by `workspace::walk`).
#[tauri::command]
fn open_workspace(path: String) -> Vec<dto::TreeNodeDTO> {
    tree_out(&workspace::walk(std::path::Path::new(&path)))
}

/// Filter a client-held tree by filename query. Kernel filter operates on
/// [`workspace::TreeNode`], so this is the pure mechanical mapping
/// DTO→TreeNode→filter→DTO.
#[tauri::command]
fn filter_workspace(tree: Vec<dto::TreeNodeDTO>, query: String) -> Vec<dto::TreeNodeDTO> {
    tree_out(&workspace::filter(&tree_in(&tree), &query))
}

/// Create an empty file; refuses to overwrite (`create_new`).
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(()),
        Err(e) => Err(create_err("创建文件失败", &path, e)),
    }
}

/// Create a single directory (no parents implied).
#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| create_err("创建文件夹失败", &path, e))
}

/// Wire-contract error text: "已存在" when the target exists (the frontend
/// may match on it), contextual message for any other IO failure.
fn create_err(what: &str, path: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        "已存在".into()
    } else {
        format!("{what} {path}: {e}")
    }
}

// ---- 预览（Task 7）----

/// Resolve a markdown image `src` to a local absolute path
/// （逻辑 = 旧 render.rs::resolve_src 平移）：
/// - http(s)/data: -> `None`（远程图交给前端按 alt 兜底）
/// - file:// -> 剥前缀原样使用
/// - 相对路径 -> 与文档目录（base_dir）拼接
///
/// ponytail: 不做 `..` 归一化——asset 协议 scope 显式放开为 `**`
/// （文档可能在任意盘符目录，功能性需求而非漏洞放宽），scope 见 tauri.conf.json 的 assetProtocol。
fn resolve(src: &str, base_dir: Option<&str>) -> Option<PathBuf> {
    let s = src.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(p) = s.strip_prefix("file://") {
        return Some(PathBuf::from(p));
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") {
        return None;
    }
    let p = PathBuf::from(base_dir?).join(s);
    // join 在 Windows 上插入反斜杠；统一为 '/' 保持路径字符串可预测
    // （前端展示、测试断言一致）。Win32 API 两种分隔符均接受。
    Some(PathBuf::from(p.to_string_lossy().replace('\\', "/")))
}

#[tauri::command]
fn resolve_image(src: String, base_dir: Option<String>) -> Option<String> {
    resolve(&src, base_dir.as_deref()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn parse_markdown(content: String) -> markdown::html::ParseResult {
    markdown::html::render_html(&content, &std::collections::HashMap::new(), false)
}

// ---- 编辑器纯逻辑外壳 ----

#[tauri::command]
fn apply_op(op: dto::EditOp) -> dto::EditResult {
    apply_op_map(op)
}

/// Type-mapping shell around [`editor::apply_op`] ([usize;2] ↔ byte pair).
/// Snaps the selection onto UTF-8 char boundaries first so malformed IPC
/// payloads cannot panic mid-character — the frontend normally converts
/// CodeMirror code-point offsets to byte offsets before calling (plan Task 14).
pub(crate) fn apply_op_map(op: dto::EditOp) -> dto::EditResult {
    let c = &op.content;
    let s = snap_down(c, op.sel[0]);
    let e = snap_down(c, op.sel[1]).max(s);
    let (content, sel) = editor::apply_op(c, (s, e), &op.op);
    dto::EditResult { content, sel: [sel.0, sel.1] }
}

/// Clamp to string length and floor to the nearest preceding char boundary.
/// `is_char_boundary(0)` is always true, so this terminates.
fn snap_down(c: &str, mut i: usize) -> usize {
    i = i.min(c.len());
    while !c.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn tree_out(nodes: &[workspace::TreeNode]) -> Vec<dto::TreeNodeDTO> {
    nodes
        .iter()
        .map(|n| dto::TreeNodeDTO {
            name: n.name.clone(),
            path: n.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            is_dir: n.is_dir,
            children: tree_out(&n.children),
        })
        .collect()
}

fn tree_in(nodes: &[dto::TreeNodeDTO]) -> Vec<workspace::TreeNode> {
    nodes
        .iter()
        .map(|n| workspace::TreeNode {
            name: n.name.clone(),
            path: n.path.as_ref().map(std::path::PathBuf::from),
            is_dir: n.is_dir,
            children: tree_in(&n.children),
        })
        .collect()
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
            open_workspace,
            filter_workspace,
            create_file,
            create_folder,
            apply_op,
            parse_markdown,
            resolve_image,
            // Task 8-11 追加于此
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
    use std::path::PathBuf;
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

    // ---- Task 6: 工作区 / 编辑器命令外壳 ----

    // ---- Task 7: 图片解析 / Markdown 解析命令 ----

    #[test]
    fn resolve_skips_remote_and_resolves_relative() {
        assert_eq!(resolve("https://a/b.png", Some("D:/w")), None);
        assert_eq!(resolve("data:image/png;base64,x", None), None);
        assert_eq!(
            resolve("img/logo.png", Some("D:/w")).unwrap().to_string_lossy(),
            "D:/w/img/logo.png"
        );
        assert_eq!(resolve("file://C:/x.png", None).unwrap().to_string_lossy(), "C:/x.png");
        // 平移自旧逻辑的边界：空 src 与纯空白拒绝
        assert_eq!(resolve("", Some("D:/w")), None);
        assert_eq!(resolve("   ", Some("D:/w")), None);
    }

    #[test]
    fn apply_op_maps_types() {
        let op = dto::EditOp { content: "hi".into(), sel: [0, 2], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**hi**");
        // 内核契约（editor::wrap）：包裹后选区落在标记内的原文字上
        assert_eq!(r.sel, [2, 4]);
    }

    #[test]
    fn apply_op_cjk_selection_is_snapped_to_char_boundaries() {
        // 每个汉字 3 字节：1/7/99 都不在字符边界上，必须收敛而非 panic
        let op = dto::EditOp { content: "你好".into(), sel: [1, 4], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**你**好");
        assert_eq!(r.sel, [2, 5]);

        // 越界选择 → 钳到末尾空选区，插入占位符并选中它
        let beyond = dto::EditOp { content: "你好".into(), sel: [7, 99], op: "italic".into() };
        let r2 = apply_op_map(beyond);
        assert_eq!(r2.content, "你好*斜体*");
        assert_eq!(r2.sel, [7, 13]);
    }

    #[test]
    fn tree_out_and_back_preserve_structure() {
        let inner = workspace::TreeNode {
            name: "g.md".into(),
            path: Some(PathBuf::from("w/docs/g.md")),
            is_dir: false,
            children: vec![],
        };
        let tree = vec![workspace::TreeNode {
            name: "docs".into(),
            path: Some(PathBuf::from("w/docs")),
            is_dir: true,
            children: vec![inner],
        }];
        let out = tree_out(&tree);
        assert_eq!(out[0].name, "docs");
        assert!(out[0].is_dir);
        assert_eq!(out[0].children[0].name, "g.md");
        assert!(!out[0].children[0].is_dir);
        assert_eq!(out[0].children[0].path.as_deref(), Some("w/docs/g.md"));

        let back = tree_in(&out);
        assert_eq!(back[0].is_dir, true);
        assert_eq!(
            back[0].children[0].path.clone().unwrap(),
            PathBuf::from("w/docs/g.md")
        );
    }

    #[test]
    fn filter_workspace_dto_command_matches_and_keeps_ancestors() {
        let mk_file = |n: &str| dto::TreeNodeDTO {
            name: n.into(),
            path: Some(format!("docs/{n}")),
            is_dir: false,
            children: vec![],
        };
        let tree = vec![dto::TreeNodeDTO {
            name: "docs".into(),
            path: Some("docs".into()),
            is_dir: true,
            children: vec![mk_file("readme.md"), mk_file("api.md")],
        }];

        let hit = filter_workspace(tree.clone(), "api".into());
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].children.len(), 1);
        assert_eq!(hit[0].children[0].name, "api.md");

        let miss = filter_workspace(tree.clone(), "zzz".into());
        assert!(miss.is_empty());

        let all = filter_workspace(tree.clone(), "   ".into()); // 空查询原样返回
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].children.len(), 2);
    }
}
