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
    /// 实际解码编码（"UTF-8" / "GB18030"），状态栏标注用。
    pub encoding: String,
    /// 打开时磁盘 mtime（毫秒）。外部修改检测与保存冲突检测的比对基线；
    /// 元数据不可得时为 None（前端跳过检测）。
    pub mtime: Option<i64>,
    pub parse: crate::markdown::html::ParseResult,
}

/// 磁盘 mtime → epoch 毫秒。元数据/时间源不可得一律 None（调用方跳过比对）。
pub fn file_mtime_millis(path: &std::path::Path) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// Build a [`DocDTO`] from a resolved path, its decoded content and encoding.
///
/// `target` 是当前翻译方向：它决定 `data-bi` 的占号（哪些块可译随方向变），
/// **必须与后续 `translate_document` 用同一个值**，否则流式译文会贴错块。
pub fn doc_dto(
    path: &std::path::Path,
    content: String,
    encoding: &str,
    target: crate::translate::engine::TargetLang,
) -> DocDTO {
    let parse = crate::markdown::html::render_html(
        &content,
        &Default::default(),
        false,
        target,
    );
    DocDTO {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".into()),
        path: Some(path.to_string_lossy().into_owned()),
        base_dir: path.parent().map(|d| d.to_string_lossy().into_owned()),
        char_count: content.chars().count(),
        line_count: content.lines().count(),
        encoding: encoding.to_owned(),
        mtime: file_mtime_millis(path),
        parse,
        content,
    }
}

/// Mirror of the workspace tree for the frontend file tree.
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

/// 选区查词：一条双语例句（spec 2026-08-29 §5.1）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupExample {
    pub en: String,
    pub zh: String,
}

/// 选区查词：一个生僻词解释。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupTerm {
    pub word: String,
    pub phonetic: String,
    pub explanation: String,
}

/// 选区查词结果。`kind = "word"` 时全部字段有效；`"sentence"` 时 phonetic
/// 及以下为 None / 空数组。serde 不改名（snake_case 线格式，ipc.ts 同名对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordLookupDTO {
    pub kind: String, // "word" | "sentence"
    pub translation: String,
    pub phonetic: Option<String>,
    pub part_of_speech: Option<String>,
    pub usage: Option<String>,
    pub examples: Vec<LookupExample>,
    pub terms: Vec<LookupTerm>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本文件的用例只关心 DTO 形状，方向无关，一律钉在 zh。
    const ZH: crate::translate::engine::TargetLang = crate::translate::engine::TargetLang::Zh;

    #[test]
    fn doc_dto_counts_chars_lines_and_dirs() {
        let d = doc_dto(std::path::Path::new("docs/note.md"), "a\nbb\nccc".into(), "UTF-8", ZH);
        assert_eq!(d.name, "note.md");
        assert!(d.path.as_deref().unwrap().ends_with("note.md"));
        assert_eq!(d.base_dir.as_deref(), Some("docs"));
        assert_eq!(d.char_count, 8);
        assert_eq!(d.line_count, 3);
        assert_eq!(d.content, "a\nbb\nccc");
        assert_eq!(d.encoding, "UTF-8");
    }

    #[test]
    fn doc_dto_root_path_has_no_name_no_base_dir() {
        let d = doc_dto(std::path::Path::new("/"), String::new(), "UTF-8", ZH);
        assert_eq!(d.name, "?");
        assert_eq!(d.base_dir, None);
        assert_eq!(d.char_count, 0);
        assert_eq!(d.line_count, 0); // str::lines("") yields nothing
    }

    #[test]
    fn doc_dtos_serde_roundtrip() {
        let d = doc_dto(std::path::Path::new("a.md"), "hi".into(), "UTF-8", ZH);
        let json = serde_json::to_string(&d).unwrap();
        let back: DocDTO = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "a.md");
        assert_eq!(back.char_count, 2);
        assert_eq!(back.encoding, "UTF-8");
        assert_eq!(back.mtime, None); // 测试路径不存在，mtime 不可得
    }
}
