use super::model::{Block, Inline};
use crate::translate::engine::{needs_translation, TargetLang};
use crate::translate::skip::RefSkipState;

/// Concatenated plain text of an inline run.
pub fn inline_plain_text(inlines: &[Inline]) -> String {
    let mut s = String::new();
    for il in inlines {
        match il {
            Inline::Text(t) => s.push_str(t),
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) | Inline::Mark(x) => {
                s.push_str(&inline_plain_text(x))
            }
            Inline::Code(c) => s.push_str(c),
            Inline::Link { text, .. } => s.push_str(&inline_plain_text(text)),
            Inline::Image { alt, .. } => s.push_str(alt),
            Inline::LineBreak => s.push(' '),
            Inline::FootnoteRef(_) => {} // 编号引用不进翻译 plain text
            Inline::Math(_) => {}        // LaTeX 不进翻译 plain text
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

/// 单块可译判定：喂 skip 状态机 + needs_translation。
///
/// **这是「块空间（`data-bi`）」的唯一判定点**。四个调用方——本文件的
/// `walk_run_collect_blocks` / `walk_collect`、`html.rs::Ctx::bi_advance`、
/// `cmark.rs`（译文另存为 writer）——都必须走它，否则占号与收集会错位 →
/// 译文贴错块。方向参数必须是**同一个值**（不要一边传 Zh 一边传 En）。
///
/// `target` 是本块翻译方向；`st` 的喂入顺序与方向无关（skip 只看标题层级
/// 与文本，不看方向），所以只把 `target` 交给 `needs_translation`。
pub(crate) fn block_translatable(
    st: &mut RefSkipState,
    heading: Option<u8>,
    plain: &str,
    target: TargetLang,
) -> bool {
    let blocked = st.feed(heading.map(|l| (l, plain)));
    needs_translation(plain, target) && !blocked
}

/// 单个 run（`Inline::Text`）是否**有译文**。
///
/// 与 `block_translatable` 的区别：这个只决定"这个 run 收不收集"，**不决定
/// run 索引空间**——run 计数恒推进（每个 `Inline::Text` 都占号，见
/// `collect_runs_inline_blocks` 与 `html.rs::push_inlines` 的 `sub_counter += 1`）。
/// 所以本函数改动只影响译文表的**内容**，不会让编号漂移。
///
/// 「占号与收集逐位一致」的另一半在这里：`cmark.rs`（译文另存为）的取译文
/// 分支必须与收集侧同口径——收集时用本函数过滤，导出时只认「表里有就替换」，
/// 两者共同保证同一个 run 号在两边指同一段文本。
pub(crate) fn run_collectable(t: &str, target: TargetLang) -> bool {
    !t.trim().is_empty() && needs_translation(t, target)
}

/// Collect translatable inline text *runs* in document order (full document).
pub fn collect_text_runs(blocks: &[Block], target: TargetLang) -> Vec<(usize, String)> {
    collect_text_runs_windowed(blocks, None, target)
}

/// 窗口化 run 收集：只收集所属块（data-bi 空间）在窗口内的 run；
/// run 自身索引仍按全文推进（data-ri 空间全局），窗口外/不可译块的 run
/// 占号不收集（与 html.rs push_inlines 的恒占号一致）。
pub fn collect_text_runs_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
    target: TargetLang,
) -> Vec<(usize, String)> {
    collect_text_runs_windowed_blocks(blocks, window, target).0
}

/// 与 collect_text_runs_windowed 相同，但额外返回每个收集 run 所属的块索引
/// （data-bi 空间），两数组等长、一一对应。前端据此把 run 组装成整段打字单元。
pub fn collect_text_runs_windowed_blocks(
    blocks: &[Block],
    window: Option<(usize, usize)>,
    target: TargetLang,
) -> (Vec<(usize, String)>, Vec<usize>) {
    let mut counter = 0usize;
    let mut bi = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    let mut blocks_out = Vec::new();
    walk_run_collect_blocks(
        blocks,
        &mut counter,
        &mut bi,
        &mut st,
        window,
        &mut out,
        &mut blocks_out,
        target,
    );
    (out, blocks_out)
}


fn walk_run_collect_blocks(
    blocks: &[Block],
    counter: &mut usize,
    bi: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
    blocks_out: &mut Vec<usize>,
    target: TargetLang,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, Some(*level), &plain, target);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline_blocks(text, counter, out, blocks_out, b_idx, in_window(b_idx, window), target);
                } else {
                    collect_runs_inline_blocks(text, counter, out, blocks_out, *bi, false, target);
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, None, &plain, target);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline_blocks(text, counter, out, blocks_out, b_idx, in_window(b_idx, window), target);
                } else {
                    collect_runs_inline_blocks(text, counter, out, blocks_out, *bi, false, target);
                }
            }
            Block::Quote { blocks } => walk_run_collect_blocks(blocks, counter, bi, st, window, out, blocks_out, target),
            Block::List { items, .. } => {
                for it in items {
                    walk_run_collect_blocks(&it.blocks, counter, bi, st, window, out, blocks_out, target);
                }
            }
            Block::Table { headers, rows, .. } => {
                for h in headers {
                    let plain = inline_plain_text(h);
                    let trans = block_translatable(st, None, &plain, target);
                    if trans {
                        let b_idx = *bi;
                        *bi += 1;
                        collect_runs_inline_blocks(h, counter, out, blocks_out, b_idx, in_window(b_idx, window), target);
                    } else {
                        collect_runs_inline_blocks(h, counter, out, blocks_out, *bi, false, target);
                    }
                }
                for row in rows {
                    for cell in row {
                        let plain = inline_plain_text(cell);
                        let trans = block_translatable(st, None, &plain, target);
                        if trans {
                            let b_idx = *bi;
                            *bi += 1;
                            collect_runs_inline_blocks(cell, counter, out, blocks_out, b_idx, in_window(b_idx, window), target);
                        } else {
                            collect_runs_inline_blocks(cell, counter, out, blocks_out, *bi, false, target);
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            // 脚注定义的内容照常参与 bi/run 占号（渲染时移到文末但 walk
            // 顺序不变，索引与 html.rs 渲染保持逐位一致）
            Block::FootnoteDef { blocks, .. } => {
                walk_run_collect_blocks(blocks, counter, bi, st, window, out, blocks_out, target)
            }
            _ => {}
        }
    }
}

/// `collect` = false 时仍推进 run 计数（恒占号）但不收集（_blocks 变体同时记录块号）。
///
/// `target` 只影响「是否收集」这**一个**布尔；run 计数恒推进（与
/// `html.rs::push_inlines` 的 `sub_counter += 1` 对齐）。所以方向即使改了，
/// run 索引空间也不会漂——漂的只可能是"哪些 run 有译文"。
fn collect_runs_inline_blocks(
    inlines: &[Inline],
    counter: &mut usize,
    out: &mut Vec<(usize, String)>,
    blocks_out: &mut Vec<usize>,
    b_idx: usize,
    collect: bool,
    target: TargetLang,
) {
    for il in inlines {
        match il {
            Inline::Text(t) => {
                let idx = *counter;
                *counter += 1;
                if collect && run_collectable(t, target) {
                    out.push((idx, t.clone()));
                    blocks_out.push(b_idx);
                }
            }
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) | Inline::Mark(x) => {
                collect_runs_inline_blocks(x, counter, out, blocks_out, b_idx, collect, target)
            }
            Inline::Link { text, .. } => collect_runs_inline_blocks(text, counter, out, blocks_out, b_idx, collect, target),
            Inline::Math(_) => {}
            Inline::FootnoteRef(_) => {} // 编号引用不占 run 号
            _ => {}
        }
    }
}


