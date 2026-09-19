//! Workspace file tree: recursive `.md` walk (depth/file caps, skip dirs,
//! symlink-loop guard) and a filename search filter. Pure, testable.
//!
//! `TreeNode` 之前是独立 struct + 后续 DTO 互转；现在直接吐 [`dto::TreeNodeDTO`]，
//! 端口与 IPC 共享同一形态，省掉 walk → DTO → kernel → DTO 的两趟纯结构往返。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::dto::TreeNodeDTO;

const MAX_DEPTH: usize = 10;
const MAX_FILES: usize = 3000;

// "target" is a divergence from the frozen kernel source: on Windows the Rust
// workspace target/ tree floods the walk and trips MAX_FILES truncation.
const SKIP: &[&str] =
    &["node_modules", ".git", "dist", "build", ".vscode", ".workbuddy", ".idea", "target"];

/// Recursively collect Markdown documents under `root` as a tree.
pub fn walk(root: &Path) -> Vec<TreeNodeDTO> {
    let mut seen = HashSet::new();
    if let Ok(canon) = std::fs::canonicalize(root) {
        seen.insert(canon);
    }
    let mut counter = 0usize;
    walk_dir(root, 0, &mut seen, &mut counter)
}

fn walk_dir(dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, counter: &mut usize) -> Vec<TreeNodeDTO> {
    if depth > MAX_DEPTH || *counter > MAX_FILES {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            dirs.push((name, path));
        } else if ft.is_file() && is_md(&name) {
            files.push((name, path));
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let mut out = Vec::new();
    for (name, path) in dirs {
        let canon = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&canon) {
            continue;
        }
        seen.insert(canon);
        let children = walk_dir(&path, depth + 1, seen, counter);
        out.push(TreeNodeDTO {
            name,
            path: Some(path.to_string_lossy().into_owned()),
            is_dir: true,
            children,
        });
    }
    for (name, path) in files {
        *counter += 1;
        out.push(TreeNodeDTO {
            name,
            path: Some(path.to_string_lossy().into_owned()),
            is_dir: false,
            children: Vec::new(),
        });
    }
    out
}

fn is_md(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

/// Keep only files whose name matches `q` (case-insensitive), retaining all
/// ancestor directories. Empty `q` returns the tree unchanged.
pub fn filter(nodes: &[TreeNodeDTO], q: &str) -> Vec<TreeNodeDTO> {
    if q.trim().is_empty() {
        return nodes.to_vec();
    }
    let lower = q.to_lowercase();
    let keep = |n: &TreeNodeDTO| {
        if n.is_dir {
            let kids = filter(&n.children, q);
            if kids.is_empty() {
                None
            } else {
                let mut copy = n.clone();
                copy.children = kids;
                Some(copy)
            }
        } else {
            if n.name.to_lowercase().contains(&lower) {
                Some(n.clone())
            } else {
                None
            }
        }
    };
    nodes.iter().filter_map(keep).collect()
}

// ---- 文件操作（2026-09-12：树右键菜单所需的重命名/移动/模板）----

/// 名称合法性：非空、无路径分隔符、无 Windows 非法字符、非 `.`/`..`。
/// 返回 Err(中文提示) 供前端直接 toast。
pub fn validate_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if n == "." || n == ".." {
        return Err("名称无效".into());
    }
    if n.contains(['/', '\\']) {
        return Err("名称不能包含路径分隔符".into());
    }
    if n.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err("名称不能包含 \\ / : * ? \" < > | 等字符".into());
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("名称不能以空格或点结尾".into());
    }
    Ok(())
}

/// 同目录改名的目标路径：`父目录/新名`。
pub fn renamed_path(path: &str, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    let p = Path::new(path);
    let parent = p.parent().ok_or_else(|| "无法定位父目录".to_string())?;
    Ok(parent.join(new_name.trim()).to_string_lossy().into_owned())
}

