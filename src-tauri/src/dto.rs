//! IPC DTOs shared between Rust commands and the TypeScript frontend (Task 14
//! binds these exact names via the generated command surface). Pure data +
//! one pure builder so commands stay thin wrappers.

use serde::{Deserialize, Serialize};

/// A loaded document handed to the frontend.
///
/// `parse` 是 content 的 markdown 渲染结果，随文档一次 IPC 下发——前端打开
/// 预览首帧即有内容（否则还要把全文再传回 parse_markdown，多一趟往返且中途空窗）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocDTO {
    pub name: String,
    pub path: Option<String>,
    pub content: String,
    pub base_dir: Option<String>,
    pub char_count: usize,
    pub line_count: usize,
    pub parse: crate::markdown::html::ParseResult,
}

/// Build a [`DocDTO`] from a resolved path and its UTF-8 content.
pub fn doc_dto(path: &std::path::Path, content: String) -> DocDTO {
    let parse = crate::markdown::html::render_html(&content, &Default::default(), false);
    DocDTO {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".into()),
        path: Some(path.to_string_lossy().into_owned()),
        base_dir: path.parent().map(|d| d.to_string_lossy().into_owned()),
        char_count: content.chars().count(),
        line_count: content.lines().count(),
        parse,
        content,
    }
}

/// Mirror of `workspace::TreeNode` for the frontend file tree.
///
/// `ponytail:` unused until Task 6 wires workspace commands; declared now
/// because Task 14 ipc.ts binds these exact names.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNodeDTO {
    pub name: String,
    pub path: Option<String>,
    pub is_dir: bool,
    pub children: Vec<TreeNodeDTO>,
}

/// An editor formatting request from the frontend: document text, byte
/// selection pair and the operation name (`bold`, `h1`, `ul`, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditOp {
    pub content: String,
    pub sel: [usize; 2],
    pub op: String,
}

/// The formatted document plus the new selection after an [`EditOp`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditResult {
    pub content: String,
    pub sel: [usize; 2],
}

/// One credential field of a provider's settings form.
///
/// `ponytail:` unused until Task 8 wires provider listing commands.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderFieldDto {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub placeholder: String,
}

/// Static metadata for a translation provider (mirrors providers_meta).
///
/// `ponytail:` unused until Task 8 wires provider listing commands.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfoDto {
    pub key: String,
    pub label: String,
    pub note: String,
    pub needs_key: bool,
    pub max_len: usize,
    pub max_concurrency: usize,
    pub fields: Vec<ProviderFieldDto>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_dto_counts_chars_lines_and_dirs() {
        let d = doc_dto(std::path::Path::new("docs/note.md"), "a\nbb\nccc".into());
        assert_eq!(d.name, "note.md");
        assert!(d.path.as_deref().unwrap().ends_with("note.md"));
        assert_eq!(d.base_dir.as_deref(), Some("docs"));
        assert_eq!(d.char_count, 8);
        assert_eq!(d.line_count, 3);
        assert_eq!(d.content, "a\nbb\nccc");
    }

    #[test]
    fn doc_dto_root_path_has_no_name_no_base_dir() {
        let d = doc_dto(std::path::Path::new("/"), String::new());
        assert_eq!(d.name, "?");
        assert_eq!(d.base_dir, None);
        assert_eq!(d.char_count, 0);
        assert_eq!(d.line_count, 0); // str::lines("") yields nothing
    }

    #[test]
    fn doc_dtos_serde_roundtrip() {
        let d = doc_dto(std::path::Path::new("a.md"), "hi".into());
        let json = serde_json::to_string(&d).unwrap();
        let back: DocDTO = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "a.md");
        assert_eq!(back.char_count, 2);
    }
}
