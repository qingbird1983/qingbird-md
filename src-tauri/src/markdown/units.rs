use super::model::{Block, Inline};
use crate::translate::engine::needs_translation;
use crate::translate::skip::RefSkipState;

/// Concatenated plain text of an inline run.
pub fn inline_plain_text(inlines: &[Inline]) -> String {
    let mut s = String::new();
    for il in inlines {
        match il {
            Inline::Text(t) => s.push_str(t),
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) => s.push_str(&inline_plain_text(x)),
            Inline::Code(c) => s.push_str(c),
            Inline::Link { text, .. } => s.push_str(&inline_plain_text(text)),
            Inline::Image { alt, .. } => s.push_str(alt),
            Inline::LineBreak => s.push(' '),
            Inline::Math(_) => {} // LaTeX 不进翻译 plain text
            Inline::DisplayMath(_) => {}
        }
    }
    s
}

/// 窗口过滤：None = 全文；Some((top, end)) = 块索引 ∈ [top, end)。
fn in_window(i: usize, window: Option<(usize, usize)>) -> bool {
    match window {
        None => true,
        Some((top, end)) => i >= top && i < end,
    }
}

/// 单块可译判定：喂 skip 状态机 + needs_translation。三处（html.rs / 两 walker）
/// 共用同一逻辑，保证占号与收集逐位一致。
fn block_translatable(st: &mut RefSkipState, heading: Option<u8>, plain: &str) -> bool {
    let blocked = st.feed(heading.map(|l| (l, plain)));
    needs_translation(plain) && !blocked
}

/// Collect translatable inline text *runs* in document order (full document).
pub fn collect_text_runs(blocks: &[Block]) -> Vec<(usize, String)> {
    collect_text_runs_windowed(blocks, None)
}

/// 窗口化 run 收集：只收集所属块（data-bi 空间）在窗口内的 run；
/// run 自身索引仍按全文推进（data-ri 空间全局），窗口外/不可译块的 run
/// 占号不收集（与 html.rs push_inlines 的恒占号一致）。
pub fn collect_text_runs_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut bi = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    walk_run_collect(blocks, &mut counter, &mut bi, &mut st, window, &mut out);
    out
}

