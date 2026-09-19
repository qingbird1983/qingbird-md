//! Deterministic checks over a translation result.
//!
//! These checks answer questions the collected-unit index space already makes
//! it cheap to answer — "which unit has no translation", "did the marker set
//! survive", "did the block count change", "did code/TeX get rewritten" —
//! without paying for an AI round trip. AI-driven semantic review (see
//! `docs/superpowers/plans/2026-09-16-translation-correctness.md` §七) is
//! a separate concern layered on top of whatever these checks surface.
//!
//! **索引空间（P0-2 / BUG-2）**：`translations` 的 key 有两套——`translation`
//! 模式是 `data-ri` run 空间，`bilingual` 模式是 `data-bi` 块空间（与
//! `translate_document` 的收集共用同一条 walk）。检查必须按 `mode` 在**同一
//! 空间**里收集单元再对号，绝不能拿顶层块下标查表。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::markdown::model::{parse_blocks, Block, Inline};
use crate::markdown::units::{collect_translatable, collect_text_runs};
use crate::translate::engine::TargetLang;

/// One finding from `check_translation`. Mirrored by the frontend as
/// `src/lib/checkTranslation.ts`; keep both shapes in lockstep.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    /// 索引在**当前模式的键空间**里，与 `translations` 的 key 同一空间：
    /// `translation` 模式 = `data-ri` run 空间，`bilingual` 模式 = `data-bi`
    /// 块空间。前端跳转先试 `data-ri` 再回退 `data-bi`（`reviewJump.ts`）。
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

/// Run every deterministic check over `content` against `translations`.
///
/// `mode` 决定单元在哪个索引空间收集——必须与产出 `translations` 的那轮翻译
/// 同模式、同方向：
/// - `"translation"`：`data-ri` run 空间（`units::collect_text_runs`）；
/// - `"bilingual"`：`data-bi` 块空间（`units::collect_translatable`）；
/// - 其他值按 `export_translation` 的兜底口径走 run 空间，不 panic。
///
/// 两条收集器与 `translate_document` 走同一条 walk（递归 Quote/List/Table/
/// FootnoteDef），所以嵌套块里的单元同样被核查；方向未知 tag 一律回落
/// `Zh`（与 `TargetLang::from_tag` 的口径一致）。每条 issue 指向它关注的
/// 单元（`run` = 该模式键空间里的索引），调用方决定怎么渲染。
pub fn check_translation(
    content: &str,
    translations: &HashMap<usize, String>,
    mode: &str,
    target_lang: &str,
) -> Vec<Issue> {
    let blocks = parse_blocks(content);
    let target = TargetLang::from_tag(target_lang);
    let units: Vec<(usize, String)> = match mode {
        "bilingual" => collect_translatable(&blocks, target),
        _ => collect_text_runs(&blocks, target),
    };

    let mut issues = Vec::new();

    for (idx, src) in units {
        match translations.get(&idx) {
            None => issues.push(Issue {
                run: idx,
                kind: IssueKind::OmittedUntranslated,
                severity: Severity::Warning,
                src_excerpt: src,
                dst_excerpt: String::new(),
                src_line: 0,
                dst_line: 0,
            }),
            Some(dst) if dst == &src => issues.push(Issue {
                run: idx,
                kind: IssueKind::EchoOfSource,
                severity: Severity::Warning,
                src_excerpt: src,
                dst_excerpt: dst.clone(),
                src_line: 0,
                dst_line: 0,
            }),
            Some(dst) => {
                if let Some(issue) = check_marks_lost(&src, dst, idx) {
                    issues.push(issue);
                }
                if let Some(issue) = check_structure(&src, dst, idx) {
                    issues.push(issue);
                }
                if let Some(issue) = check_code_invaded(&src, dst, idx) {
                    issues.push(issue);
                }
            }
        }
    }

    issues
}