/// Collect translatable text units in document order (full document).
pub fn collect_translatable(blocks: &[Block], target: TargetLang) -> Vec<(usize, String)> {
    collect_translatable_windowed(blocks, None, target)
}

/// 窗口化块收集：只收集块索引 ∈ 窗口的单元（索引空间 = data-bi）。
pub fn collect_translatable_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
    target: TargetLang,
) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    walk_collect(blocks, &mut counter, &mut st, window, &mut out, target);
    out
}

fn walk_collect(
    blocks: &[Block],
    counter: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
    target: TargetLang,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, Some(*level), &plain, target) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, None, &plain, target) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Quote { blocks } => walk_collect(blocks, counter, st, window, out, target),
            Block::List { items, .. } => {
                for it in items {
                    walk_collect(&it.blocks, counter, st, window, out, target);
                }
            }
            Block::Table { headers, rows, .. } => {
                for h in headers {
                    let p = inline_plain_text(h);
                    if block_translatable(st, None, &p, target) {
                        if in_window(*counter, window) {
                            out.push((*counter, p.clone()));
                        }
                        *counter += 1;
                    }
                }
                for row in rows {
                    for cell in row {
                        let p = inline_plain_text(cell);
                        if block_translatable(st, None, &p, target) {
                            if in_window(*counter, window) {
                                out.push((*counter, p.clone()));
                            }
                            *counter += 1;
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            Block::FootnoteDef { blocks, .. } => walk_collect(blocks, counter, st, window, out, target),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{parse_blocks};

    /// 本模块测试默认译成中文（= Step 0 的生产行为）。
    const ZH: TargetLang = TargetLang::Zh;
    /// 反向。用于"同一份文档两个方向必须给出不同单元集合"的守卫。
    const EN: TargetLang = TargetLang::En;

    #[test]
    fn collect_runs_indexes_all_texts() {
        // Parity with the egui renderer: every non-empty run with ASCII
        // letters is collected, CJK-only runs are not.
        let blocks = parse_blocks("Hi\n\n中文 skip");
        let runs = collect_text_runs(&blocks, ZH);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], (0, "Hi".into()));
        assert_eq!(runs[1], (1, "中文 skip".into()));
    }

    #[test]
    fn collect_translatable_uses_block_plain_text() {
        let blocks = parse_blocks("# Eng title\n\n## 中文标题");
        let u = collect_translatable(&blocks, ZH);
        assert_eq!(u.len(), 1);          // 中文标题被 needs_translation 跳过
        assert_eq!(u[0].1, "Eng title");  // inline 前缀不带 "# "
    }

    #[test]
    fn windowed_translatable_filters_by_block_index() {
        let blocks = parse_blocks("One\n\nTwo\n\nThree\n\nFour\n\nFive");
        let all = collect_translatable(&blocks, ZH);
        assert_eq!(all.len(), 5);
        let w = collect_translatable_windowed(&blocks, Some((1, 3)), ZH);
        assert_eq!(w, vec![(1usize, "Two".into()), (2usize, "Three".into())]);
        assert_eq!(collect_translatable_windowed(&blocks, Some((4, 99)), ZH).len(), 1);
    }

    #[test]
    fn windowed_runs_filter_by_owning_block() {
        // 两段各两个 run；窗口只含第二段 → 只收集第二段的 run，
        // 但 run 索引保持全局（第二段首 run = 2）。
        let blocks = parse_blocks("Alpha**beta**\n\nGamma**delta**");
        let w = collect_text_runs_windowed(&blocks, Some((1, 2)), ZH);
        assert_eq!(w, vec![(2usize, "Gamma".into()), (3usize, "delta".into())]);
    }

    #[test]
    fn reference_section_skipped_in_collectors() {
        let blocks = parse_blocks(
            "# Intro\n\n## References\n\n**Smith** 2020.\n\n## Acknowledgements\n\nThanks to all.",
        );
        let u = collect_translatable(&blocks, ZH);
        assert_eq!(
            u,
            vec![
                (0usize, "Intro".into()),
                (1usize, "Acknowledgements".into()),
                (2usize, "Thanks to all.".into()),
            ]
        );
        // 区段内 run 不收集，但 run 计数照常推进（References/Smith 2020. 占 run idx 1-3）
        let r = collect_text_runs(&blocks, ZH);
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
        let u = collect_translatable(&blocks, ZH);
        assert_eq!(u, vec![(0usize, "Result text".into())]);
    }

    // ---- 语法全覆盖测试.md 补齐项（2026-09-11）----

    #[test]
    fn footnote_def_blocks_participate_in_bi() {
        // 定义内容照常占 bi 号（渲染时搬运到文末但 walk 顺序不变）
        let blocks = parse_blocks("Hello[^1]\n\n[^1]: The Eng note");
        let u = collect_translatable(&blocks, ZH);
        assert_eq!(
            u,
            vec![(0usize, "Hello".into()), (1usize, "The Eng note".into())]
        );
    }

    #[test]
    fn mark_children_recursed_in_runs() {
        // Mark 内的 Text 照常占 run 号（与 html.rs push_inlines 递归一致）
        let blocks = parse_blocks("==Eng one== Eng two");
        let r = collect_text_runs(&blocks, ZH);
        assert_eq!(
            r,
            vec![(0usize, "Eng one".into()), (1usize, " Eng two".into())]
        );
    }

    #[test]
    fn footnote_ref_occupies_no_run() {
        // FootnoteRef 是编号引用，不占 run 号；定义内容照常占号
        let blocks = parse_blocks("See[^1] this\n\n[^1]: x");
        let r = collect_text_runs(&blocks, ZH);
        assert_eq!(
            r,
            vec![(0usize, "See".into()), (1usize, " this".into()), (2usize, "x".into())]
        );
    }

    // ---- H1：方向参数化（2026-09-16 Step 0）----

    #[test]
    fn zh_to_en_collects_chinese_blocks_that_zh_direction_skips() {
        // 改前最严重的那条：`needs_translation` 方向无关（"含 ASCII 字母才需译"），
        // 于是 **zh→en 时纯中文段被整段静默跳过**，译出来是空的。
        let blocks = parse_blocks("这是纯中文\n\nHello world");
        assert_eq!(
            collect_translatable(&blocks, EN),
            vec![(0usize, "这是纯中文".into())],
            "反向只收中文块"
        );
        assert_eq!(
            collect_translatable(&blocks, ZH),
            vec![(0usize, "Hello world".into())],
            "正向只收英文块"
        );
    }

    #[test]
    fn run_index_space_stays_global_regardless_of_direction() {
        // run 空间（data-ri）**方向无关**：Text 恒占号，方向只决定"收不收集"。
        // 这条是防"顺手把方向也塞进 run 计数"的守卫。
        let blocks = parse_blocks("这是纯中文\n\nHello world");
        let zh = collect_text_runs(&blocks, ZH);
        let en = collect_text_runs(&blocks, EN);
        // 被收集的文案不同（方向决定），但 **run 号是同一套**：中文块占 0，英文块占 1
        assert_eq!(zh, vec![(1usize, "Hello world".into())]);
        assert_eq!(en, vec![(0usize, "这是纯中文".into())]);
    }

    #[test]
    fn block_index_space_is_direction_dependent() {
        // 块空间（data-bi）**方向相关**：只有可译块才推进 bi。
        // 所以「切方向必须重置显示态」这条红线在单测层面就成立。
        let blocks = parse_blocks("纯中文段\n\nHello world\n\n又一段中文");
        assert_eq!(
            collect_translatable(&blocks, ZH),
            vec![(0usize, "Hello world".into())]
        );
        assert_eq!(
            collect_translatable(&blocks, EN),
            vec![(0usize, "纯中文段".into()), (1usize, "又一段中文".into())]
        );
    }
}
