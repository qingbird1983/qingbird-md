//! 行级 walker：行内容器收集/嵌套行内构造/`==高亮==` 折叠与裸文本收集；
//! 行级互递归（collect_inlines ↔ push_inline）的 SEC-5 封顶在 nested_inline。

use pulldown_cmark::{Event, Tag};

use super::parse::MAX_NESTING_DEPTH;
use super::types::Inline;
use crate::markdown::units::inline_plain_text;

/// Fold `==高亮==` markers across adjacent Text nodes into `Inline::Mark`.
/// pulldown 0.13 没有高亮扩展，`==` 停留在 Text 里；这里按 micromark-mark
/// 的侧翼规则识别：开标记右侧不得紧跟空白，闭标记左侧不得是空白，长 `===`
/// 连跑与 `a == b`（两侧空白）保持字面。容器内未闭合时原样退回（自愈）。
/// 对已折叠的输入幂等。返回前已递归处理嵌套容器。
pub(super) fn fold_marks(inlines: &mut Vec<Inline>) {
    for il in inlines.iter_mut() {
        match il {
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) | Inline::Mark(x) => fold_marks(x),
            Inline::Link { text, .. } => fold_marks(text),
            _ => {}
        }
    }

    let mut out: Vec<Inline> = Vec::with_capacity(inlines.len());
    let mut buf: Vec<Inline> = Vec::new(); // 开标记之后、闭标记之前的内容
    let mut open = false;
    let mut last_char: Option<char> = None; // 闭标记左侧翼判定（跨 Text 节点）
    for il in std::mem::take(inlines) {
        match il {
            Inline::Text(t) => {
                let mut rest = t.as_str();
                let mut lit = String::new(); // 标记之间的字面累积（含标记前缀）
                while !rest.is_empty() {
                    match rest.find("==") {
                        Some(p) => {
                            // 标记前的文本先落进 lit（丢了就是内容丢失！）
                            lit.push_str(&rest[..p]);
                            rest = &rest[p..];
                            let run = rest.bytes().take_while(|&b| b == b'=').count();
                            if run != 2 {
                                // `===` 及更长连跑：整体字面
                                lit.push_str(&rest[..run]);
                                rest = &rest[run..];
                                continue;
                            }
                            let before = lit.chars().next_back().or(last_char);
                            let after = rest[2..].chars().next();
                            let can_open = !open
                                // 右翼：after 为 None（紧贴节点边界，如 `==**b**==`）视同非空白
                                && !matches!(after, Some(c) if c.is_whitespace())
                                && before != Some('=');
                            let can_close =
                                open && !matches!(before, Some(c) if c.is_whitespace());
                            if can_open || can_close {
                                // 翼判定用掉 lit 的尾字符，然后落账字面
                                if !lit.is_empty() {
                                    update_last(&mut last_char, &lit);
                                    if open {
                                        buf.push(Inline::Text(std::mem::take(&mut lit)));
                                    } else {
                                        out.push(Inline::Text(std::mem::take(&mut lit)));
                                    }
                                }
                                rest = &rest[2..];
                                if can_open {
                                    open = true;
                                } else {
                                    open = false;
                                    if !buf.is_empty() {
                                        out.push(Inline::Mark(std::mem::take(&mut buf)));
                                    }
                                }
                            } else {
                                lit.push_str("==");
                                rest = &rest[2..];
                            }
                        }
                        None => {
                            lit.push_str(rest);
                            rest = "";
                        }
                    }
                }
                if !lit.is_empty() {
                    update_last(&mut last_char, &lit);
                    if open {
                        buf.push(Inline::Text(lit));
                    } else {
                        out.push(Inline::Text(lit));
                    }
                }
            }
            other => {
                // 非文本节点：按当前状态归位；last_char 取其尾字符（闭标记翼判定）
                let tail = inline_plain_text(std::slice::from_ref(&other))
                    .chars()
                    .next_back();
                if open {
                    buf.push(other);
                } else {
                    out.push(other);
                }
                if tail.is_some() {
                    last_char = tail;
                }
            }
        }
    }
    // 未闭合：消耗掉的 "==" 与缓冲内容按原顺序退回（自愈），Text 尽量合并，
    // 避免把原单个 run 劈裂导致 data-ri 空间漂移。
    if open {
        match out.last_mut() {
            Some(Inline::Text(prev)) => prev.push_str("=="),
            _ => out.push(Inline::Text("==".into())),
        }
        let mut first = true;
        for item in buf {
            let mut item = item;
            if first {
                first = false;
                if let (Inline::Text(t), Some(Inline::Text(prev))) = (&mut item, out.last_mut()) {
                    prev.push_str(t);
                    continue;
                }
            }
            out.push(item);
        }
    }
    *inlines = out;
}