/// Inline code markers lost between source and translation. Re-parses both
/// sides so the comparison is against parsed tokens, not raw bytes. 收集器
/// 给出的单元本来就是纯文本（标记留在 html/块结构层，不进译文表），所以
/// 常规输入下这条不会触发；保留它是作为兜底——单元文本里真出现 Markdown
/// 标记字面量（如成对反引号）而被译文丢掉时仍然报。
fn check_marks_lost(src_text: &str, dst_text: &str, run: usize) -> Option<Issue> {
    let src_codes = count_inline_codes_in_text(src_text);
    let dst_codes = count_inline_codes_in_text(dst_text);

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

fn count_inline_codes_in_text(text: &str) -> usize {
    parse_blocks(text).iter().map(count_inline_codes).sum()
}

/// Per-unit block-count check. A single source unit must translate to a
/// single target block; splitting, merging, or dropping within a unit breaks
/// the unit-aligned indexing that bilingual export and inline patch both
/// depend on.
fn check_structure(src_text: &str, dst_text: &str, run: usize) -> Option<Issue> {
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
/// translator must copy the source verbatim inside the fence. 收集器从不出
/// 代码块单元（代码不参与翻译），所以常规输入下这条不会触发；保留它是为
/// 了守住 IssueKind 契约（前端镜像五种 kind），并在单元文本真含围栏时兜底。
fn check_code_invaded(src_text: &str, dst_text: &str, run: usize) -> Option<Issue> {
    let src_blocks = parse_blocks(src_text);
    let src_code = match src_blocks.first() {
        Some(Block::Code { code, .. }) => code,
        _ => return None,
    };
    let dst_blocks = parse_blocks(dst_text);
    let dst_code = match dst_blocks.first() {
        Some(Block::Code { code, .. }) => code,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::units::{collect_text_runs, collect_translatable};
    use crate::translate::engine::TargetLang;

    #[test]
    fn flags_runs_with_no_translation_entry() {
        // 文档两段，translations 表只覆盖第 0 段；第 1 段必须被报漏译。
        // 反向（→en）才收纯中文单元，方向必须与产出译文表那轮一致。
        let content = "第一段原文。\n\n第二段原文。";
        let mut translations = HashMap::new();
        translations.insert(0, "First paragraph translation.".to_string());

        let issues = check_translation(content, &translations, "translation", "en");

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

        let issues = check_translation(content, &translations, "translation", "en");

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
        // 收集器给出的单元是纯文本（反引号留在结构层），所以这条直接钉
        // `check_marks_lost` 的比较契约，而非经 check_translation 构造。
        let lost = check_marks_lost("使用 `foo` 函数。", "Use the foo function.", 0);

        let issue = lost.expect("dropped inline code markers must be flagged");
        assert_eq!(issue.run, 0);
        assert_eq!(issue.kind, IssueKind::MarksLost);
        // 译文保留了标记则不报。
        assert!(check_marks_lost("使用 `foo` 函数。", "Use the `foo` function.", 0).is_none());
    }

    #[test]
    fn flags_translations_that_split_a_single_block() {
        // 原文一段，译文把它拆成两段——块数量不一致。
        let content = "原文一段。";
        let mut translations = HashMap::new();
        translations.insert(0, "First paragraph.\n\nSecond paragraph.".to_string());

        let issues = check_translation(content, &translations, "translation", "en");

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
        // 围栏代码块里的代码被「翻译」了——产物不可运行。收集器从不出代码
        // 块单元（代码不参与翻译），这里直接钉 `check_code_invaded` 的契约。
        let invaded = check_code_invaded(
            "```\nlet x = 1;\n```",
            "```\nset x to 1;\n```",
            0,
        );

        let issue = invaded.expect("rewritten fenced code must be flagged");
        assert_eq!(issue.run, 0);
        assert_eq!(issue.kind, IssueKind::CodeInvaded);
        // 逐字保留则不报。
        assert!(check_code_invaded("```\nlet x = 1;\n```", "```\nlet x = 1;\n```", 0).is_none());
    }

    // ---- P0-2 / BUG-2 端到端守卫：行内格式 + 嵌套列表 + 表格 ----
    //
    // 译文表与生产管线（translate_document）同源：由**真实收集器**按模式在
    // 对应索引空间（translation = data-ri run 空间 / bilingual = data-bi 块
    // 空间）构建。BUG-2 里 check_translation 拿**顶层块** enumerate 下标去查
    // 这张表：下面这份文档顶层只有 3 块，而嵌套在列表/表格里的可译单元有
    // 8+ 个——旧实现既查错空间（假问题），又看不到嵌套单元（漏报）。
    // 两条守卫在修复前必红。

    /// 行内格式 + 嵌套列表 + 表格的样例文档。
    const GUARD_DOC: &str = concat!(
        "Alpha **bold** and `code` tail\n\n",
        "- Top one\n  - Nested deep\n- Top two\n\n",
        "| H1 | H2 |\n|----|----|\n| a1 | b1 |\n",
    );

    #[test]
    fn guard_translation_mode_run_space_with_inline_nested_and_table() {
        let blocks = parse_blocks(GUARD_DOC);
        let runs = collect_text_runs(&blocks, TargetLang::Zh);
        // 译文表：除最后一个 run 全部有译文；第 2 个 run（"bold"，行内格式
        // 内的文本）故意回声原文。漏掉的那个 run 是表格最后一格——只有
        // 递归进 Table 才看得到。
        let echo_run = runs[1].0;
        let last_run = runs.last().expect("guard doc must collect runs").0;
        let mut translations: HashMap<usize, String> = HashMap::new();
        for (idx, src) in &runs {
            if *idx == last_run {
                continue;
            }
            let dst = if *idx == echo_run {
                src.clone()
            } else {
                format!("译<{}>", src.trim())
            };
            translations.insert(*idx, dst);
        }

        let issues = check_translation(GUARD_DOC, &translations, "translation", "zh");

        let omitted: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::OmittedUntranslated)
            .collect();
        assert_eq!(
            omitted.len(),
            1,
            "exactly one omitted run (the last table cell), got {issues:?}"
        );
        assert_eq!(omitted[0].run, last_run);
        assert_eq!(omitted[0].src_excerpt, "b1", "表格最后一格 b1 被漏译");

        let echo: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::EchoOfSource)
            .collect();
        assert_eq!(
            echo.len(),
            1,
            "exactly one echo run (the bold run), got {issues:?}"
        );
        assert_eq!(echo[0].run, echo_run);
        assert_eq!(echo[0].src_excerpt, "bold");

        // 除这两条外不得有其他问题——尤其不得因索引错位产生假 MarksLost。
        assert_eq!(issues.len(), 2, "unexpected extra issues: {issues:?}");
    }

    #[test]
    fn guard_bilingual_mode_block_space_with_inline_nested_and_table() {
        let blocks = parse_blocks(GUARD_DOC);
        let units = collect_translatable(&blocks, TargetLang::Zh);
        // data-bi 空间：1 段 + 3 个列表项段 + 4 个表格单元 = 8 块。
        assert_eq!(units.len(), 8, "unexpected block sequence: {units:?}");
        // 译文表：除最后一块（表格最后一格 b1）全部有译文；第 2 块（列表项
        // "Top one"）故意回声原文。
        let echo_bi = units[1].0;
        let last_bi = units.last().expect("guard doc must collect units").0;
        let mut translations: HashMap<usize, String> = HashMap::new();
        for (idx, src) in &units {
            if *idx == last_bi {
                continue;
            }
            let dst = if *idx == echo_bi {
                src.clone()
            } else {
                format!("译<{}>", src)
            };
            translations.insert(*idx, dst);
        }

        let issues = check_translation(GUARD_DOC, &translations, "bilingual", "zh");

        let omitted: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::OmittedUntranslated)
            .collect();
        assert_eq!(
            omitted.len(),
            1,
            "exactly one omitted block (the last table cell), got {issues:?}"
        );
        assert_eq!(omitted[0].run, last_bi);
        assert_eq!(omitted[0].src_excerpt, "b1", "表格最后一格 b1 被漏译");

        let echo: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == IssueKind::EchoOfSource)
            .collect();
        assert_eq!(
            echo.len(),
            1,
            "exactly one echo block (the first list item), got {issues:?}"
        );
        assert_eq!(echo[0].run, echo_bi);
        assert_eq!(echo[0].src_excerpt, "Top one");

        // 除这两条外不得有其他问题。
        assert_eq!(issues.len(), 2, "unexpected extra issues: {issues:?}");
    }
}
