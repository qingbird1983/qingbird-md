//! Workspace file tree: recursive `.md` walk (depth/file caps, skip dirs,
//! symlink-loop guard) and a filename search filter. Pure, testable.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 10;
const MAX_FILES: usize = 3000;

const SKIP: &[&str] = &["node_modules", ".git", "dist", "build", ".vscode", ".workbuddy", ".idea"];

#[derive(Debug, Clone)]
pub struct TreeNode {
    pub name: String,
    pub path: Option<PathBuf>, // None for directories
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Recursively collect Markdown documents under `root` as a tree.
pub fn walk(root: &Path) -> Vec<TreeNode> {
    let mut seen = HashSet::new();
    if let Ok(canon) = std::fs::canonicalize(root) {
        seen.insert(canon);
    }
    let mut counter = 0usize;
    walk_dir(root, 0, &mut seen, &mut counter)
}

fn walk_dir(dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, counter: &mut usize) -> Vec<TreeNode> {
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
        out.push(TreeNode { name, path: Some(path.clone()), is_dir: true, children });
    }
    for (name, path) in files {
        *counter += 1;
        out.push(TreeNode { name, path: Some(path), is_dir: false, children: Vec::new() });
    }
    out
}

fn is_md(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".txt")
}

/// Keep only files whose name matches `q` (case-insensitive), retaining all
/// ancestor directories. Empty `q` returns the tree unchanged.
pub fn filter(nodes: &[TreeNode], q: &str) -> Vec<TreeNode> {
    if q.trim().is_empty() {
        return nodes.to_vec();
    }
    let lower = q.to_lowercase();
    let keep = |n: &TreeNode| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_md_recognizes_extensions() {
        assert!(is_md("a.md"));
        assert!(is_md("b.markdown"));
        assert!(is_md("c.txt"));
        assert!(!is_md("d.png"));
    }

    #[test]
    fn filter_matches_by_filename_but_keeps_ancestors() {
        let tree = vec![
            TreeNode { name: "docs".into(), path: None, is_dir: true, children: vec![
                TreeNode { name: "readme.md".into(), path: Some(PathBuf::from("readme.md")), is_dir: false, children: vec![] },
                TreeNode { name: "guide.md".into(), path: Some(PathBuf::from("guide.md")), is_dir: false, children: vec![] },
            ]},
            TreeNode { name: "other.md".into(), path: Some(PathBuf::from("other.md")), is_dir: false, children: vec![] },
        ];
        let res = filter(&tree, "guide");
        assert_eq!(res.len(), 1);
        assert!(res[0].is_dir);
        assert_eq!(res[0].children.len(), 1);
        assert_eq!(res[0].children[0].name, "guide.md");
    }
}
