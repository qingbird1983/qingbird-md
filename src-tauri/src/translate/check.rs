//! Deterministic checks over a translation result.
//!
//! These checks answer questions the data-ri index space already makes it
//! cheap to answer — "which run has no translation", "did the marker set
//! survive", "did the block count change", "did code/TeX get rewritten" —
//! without paying for an AI round trip. AI-driven semantic review (see
//! `docs/superpowers/plans/2026-09-16-translation-correctness.md` §七) is
//! a separate concern layered on top of whatever these checks surface.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::markdown::model::{parse_blocks, Block, Inline};

/// One finding from `check_translation`. Mirrored by the frontend as
/// `src/lib/checkTranslation.ts`; keep both shapes in lockstep.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    /// Run index in the `data-ri` space (matches the keys of `translations`).
    pub run: usize,
    /// What kind of problem this is.
    pub kind: IssueKind,
    pub severity: Severity,
    pub src_excerpt: String,
    pub dst_excerpt: String,
    pub src_line: usize,
    pub dst_line: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum IssueKind {
    /// The `translations` map has no entry for this run at all — the
    /// translation pipeline never produced anything for it.
    OmittedUntranslated,
    /// The `translations` map has an entry, but it is byte-identical to the
    /// source text — the translator echoed the original instead of
    /// translating. Distinct from `OmittedUntranslated` because the
    /// pipeline did produce *something*; downstream tooling may want to
    /// retry rather than treat the run as missing.
    EchoOfSource,
    /// Source carries Markdown inline markers (`**` / ` `` ` / `[..](..)`
    /// / fenced code / etc.) that the translation dropped. The result is
    /// a structurally valid paragraph whose formatting collapsed to plain
    /// text — common when the translator isn't told to preserve them.
    MarksLost,
    /// The translation changes the block structure of the run — e.g.
    /// splits a single paragraph into two, merges two paragraphs, drops a
    /// list item, or changes a heading level. Bilingual export (§四 L3)
    /// relies on the block count being preserved per run, so this is
    /// always a hard error regardless of language.
    StructureMismatch,
    /// The translation rewrote the inside of a fenced code block (or, in
    /// later slices, inline code / math). Code and formulas are not localizable;
    /// translating them produces output that no longer compiles or renders.
    CodeInvaded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Severity {
    Warning,
}

/// Run every deterministic check over `content` against `translations`
/// (run-indexed, mirroring the `data-ri` space). Each issue points at the
/// run it concerns; the caller decides what to render.
pub fn check_translation(
    content: &str,
    translations: &HashMap<usize, String>,
) -> Vec<Issue> {
    let blocks = parse_blocks(content);
    let mut issues = Vec::new();

    for (i, block) in blocks.iter().enumerate() {
        let src = block_text(block);
        match translations.get(&i) {
            None => issues.push(Issue {
                run: i,
                kind: IssueKind::OmittedUntranslated,
                severity: Severity::Warning,
                src_excerpt: src,
                dst_excerpt: String::new(),
                src_line: 0,
                dst_line: 0,
            }),
            Some(dst) if dst == &src => issues.push(Issue {
                run: i,
                kind: IssueKind::EchoOfSource,
                severity: Severity::Warning,
                src_excerpt: src,
                dst_excerpt: dst.clone(),
                src_line: 0,
                dst_line: 0,
            }),
            Some(dst) => {
                if let Some(issue) = check_marks_lost(block, dst, i, &src) {
                    issues.push(issue);
                }
                if let Some(issue) = check_structure(block, dst, i, &src) {
                    issues.push(issue);
                }
                if let Some(issue) = check_code_invaded(block, dst, i, &src) {
                    issues.push(issue);
                }
            }
        }
    }

    issues
}

/// Inline code markers (and any other inline markers added later) lost
/// between source and translation. Re-parses the translation so the
/// structural comparison isn't fooled by translation-side reordering of
/// plain text.
fn check_marks_lost(
    src_block: &Block,
    dst_text: &str,
    run: usize,
    src_text: &str,
) -> Option<Issue> {
    let src_codes = count_inline_codes(src_block);
    let dst_blocks = parse_blocks(dst_text);
    let dst_block = dst_blocks.first()?;
    let dst_codes = count_inline_codes(dst_block);

    if src_codes > dst_codes {
        Some(Issue {
            run,
            kind: IssueKind::MarksLost,
            severity: Severity::Warning,
            src_excerpt: src_text.to_string(),
            dst_excerpt: dst_text.to_string(),
            src_line: 0,
            dst_line: 0,
        })
    } else {
        None
    }
}

fn count_inline_codes(b: &Block) -> usize {
    let inlines: &[Inline] = match b {
        Block::Paragraph { text } | Block::Heading { text, .. } => text,
        _ => return 0,
    };
    inlines.iter().filter(|i| matches!(i, Inline::Code(_))).count()
}

/// Per-run block-count check. A single source block must translate to a
/// single target block; splitting, merging, or dropping within a run breaks
/// the run-aligned indexing that bilingual export and inline patch both
/// depend on.
fn check_structure(
    _src_block: &Block,
    dst_text: &str,
    run: usize,
    src_text: &str,
) -> Option<Issue> {
    let dst_blocks = parse_blocks(dst_text);
    if dst_blocks.len() == 1 {
        return None;
    }
    Some(Issue {
        run,
        kind: IssueKind::StructureMismatch,
        severity: Severity::Warning,
        src_excerpt: src_text.to_string(),
        dst_excerpt: dst_text.to_string(),
        src_line: 0,
        dst_line: 0,
    })
}

/// Fenced-code-block content comparison. Code is not localizable; the
/// translator must copy the source verbatim inside the fence. (Inline code
/// and math are similar but use different block shapes; they will land in
/// later slices.)
fn check_code_invaded(
    src_block: &Block,
    dst_text: &str,
    run: usize,
    src_text: &str,
) -> Option<Issue> {
    let src_code = match src_block {
        Block::Code { code, .. } => code,
        _ => return None,
    };
    let dst_blocks = parse_blocks(dst_text);
    let dst_block = dst_blocks.first()?;
    let dst_code = match dst_block {
        Block::Code { code, .. } => code,
        _ => return None,
    };
    if src_code == dst_code {
        return None;
    }
    Some(Issue {
        run,
        kind: IssueKind::CodeInvaded,
        severity: Severity::Warning,
        src_excerpt: src_text.to_string(),
        dst_excerpt: dst_text.to_string(),
        src_line: 0,
        dst_line: 0,
    })
}

/// Plain-text excerpt for a single block. Only the `text`-bearing variants
/// are handled in the first slice; the rest fall back to empty and will
/// gain proper excerpts when their check kinds land.
fn block_text(b: &Block) -> String {
    let inlines: &[Inline] = match b {
        Block::Paragraph { text } | Block::Heading { text, .. } => text,
        _ => return String::new(),
    };
    inlines
        .iter()
        .filter_map(|i| match i {
            Inline::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_runs_with_no_translation_entry() {
        // 文档两段，translations 表只覆盖第 0 段；第 1 段必须被报漏译。
        let content = "第一段原文。\n\n第二段原文。";
        let mut translations = HashMap::new();
        translations.insert(0, "First paragraph translation.".to_string());

        let issues = check_translation(content, &translations);

        let omitted: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::OmittedUntranslated)
            .collect();
        assert_eq!(
            omitted.len(),
            1,
            "expected exactly one omitted-translation issue, got {issues:?}"
        );
        assert_eq!(omitted[0].run, 1, "second run is the one untranslated");
        assert_eq!(omitted[0].src_excerpt, "第二段原文。");
        // 第一段是真正的译文（与原文不同），不应被报。
        assert!(omitted.iter().all(|i| i.run != 0));
    }

    #[test]
    fn flags_translations_that_echo_the_source() {
        // 翻译器以原句充译文——这是「漏译」的另一形态。
        let content = "本应被翻译。";
        let mut translations = HashMap::new();
        translations.insert(0, "本应被翻译。".to_string()); // 与原文一致

        let issues = check_translation(content, &translations);

        let echo: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::EchoOfSource)
            .collect();
        assert_eq!(
            echo.len(),
            1,
            "expected exactly one echo-of-source issue, got {issues:?}"
        );
        assert_eq!(echo[0].run, 0);
        // 有译文条目，不应被报成 OmittedUntranslated。
        assert!(issues.iter().all(|i| i.kind != IssueKind::OmittedUntranslated));
        // 译文片段也要带上，便于面板对照展示。
        assert_eq!(echo[0].dst_excerpt, "本应被翻译。");
    }

    #[test]
    fn flags_translations_that_drop_inline_code_markers() {
        // 原文里有 inline code `foo`，译文里只剩裸文本——「标记丢失」。
        let content = "使用 `foo` 函数。";
        let mut translations = HashMap::new();
        translations.insert(0, "Use the foo function.".to_string());

        let issues = check_translation(content, &translations);

        let lost: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::MarksLost)
            .collect();
        assert_eq!(
            lost.len(),
            1,
            "expected one marker-loss issue, got {issues:?}"
        );
        assert_eq!(lost[0].run, 0);
        // 已翻译（与原文不同），不应被同时报为 EchoOfSource 或 Omitted。
        assert!(issues
            .iter()
            .all(|i| i.kind != IssueKind::EchoOfSource && i.kind != IssueKind::OmittedUntranslated));
    }

    #[test]
    fn flags_translations_that_split_a_single_block() {
        // 原文一段，译文把它拆成两段——块数量不一致。
        let content = "原文一段。";
        let mut translations = HashMap::new();
        translations.insert(0, "First paragraph.\n\nSecond paragraph.".to_string());

        let issues = check_translation(content, &translations);

        let mismatched: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::StructureMismatch)
            .collect();
        assert_eq!(
            mismatched.len(),
            1,
            "expected one structure-mismatch issue, got {issues:?}"
        );
        assert_eq!(mismatched[0].run, 0);
        // 已翻译（且与原文不同），不应被同时报为前几类。
        assert!(issues.iter().all(|i| !matches!(
            i.kind,
            IssueKind::MarksLost | IssueKind::EchoOfSource | IssueKind::OmittedUntranslated
        )));
    }

    #[test]
    fn flags_translations_that_rewrite_fenced_code_contents() {
        // 围栏代码块里的代码被「翻译」了——产物不可运行。
        let content = "```\nlet x = 1;\n```\n";
        let mut translations = HashMap::new();
        translations.insert(0, "```\nset x to 1;\n```".to_string());

        let issues = check_translation(content, &translations);

        let invaded: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::CodeInvaded)
            .collect();
        assert_eq!(
            invaded.len(),
            1,
            "expected one code-invaded issue, got {issues:?}"
        );
        assert_eq!(invaded[0].run, 0);
        // 译文与原文不同，且块结构不变，不应被同时报为其他几类。
        assert!(issues.iter().all(|i| !matches!(
            i.kind,
            IssueKind::OmittedUntranslated
                | IssueKind::EchoOfSource
                | IssueKind::MarksLost
                | IssueKind::StructureMismatch
        )));
    }
}