fn walk_run_collect(
    blocks: &[Block],
    counter: &mut usize,
    bi: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, Some(*level), &plain);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline(text, counter, out, in_window(b_idx, window));
                } else {
                    collect_runs_inline(text, counter, out, false);
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, None, &plain);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline(text, counter, out, in_window(b_idx, window));
                } else {
                    collect_runs_inline(text, counter, out, false);
                }
            }
            Block::Quote { blocks } => walk_run_collect(blocks, counter, bi, st, window, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_run_collect(&it.blocks, counter, bi, st, window, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    let plain = inline_plain_text(h);
                    let trans = block_translatable(st, None, &plain);
                    if trans {
                        let b_idx = *bi;
                        *bi += 1;
                        collect_runs_inline(h, counter, out, in_window(b_idx, window));
                    } else {
                        collect_runs_inline(h, counter, out, false);
                    }
                }
                for row in rows {
                    for cell in row {
                        let plain = inline_plain_text(cell);
                        let trans = block_translatable(st, None, &plain);
                        if trans {
                            let b_idx = *bi;
                            *bi += 1;
                            collect_runs_inline(cell, counter, out, in_window(b_idx, window));
                        } else {
                            collect_runs_inline(cell, counter, out, false);
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}

/// `collect` = false 时仍推进 run 计数（恒占号）但不收集。
fn collect_runs_inline(
    inlines: &[Inline],
    counter: &mut usize,
    out: &mut Vec<(usize, String)>,
    collect: bool,
) {
    for il in inlines {
        match il {
            Inline::Text(t) => {
                let idx = *counter;
                *counter += 1;
                if collect && !t.trim().is_empty() && needs_translation(t) {
                    out.push((idx, t.clone()));
                }
            }
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) => {
                collect_runs_inline(x, counter, out, collect)
            }
            Inline::Link { text, .. } => collect_runs_inline(text, counter, out, collect),
            Inline::Math(_) => {}
            _ => {}
        }
    }
}

/// Collect translatable text units in document order (full document).
pub fn collect_translatable(blocks: &[Block]) -> Vec<(usize, String)> {
    collect_translatable_windowed(blocks, None)
}

/// 窗口化块收集：只收集块索引 ∈ 窗口的单元（索引空间 = data-bi）。
pub fn collect_translatable_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    walk_collect(blocks, &mut counter, &mut st, window, &mut out);
    out
}

fn walk_collect(
    blocks: &[Block],
    counter: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, Some(*level), &plain) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, None, &plain) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Quote { blocks } => walk_collect(blocks, counter, st, window, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_collect(&it.blocks, counter, st, window, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    let p = inline_plain_text(h);
                    if block_translatable(st, None, &p) {
                        if in_window(*counter, window) {
                            out.push((*counter, p.clone()));
                        }
                        *counter += 1;
                    }
                }
                for row in rows {
                    for cell in row {
                        let p = inline_plain_text(cell);
                        if block_translatable(st, None, &p) {
                            if in_window(*counter, window) {
                                out.push((*counter, p.clone()));
                            }
                            *counter += 1;
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{parse_blocks};

    #[test]
    fn collect_runs_indexes_all_texts() {
        // Parity with the egui renderer: every non-empty run with ASCII
        // letters is collected, CJK-only runs are not.
        let blocks = parse_blocks("Hi\n\n中文 skip");
        let runs = collect_text_runs(&blocks);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], (0, "Hi".into()));
        assert_eq!(runs[1], (1, "中文 skip".into()));
    }

    #[test]
    fn collect_translatable_uses_block_plain_text() {
        let blocks = parse_blocks("# Eng title\n\n## 中文标题");
        let u = collect_translatable(&blocks);
        assert_eq!(u.len(), 1);          // 中文标题被 needs_translation 跳过
        assert_eq!(u[0].1, "Eng title");  // inline 前缀不带 "# "
    }

    #[test]
    fn windowed_translatable_filters_by_block_index() {
        let blocks = parse_blocks("One\n\nTwo\n\nThree\n\nFour\n\nFive");
        let all = collect_translatable(&blocks);
        assert_eq!(all.len(), 5);
        let w = collect_translatable_windowed(&blocks, Some((1, 3)));
        assert_eq!(w, vec![(1usize, "Two".into()), (2usize, "Three".into())]);
        assert_eq!(collect_translatable_windowed(&blocks, Some((4, 99))).len(), 1);
    }

    #[test]
    fn windowed_runs_filter_by_owning_block() {
        // 两段各两个 run；窗口只含第二段 → 只收集第二段的 run，
        // 但 run 索引保持全局（第二段首 run = 2）。
        let blocks = parse_blocks("Alpha**beta**\n\nGamma**delta**");
        let w = collect_text_runs_windowed(&blocks, Some((1, 2)));
        assert_eq!(w, vec![(2usize, "Gamma".into()), (3usize, "delta".into())]);
    }

    #[test]
    fn reference_section_skipped_in_collectors() {
        let blocks = parse_blocks(
            "# Intro\n\n## References\n\n**Smith** 2020.\n\n## Acknowledgements\n\nThanks to all.",
        );
        let u = collect_translatable(&blocks);
        assert_eq!(
            u,
            vec![
                (0usize, "Intro".into()),
                (1usize, "Acknowledgements".into()),
                (2usize, "Thanks to all.".into()),
            ]
        );
        // 区段内 run 不收集，但 run 计数照常推进（References/Smith 2020. 占 run idx 1-3）
        let r = collect_text_runs(&blocks);
        assert_eq!(
            r,
            vec![
                (0usize, "Intro".into()),
                (4usize, "Acknowledgements".into()),
                (5usize, "Thanks to all.".into()),
            ]
        );
    }

    #[test]
    fn chinese_only_blocks_still_feed_skip_state() {
        // 纯中文块在区段内/外都不收集，但不影响后续复位判定
        let blocks = parse_blocks("## References\n\n纯中文\n\n## 结论\n\nResult text");
        let u = collect_translatable(&blocks);
        assert_eq!(u, vec![(0usize, "Result text".into())]);
    }
}