/// 移动到目标目录后的完整路径：`dest_dir/原文件名`。
pub fn moved_path(path: &str, dest_dir: &str) -> Result<String, String> {
    let name = Path::new(path)
        .file_name()
        .ok_or_else(|| "无法定位文件名".to_string())?
        .to_string_lossy()
        .into_owned();
    Ok(Path::new(dest_dir).join(name).to_string_lossy().into_owned())
}

/// 模板正文：front matter 起头（与解析器的 front matter 支持对齐）。
/// 未知 kind 返回空串（= 空白文档）。
pub fn template_body(kind: &str) -> &'static str {
    match kind {
        "note" => "---\ntitle: \ndate: \ntags: []\n---\n\n# 读书笔记\n\n## 摘要\n\n\n## 要点\n\n- \n\n## 摘录\n\n> \n\n## 我的想法\n\n",
        "meeting" => "---\ntitle: \ndate: \nattendees: []\n---\n\n# 会议记录\n\n## 议题\n\n\n## 结论\n\n- \n\n## 待办\n\n- [ ] \n",
        "plan" => "---\ntitle: \nstatus: draft\n---\n\n# 项目计划\n\n## 目标\n\n\n## 里程碑\n\n| 阶段 | 交付物 | 时间 |\n| --- | --- | --- |\n|  |  |  |\n\n## 任务\n\n- [ ] \n",
        "daily" => "---\ntitle: \ndate: \n---\n\n# 今日记录\n\n## 完成\n\n- \n\n## 进行中\n\n- \n\n## 问题\n\n- \n\n## 明日\n\n- \n",
        _ => "",
    }
}

// ---- SEC-2（P1-2）：路径归一与允许根校验 ----
//
// 威胁模型是「前端被污染」（SEC-1）：自定义命令不受 capability 约束，任意 JS
// 都能带任意路径调用。根登记走 open_workspace（树右键一族命令的路径全部来自
// 其 walk 结果），resolve 的解析结果必须落在文档目录或某个已登记根之内——
// 这是唯一被文档内容直接驱动的路径入口。open_file/save_file 等因「打开/另存为」
// 是合法的任意路径流程，不做根校验（有意取舍，见命令注释）。

/// 本会话已登记的允许根（canonical 形态）。仅内存：应用重启即清空，不持久化。
static ALLOWED_ROOTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// 登记一个允许根：canonical 化（解析符号链接，Windows 产出剥 `\\?\` 前缀）
/// 后去重保存。失败（目录不存在等）静默忽略——walk 同样会失败，登记无意义。
pub fn register_root(path: &Path) {
    let Some(root) = std::fs::canonicalize(path).ok().map(|p| strip_verbatim(&p)) else {
        return;
    };
    let mut roots = ALLOWED_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if !roots.contains(&root) {
        roots.push(root);
    }
}

/// 已登记允许根的快照。
pub fn allowed_roots() -> Vec<PathBuf> {
    ALLOWED_ROOTS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `path` 是否落在任一已登记根内。
pub fn is_within_any_root(path: &Path) -> bool {
    allowed_roots().iter().any(|r| path_within(path, r))
}

/// 工作区写命令的统一根校验：不在任一已登记根内 → Err（中文提示，前端直接
/// toast）。校验放在一切存在性检查与 IO 之前，不向被污染方泄露根外路径信息。
pub fn ensure_within_roots(path: &Path) -> Result<(), String> {
    if is_within_any_root(path) {
        Ok(())
    } else {
        Err("路径不在已打开的工作区内".into())
    }
}

/// 判定 `path` 是否落在 `root` 内。两侧各自归一（canonicalize 优先——解析
/// 符号链接并剥 Windows `\\?\` 前缀；目标不存在时退回 `.`/`..` 词法归一），
/// 任一侧归一失败（越根/空路径）→ false。
pub fn path_within(path: &Path, root: &Path) -> bool {
    if path.as_os_str().is_empty() || root.as_os_str().is_empty() {
        return false;
    }
    match (normalize_for_compare(path), normalize_for_compare(root)) {
        (Some(p), Some(r)) => normalized_contains(&r, &p),
        _ => false,
    }
}

/// 比较用归一：canonicalize 成功则用真实路径（剥 `\\?\` 前缀）；失败（通常
/// 是路径尚不存在，如待创建文件）退回词法归一；词法归一也失败（`..` 越根）
/// 返回 None。
fn normalize_for_compare(p: &Path) -> Option<PathBuf> {
    if let Ok(canon) = std::fs::canonicalize(p) {
        return Some(strip_verbatim(&canon));
    }
    normalize_lexical(p)
}

/// `.`/`..` 词法归一（逐 component 重放，不触碰文件系统、不解析符号链接）。
/// `..` 逃出根（`/../..`、`C:\..\..`）返回 None；`.` 丢弃；重复分隔符由
/// components 天然折叠。
pub fn normalize_lexical(p: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None; // 越过根
                }
            }
            c => out.push(c.as_os_str()),
        }
    }
    Some(out)
}