fn update_last(last_char: &mut Option<char>, lit: &str) {
    if let Some(c) = lit.chars().next_back() {
        *last_char = Some(c);
    }
}

/// Collect nested inlines until the next `Event::End` (the caller's container).
///
/// `depth` 是行内容器嵌套深度（段落/单元格内第一层为 1）。
pub(super) fn collect_inlines<'a>(
    it: &mut impl Iterator<Item = Event<'a>>,
    depth: usize,
) -> Vec<Inline> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        if !push_inline(&mut out, ev, it, depth) {
            break;
        }
    }
    fold_marks(&mut out);
    out
}

/// A nested inline container at `depth`: recursed normally below the cap,
/// degraded to plain text at/after it (SEC-5 — `****…` 恶意深嵌套爆栈).
/// 降级必须发生在构造容器**之前**，否则降级文本仍被包一层伪容器。
/// Both branches consume the container's own `End`.
fn nested_inline<'a>(
    it: &mut impl Iterator<Item = Event<'a>>,
    depth: usize,
    wrap: impl FnOnce(Vec<Inline>) -> Inline,
) -> Inline {
    if depth > MAX_NESTING_DEPTH {
        Inline::Text(collect_raw_text(it))
    } else {
        wrap(collect_inlines(it, depth + 1))
    }
}

/// Fold one inline-ish event into `out`, consuming nested events from `it`
/// for containers. Returns false only when `ev` is an `End` — the caller's
/// container boundary, which the caller owns.
pub(super) fn push_inline<'a>(
    out: &mut Vec<Inline>,
    ev: Event<'a>,
    it: &mut impl Iterator<Item = Event<'a>>,
    depth: usize,
) -> bool {
    match ev {
        Event::End(_) => false,
        Event::Text(t) => {
            out.push(Inline::Text(t.into_string()));
            true
        }
        Event::Code(c) => {
            out.push(Inline::Code(c.into_string()));
            true
        }
        Event::InlineMath(tex) => {
            out.push(Inline::Math(tex.into_string()));
            true
        }
        Event::DisplayMath(tex) => {
            out.push(Inline::DisplayMath(tex.into_string()));
            true
        }
        Event::SoftBreak | Event::HardBreak => {
            out.push(Inline::LineBreak);
            true
        }
        Event::Start(Tag::Strong) => {
            out.push(nested_inline(it, depth, Inline::Strong));
            true
        }
        Event::Start(Tag::Emphasis) => {
            out.push(nested_inline(it, depth, Inline::Emph));
            true
        }
        Event::Start(Tag::Strikethrough) => {
            out.push(nested_inline(it, depth, Inline::Del));
            true
        }
        Event::FootnoteReference(name) => {
            out.push(Inline::FootnoteRef(name.into_string()));
            true
        }
        Event::Start(Tag::Link { dest_url, .. }) => {
            let href = dest_url.into_string();
            out.push(nested_inline(it, depth, |text| Inline::Link { text, href }));
            true
        }
        Event::Start(Tag::Image { dest_url, .. }) => {
            let alt = collect_raw_text(it);
            out.push(Inline::Image { alt, src: dest_url.into_string() });
            true
        }
        _ => true,
    }
}

