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