/// Windows canonicalize 产出 `\\?\C:\...` / `\\?\UNC\server\share` verbatim
/// 形态，与普通路径字符串不可比——剥回 `C:\...` / `\\server\share` 再比较。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.as_os_str().to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

/// 两个已归一路径的包含判定：统一 '/'、去尾分隔符、Windows 大小写不敏感；
/// 前缀命中必须落在分隔符边界（`/ws` 不包含 `/www`）。
fn normalized_contains(root: &Path, path: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/');
        if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
    };
    let (r, p) = (norm(root), norm(path));
    let Some(rest) = p.strip_prefix(&r) else {
        return false;
    };
    rest.is_empty() || rest.starts_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rejects_separators_and_reserved_chars() {
        assert!(validate_name("a.md").is_ok());
        assert!(validate_name("  笔记.md ").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("a/b.md").is_err());
        assert!(validate_name("a:b.md").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("x.").is_err());
    }

    #[test]
    fn renamed_and_moved_paths_keep_directory_contract() {
        let r = renamed_path("C:\\ws\\docs\\a.md", "b.md").unwrap();
        assert_eq!(r, "C:\\ws\\docs\\b.md");
        let m = moved_path("C:\\ws\\docs\\a.md", "C:\\ws\\archive").unwrap();
        assert_eq!(m, "C:\\ws\\archive\\a.md");
    }

    #[test]
    fn templates_are_non_empty_except_blank() {
        assert_eq!(template_body("blank"), "");
        for k in ["note", "meeting", "plan", "daily"] {
            assert!(!template_body(k).is_empty(), "{k} template empty");
        }
    }

    #[test]
    fn is_md_recognizes_extensions() {
        assert!(is_md("a.md"));
        assert!(is_md("b.markdown"));
        assert!(is_md("c.txt"));
        assert!(!is_md("d.png"));
    }

    // ---- SEC-2（P1-2）：归一与根校验 ----

    #[test]
    fn normalize_lexical_collapses_dotdot_and_rejects_root_escape() {
        use std::path::Path;
        assert_eq!(
            normalize_lexical(Path::new("D:/w/docs/../assets/x.png")).unwrap(),
            PathBuf::from("D:/w/assets/x.png")
        );
        // `.` 丢弃（component 级比较天然吸收分隔符差异）
        assert_eq!(
            normalize_lexical(Path::new("D:/w/./docs/../docs/x.md")).unwrap(),
            PathBuf::from("D:/w").join("docs/x.md")
        );
        // 逃出根：Unix 绝对路径与 Windows 盘符路径都返回 None
        assert_eq!(normalize_lexical(Path::new("/a/../../..")), None);
        assert_eq!(normalize_lexical(Path::new(r"C:\..\..")), None);
    }

    #[test]
    fn contains_respects_separator_boundary_and_case() {
        use std::path::Path;
        assert!(normalized_contains(Path::new("D:/ws"), Path::new("D:/ws/docs/a.md")));
        assert!(normalized_contains(Path::new("D:/ws"), Path::new("D:/ws")));
        // 前缀同串但越过目录边界：不含
        assert!(!normalized_contains(Path::new("D:/ws"), Path::new("D:/www/a.md")));
        // Windows 大小写不敏感（非 Windows 尊重原大小写语义）
        assert_eq!(
            normalized_contains(Path::new("D:/WS"), Path::new("d:/ws/a.md")),
            cfg!(windows)
        );
        // 盘符根：`C:\` 包含其下一切
        assert!(normalized_contains(Path::new("C:\\"), Path::new("C:/x/y.png")));
    }

    #[test]
    fn path_within_canonicalizes_and_falls_back_lexically() {
        let dir = std::env::temp_dir().join(format!("qingbird-ws-within-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();

        // 存在的子目录：canonical 归一后包含（Windows `\\?\` 前缀已剥）
        assert!(path_within(&dir.join("docs"), &dir));
        // 不存在的待创建路径：词法回退仍判定包含
        assert!(path_within(&dir.join("docs").join("new.md"), &dir));
        // `..` 逃出根：拒绝
        assert!(!path_within(&dir.join("..").join("escape.md"), &dir));
        // 同前缀不同目录：拒绝
        let sibling = dir.parent().unwrap().join(format!("qingbird-ws-within-sib-{}", std::process::id()));
        assert!(!path_within(&sibling, &dir));
        // 空路径不包含任何东西
        assert!(!path_within(std::path::Path::new(""), &dir));
        assert!(!path_within(&dir, std::path::Path::new("")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_root_is_idempotent_and_gates_within_checks() {
        let dir = std::env::temp_dir().join(format!("qingbird-ws-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        register_root(&dir);
        register_root(&dir); // 去重
        // 登记的是剥 `\\?\` 前缀后的 canonical 形态
        assert_eq!(
            allowed_roots().iter().filter(|r| **r == strip_verbatim(&dir.canonicalize().unwrap())).count(),
            1
        );
        assert!(is_within_any_root(&dir.join("a.md")));
        let outside =
            std::env::temp_dir().join(format!("qingbird-ws-roots-out-{}", std::process::id()));
        assert!(!is_within_any_root(&outside));

        // canonical 化失败（不存在）静默忽略
        register_root(&outside);
        assert!(!allowed_roots().contains(&outside));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_skips_target_dir() {
        // Windows Rust 工作区树会被 target 淹没触发 MAX_FILES 截断，
        // 故 target 必须像 node_modules 一样被跳过、绝不出现于结果树。
        let dir = std::env::temp_dir().join(format!("qingbird-ws-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("target").join("debug")).unwrap();
        std::fs::write(dir.join("docs").join("a.md"), "x").unwrap();
        std::fs::write(dir.join("target").join("debug").join("evil.md"), "x").unwrap();

        let tree = walk(&dir);
        assert_eq!(tree.len(), 1, "only docs should be listed, got {tree:?}");
        assert_eq!(tree[0].name, "docs");
        assert_eq!(tree[0].children[0].name, "a.md");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn filter_matches_by_filename_but_keeps_ancestors() {
        let tree = vec![
            TreeNodeDTO {
                name: "docs".into(),
                path: None,
                is_dir: true,
                children: vec![
                    TreeNodeDTO { name: "readme.md".into(), path: Some("readme.md".into()), is_dir: false, children: vec![] },
                    TreeNodeDTO { name: "guide.md".into(), path: Some("guide.md".into()), is_dir: false, children: vec![] },
                ],
            },
            TreeNodeDTO {
                name: "other.md".into(),
                path: Some("other.md".into()),
                is_dir: false,
                children: vec![],
            },
        ];
        let res = filter(&tree, "guide");
        assert_eq!(res.len(), 1);
        assert!(res[0].is_dir);
        assert_eq!(res[0].children.len(), 1);
        assert_eq!(res[0].children[0].name, "guide.md");
    }
}