/// Collect only text (used for image alt text).
///
/// 嵌套深度计数照 pulldown 自带 `raw_text` 的口径：`Start` 加一，`End` 只在
/// 深度为 0（即 Image 自己的收尾）时 break。提前 break 会把 `End(Image)`
/// 留在流里，上层 `collect_inlines` 把它当容器边界，同段后续文本被静默吞掉
/// （BUG-7）。`Code` 计入 alt。
pub(super) fn collect_raw_text<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> String {
    let mut s = String::new();
    let mut nest = 0usize;
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(_) => nest += 1,
            Event::End(_) if nest == 0 => break,
            Event::End(_) => nest -= 1,
            Event::Text(t) => s.push_str(&t),
            Event::Code(c) => s.push_str(&c),
            Event::SoftBreak | Event::HardBreak => s.push(' '),
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::model::{parse_blocks, Block};

    /// BUG-7 回归：alt 含嵌套行内标签（`![**b**](x)` 的 Strong）时，
    /// alt 解析必须消费到 Image 自己的 `End`——提前 break 会把 `End(Image)`
    /// 留在流里，上层 `collect_inlines` 把它当段落边界，同段后续文本被
    /// 静默吞掉。
    #[test]
    fn image_alt_with_nested_inline_does_not_swallow_trailing_text() {
        let blocks = parse_blocks("![**b**](x) tail after image");
        assert_eq!(blocks.len(), 1);
        assert!(
            matches!(
                &blocks[0],
                Block::Paragraph { text }
                    if matches!(
                        text.as_slice(),
                        [Inline::Image { alt, .. }, Inline::Text(t)]
                            if alt == "b" && t == " tail after image"
                    )
            ),
            "alt 含嵌套行内时不得吞掉同段后续文本: {blocks:?}"
        );
    }

    /// BUG-7 附带：`Event::Code` 计入 alt（照 pulldown raw_text 的口径）。
    /// 纯图片段落会升级为 `Block::Image`（见
    /// `image_only_paragraph_becomes_image_block`），alt 从这里断言。
    #[test]
    fn image_alt_includes_code_spans() {
        let blocks = parse_blocks("![a `code` span](x)");
        assert!(
            matches!(&blocks[0], Block::Image { alt, .. } if alt == "a code span"),
            "alt 必须计入 Code: {blocks:?}"
        );
    }

    #[test]
    fn mark_folding_basic_and_boundaries() {
        // 基本折叠
        let b = parse_blocks("==hi==");
        assert!(matches!(&b[0], Block::Paragraph { text }
            if matches!(text.as_slice(), [Inline::Mark(inner)]
                if matches!(inner.as_slice(), [Inline::Text(t)] if t == "hi"))));
        // `a == b`（两侧空白）保持字面
        let b = parse_blocks("a == b");
        assert!(matches!(&b[0], Block::Paragraph { text }
            if matches!(text.as_slice(), [Inline::Text(t)] if t == "a == b")));
        // 未闭合自愈：原样退回且 run 不劈裂
        let b = parse_blocks("x==a");
        assert!(matches!(&b[0], Block::Paragraph { text }
            if matches!(text.as_slice(), [Inline::Text(t)] if t == "x==a")));
        // `====` 长连跑保持字面
        let b = parse_blocks("a ==== b");
        assert!(matches!(&b[0], Block::Paragraph { text }
            if !text.iter().any(|i| matches!(i, Inline::Mark(_)))));
        // 跨节点：==**加粗**== → Mark 包 Strong
        let b = parse_blocks("==**b**==");
        assert!(matches!(&b[0], Block::Paragraph { text }
            if matches!(text.as_slice(), [Inline::Mark(inner)]
                if inner.iter().any(|i| matches!(i, Inline::Strong(_))))));
    }

    /// 行内嵌套深度（Strong/Em/Del/Mark/Link 各算一层；仅测试用）。
    fn inline_depth(inlines: &[Inline]) -> usize {
        let mut max = 0usize;
        for il in inlines {
            let d = match il {
                Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) | Inline::Mark(x) => {
                    1 + inline_depth(x)
                }
                Inline::Link { text, .. } => 1 + inline_depth(text),
                _ => 0,
            };
            max = max.max(d);
        }
        max
    }

    /// 行级互递归（collect_inlines ↔ push_inline）同样封顶：修复前 2 万层
    /// 嵌套强调爆栈（探针 stage c），修复后正常返回且深度封顶、文本不丢。
    #[test]
    fn deep_emphasis_20k_levels_degrades_to_plain_text() {
        let md = "*".repeat(40_000) + "deep tail" + &"*".repeat(40_000);
        let blocks = parse_blocks(&md);
        assert_eq!(blocks.len(), 1);
        let text = match &blocks[0] {
            Block::Paragraph { text } => text,
            other => panic!("应为段落: {other:?}"),
        };
        let depth = inline_depth(text);
        assert!(
            depth <= MAX_NESTING_DEPTH,
            "行内深度必须封顶于 {MAX_NESTING_DEPTH}: {depth}"
        );
        assert!(
            inline_plain_text(text).contains("deep tail"),
            "超限行内内容必须保留为纯文本"
        );
    }
}
