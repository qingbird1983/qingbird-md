//! Pure, egui-free Markdown document model.
//!
//! `parse_blocks` turns Markdown into a `Vec<Block>` so the renderer (Phase 1)
//! and the translation engine (Phase 2) can both walk the same model. This
//! module has no egui dependency and is fully unit-testable.

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::units::inline_plain_text;

/// An inline run inside a block. `Strong`/`Emph`/`Del`/`Mark`/`Link` may nest.
#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Strong(Vec<Inline>),
    Emph(Vec<Inline>),
    Del(Vec<Inline>),
    /// `==高亮==`（GFM 扩展，pulldown 无原生支持——由 fold_marks 后处理折出）
    Mark(Vec<Inline>),
    Code(String),
    Link { text: Vec<Inline>, href: String },
    Image { alt: String, src: String },
    LineBreak,
    /// `[^label]` 脚注引用（渲染为上标编号，编号对应文末 FootnoteDef）
    FootnoteRef(String),
    Math(String),
    /// pulldown 0.13 把 DisplayMath 也包在 Paragraph 里 emit（实测探针），
    /// 单独成段时由 paragraph_block 升级为 Block::Math{display:true}；
    /// 夹在行文中间时保持行内 span 渲染。
    DisplayMath(String),
}

/// One item in a list, with optional task-list marker.
#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    pub task: Option<bool>,
    pub blocks: Vec<Block>,
}

/// A block-level element.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u8, text: Vec<Inline> },
    Paragraph { text: Vec<Inline> },
    Code { lang: Option<String>, code: String },
    Quote { blocks: Vec<Block> },
    List { ordered: bool, start: u32, items: Vec<ListItem> },
    Rule,
    Image { alt: String, src: String },
    /// aligns 与 headers 同长：0=default/left、1=center、2=right
    /// （GFM 分隔行 `:---:` / `---:`，pulldown Table tag 携带）。
    Table {
        headers: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
        aligns: Vec<u8>,
    },
    Math { display: bool, tex: String },
    /// `[^label]: 定义正文`（渲染时统一移到文末脚注区，编号与 FootnoteRef 对应）
    FootnoteDef { label: String, blocks: Vec<Block> },
}

/// Parse Markdown into a list of top-level block elements.
pub fn parse_blocks(md: &str) -> Vec<Block> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    // 计划 Task 1 假设 0.13 默认 emit InlineMath/DisplayMath——实测需要此开关，
    // 否则 $...$ / $$...$$ 停留为字面 Text，math 相关测试无法通过。
    opts.insert(Options::ENABLE_MATH);
    // 脚注 `[^label]` 引用/定义（无此开关则停留为字面文本）。
    opts.insert(Options::ENABLE_FOOTNOTES);
    // 文首 YAML front matter（无此开关时 `---` 成伪 Rule/伪 Setext H2，
    // title/description 等元数据行渲染成乱段落）。
    opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);

    let parser = Parser::new_ext(md, opts);
    let mut it = parser;
    let mut blocks = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            // front matter 元数据不进正文模型（阅读器/翻译器都不消费），
            // 整块跳过——元数据行里的 Text 事件随之丢弃。此分支必须排在
            // Start(tag) 兜底之前，否则落入 consume_block 变成空段落。
            Event::Start(Tag::MetadataBlock(_)) => skip_metadata(&mut it),
            Event::Start(tag) => blocks.push(consume_block(&tag, &mut it)),
            Event::End(_) => {}
            Event::Rule => blocks.push(Block::Rule),
            Event::DisplayMath(tex) => blocks.push(Block::Math {
                display: true,
                tex: tex.into_string(),
            }),
            Event::SoftBreak
            | Event::HardBreak
            | Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::InlineMath(_)
            | Event::TaskListMarker(_)
            | Event::Text(_)
            | Event::Code(_) => {
                // stray inline content at block level: ignore for phase 1
            }
        }
    }
    blocks
}

/// Consume events until the matching metadata block `End`.
fn skip_metadata<'a>(it: &mut impl Iterator<Item = Event<'a>>) {
    for ev in it {
        if let Event::End(TagEnd::MetadataBlock(_)) = ev {
            break;
        }
    }
}

/// Consume the children of a block `tag` (already emitted as `Event::Start`)
/// until its matching `Event::End`, returning the `Block`.
fn consume_block<'a>(tag: &Tag<'a>, it: &mut impl Iterator<Item = Event<'a>>) -> Block {
    match tag {
        Tag::Paragraph => paragraph_block(collect_inlines(it)),
        Tag::Heading { level, .. } => {
            let text = collect_inlines(it);
            Block::Heading { level: *level as u8, text }
        }
        Tag::CodeBlock(kind) => {
            let code = collect_code(it);
            let lang = match kind {
                CodeBlockKind::Fenced(info) => first_token(info),
                CodeBlockKind::Indented => None,
            };
            Block::Code { lang, code }
        }
        Tag::BlockQuote(_) => {
            let blocks = collect_blocks(it, |e| matches!(e, TagEnd::BlockQuote(_)));
            Block::Quote { blocks }
        }
        Tag::List(start) => {
            let ordered = start.is_some();
            let start = start.unwrap_or(1) as u32;
            let items = collect_items(it);
            Block::List { ordered, start, items }
        }
        Tag::Table(aligns) => {
            let mut b = consume_table(it);
            if let Block::Table { aligns: a, .. } = &mut b {
                *a = aligns
                    .iter()
                    .map(|al| match al {
                        pulldown_cmark::Alignment::Center => 1u8,
                        pulldown_cmark::Alignment::Right => 2u8,
                        _ => 0u8,
                    })
                    .collect();
            }
            b
        }
        Tag::FootnoteDefinition(label) => Block::FootnoteDef {
            label: label.to_string(),
            blocks: collect_blocks(it, |e| matches!(e, TagEnd::FootnoteDefinition)),
        },
        _ => Block::Paragraph { text: Vec::new() },
    }
}

fn paragraph_block(text: Vec<Inline>) -> Block {
    // 紧凑列表项的 stray 缓冲不经过 collect_inlines，这里兜底折高亮；
    // 对已折叠的入参幂等（标记字符在首折时已消费）。
    let mut text = text;
    fold_marks(&mut text);
    if text.len() == 1 {
        match &text[0] {
            Inline::Image { alt, src } => {
                return Block::Image { alt: alt.clone(), src: src.clone() };
            }
            Inline::DisplayMath(tex) => {
                // $$...$$ 独立成段（pulldown 实测总是 Paragraph 包裹）
                return Block::Math { display: true, tex: tex.clone() };
            }
            _ => {}
        }
    }
    Block::Paragraph { text }
}

/// Fold `==高亮==` markers across adjacent Text nodes into `Inline::Mark`.
/// pulldown 0.13 没有高亮扩展，`==` 停留在 Text 里；这里按 micromark-mark
/// 的侧翼规则识别：开标记右侧不得紧跟空白，闭标记左侧不得是空白，长 `===`
/// 连跑与 `a == b`（两侧空白）保持字面。容器内未闭合时原样退回（自愈）。
/// 对已折叠的输入幂等。返回前已递归处理嵌套容器。
fn fold_marks(inlines: &mut Vec<Inline>) {
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

/// The first whitespace-delimited token of a fenced code info string.
fn first_token(info: &str) -> Option<String> {
    info.split_whitespace().next().map(|s| s.to_string())
}

/// Collect the raw text of a fenced/indented code block (until its `End`).
fn collect_code<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> String {
    let mut s = String::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(TagEnd::CodeBlock) => break,
            Event::Text(t) | Event::Code(t) => s.push_str(&t),
            Event::SoftBreak | Event::HardBreak => s.push('\n'),
            _ => {}
        }
    }
    s
}

/// Collect nested inlines until the next `Event::End` (the caller's container).
fn collect_inlines<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> Vec<Inline> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        if !push_inline(&mut out, ev, it) {
            break;
        }
    }
    fold_marks(&mut out);
    out
}

/// Fold one inline-ish event into `out`, consuming nested events from `it`
/// for containers. Returns false only when `ev` is an `End` — the caller's
/// container boundary, which the caller owns.
fn push_inline<'a>(
    out: &mut Vec<Inline>,
    ev: Event<'a>,
    it: &mut impl Iterator<Item = Event<'a>>,
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
            out.push(Inline::Strong(collect_inlines(it)));
            true
        }
        Event::Start(Tag::Emphasis) => {
            out.push(Inline::Emph(collect_inlines(it)));
            true
        }
        Event::Start(Tag::Strikethrough) => {
            out.push(Inline::Del(collect_inlines(it)));
            true
        }
        Event::FootnoteReference(name) => {
            out.push(Inline::FootnoteRef(name.into_string()));
            true
        }
        Event::Start(Tag::Link { dest_url, .. }) => {
            let text = collect_inlines(it);
            out.push(Inline::Link { text, href: dest_url.into_string() });
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

fn collect_blocks<'a>(
    it: &mut impl Iterator<Item = Event<'a>>,
    end: impl Fn(&TagEnd) -> bool,
) -> Vec<Block> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(e) => {
                if end(&e) {
                    break;
                }
            }
            Event::Start(tag) => out.push(consume_block(&tag, it)),
            Event::Rule => out.push(Block::Rule),
            _ => {}
        }
    }
    out
}

fn collect_items<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> Vec<ListItem> {
    let mut items = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(Tag::Item) => items.push(collect_item(it)),
            Event::End(TagEnd::List(_)) => break,
            _ => {}
        }
    }
    items
}

fn collect_item<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> ListItem {
    let mut task = None;
    let mut blocks = Vec::new();
    // Tight lists (no blank line between items) carry item content as bare
    // inline events WITHOUT a Paragraph wrapper. Buffer those strays and
    // flush them as an implicit paragraph at each block boundary — dropping
    // them rendered empty <li> bullets (README 功能 list regression).
    let mut stray: Vec<Inline> = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(TagEnd::Item) => break,
            Event::TaskListMarker(checked) => task = Some(checked),
            // Block-level tags own their subtree via consume_block; the rest
            // (Strong/Emphasis/Strikethrough/Link/Image/…) are inline starts
            // and belong to the stray buffer.
            Event::Start(tag)
                if matches!(
                    &tag,
                    Tag::Paragraph
                        | Tag::Heading { .. }
                        | Tag::CodeBlock(_)
                        | Tag::BlockQuote(_)
                        | Tag::List(_)
                        | Tag::Table(_)
                ) =>
            {
                flush_stray(&mut stray, &mut blocks);
                blocks.push(consume_block(&tag, it));
            }
            Event::Start(tag) => {
                push_inline(&mut stray, Event::Start(tag), it);
            }
            Event::Rule => {
                flush_stray(&mut stray, &mut blocks);
                blocks.push(Block::Rule);
            }
            ev => {
                if !push_inline(&mut stray, ev, it) {
                    break;
                }
            }
        }
    }
    flush_stray(&mut stray, &mut blocks);
    ListItem { task, blocks }
}

/// Emit buffered tight-item inlines as an implicit paragraph block.
fn flush_stray(stray: &mut Vec<Inline>, blocks: &mut Vec<Block>) {
    if !stray.is_empty() {
        let text = std::mem::take(stray);
        blocks.push(paragraph_block(text));
    }
}

fn consume_table<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> Block {
    let mut headers = Vec::new();
    let mut rows = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            // The header row emits TableCells directly under TableHead (no
            // TableRow wrapper), unlike body rows.
            Event::Start(Tag::TableHead) => headers = collect_cells(it, TagEnd::TableHead),
            Event::Start(Tag::TableRow) => rows.push(collect_cells(it, TagEnd::TableRow)),
            Event::End(TagEnd::Table) => break,
            _ => {}
        }
    }
    // aligns 由 consume_block 从 Table tag 填充（此处拿不到）。
    Block::Table { headers, rows, aligns: Vec::new() }
}

fn collect_cells<'a>(it: &mut impl Iterator<Item = Event<'a>>, end: TagEnd) -> Vec<Vec<Inline>> {
    let mut cells = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(Tag::TableCell) => cells.push(collect_inlines(it)),
            Event::End(e) if e == end => break,
            _ => {}
        }
    }
    cells
}

/// Collect only text (used for image alt text); stops at the next `End`.
fn collect_raw_text<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> String {
    let mut s = String::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(_) => break,
            Event::Text(t) => s.push_str(&t),
            Event::SoftBreak | Event::HardBreak => s.push(' '),
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_heading_and_paragraph() {
        let blocks = parse_blocks("# Title\n\nSome **bold** text.");
        assert_eq!(blocks.len(), 2);
        assert!(matches!(
            &blocks[0],
            Block::Heading { level: 1, text }
                if text.iter().any(|i| matches!(i, Inline::Text(t) if t == "Title"))
        ));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { text }
                if text.iter().any(|i| matches!(i, Inline::Strong(inner) if inner.iter().any(
                    |x| matches!(x, Inline::Text(t) if t == "bold")
                )))
        ));
    }

    #[test]
    fn parses_task_list_and_code_fence() {
        let blocks = parse_blocks("- [x] done\n- [ ] todo\n\n```rust\nfn main(){}\n```");
        assert!(matches!(&blocks[0], Block::List { items, .. } if items.len() == 2));
        assert!(matches!(
            &blocks[0],
            Block::List { items, .. }
                if items[0].task == Some(true) && items[1].task == Some(false)
        ));
        assert!(matches!(
            &blocks[1],
            Block::Code { lang, code }
                if lang.as_deref() == Some("rust") && code.contains("fn main")
        ));
    }

    #[test]
    fn tight_list_items_keep_inline_content() {
        // pulldown-cmark tight lists (no blank line between items) emit bare
        // inline events WITHOUT a Paragraph wrapper. Regression: collect_item
        // dropped them, rendering empty <li> bullets (README 功能 list).
        let blocks = parse_blocks("- **加粗**：正文 `code` [链](https://e.com)\n- 纯文本项\n  - 嵌套项");
        let list = match &blocks[0] {
            Block::List { items, .. } => items,
            other => panic!("expected list, got {other:?}"),
        };
        assert_eq!(list.len(), 2);
        assert!(list[0].blocks.iter().any(|b| matches!(
            b,
            Block::Paragraph { text } if text.iter().any(|i| matches!(i, Inline::Strong(_)))
        )));
        assert!(list[0].blocks.iter().any(|b| matches!(
            b,
            Block::Paragraph { text }
                if text.iter().any(|i| matches!(i, Inline::Text(t) if t.contains("正文")))
                    && text.iter().any(|i| matches!(i, Inline::Code(_)))
                    && text.iter().any(|i| matches!(i, Inline::Link { .. }))
        )));
        assert!(list[1].blocks.iter().any(|b| matches!(
            b,
            Block::Paragraph { text } if text.iter().any(|i| matches!(i, Inline::Text(t) if t == "纯文本项"))
        )));
        // Nested list under a tight item must survive, not be swallowed by
        // inline collection.
        assert!(list[1].blocks.iter().any(
            |b| matches!(b, Block::List { items, .. } if items.len() == 1)),
            "nested list under tight item must be kept"
        );
    }

    #[test]
    fn parses_table() {
        let blocks = parse_blocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
        assert!(matches!(
            &blocks[0],
            Block::Table { headers, rows, .. }
                if headers.len() == 2 && headers[0].len() == 1 && rows.len() == 1 && rows[0].len() == 2
        ));
    }

    #[test]
    fn parses_quote_and_link() {
        let blocks = parse_blocks("> quoted\n\nSee [docs](https://example.com).");
        assert!(matches!(&blocks[0], Block::Quote { blocks } if blocks.len() == 1));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { text }
                if text.iter().any(|i| matches!(i, Inline::Link { href, .. } if href == "https://example.com"))
        ));
    }

    #[test]
    fn image_only_paragraph_becomes_image_block() {
        let blocks = parse_blocks("![alt](img/logo.png)");
        assert!(matches!(
            &blocks[0],
            Block::Image { alt, src } if alt == "alt" && src == "img/logo.png"
        ));
    }

    // ---- 语法全覆盖测试.md 补齐项（2026-09-11）----

    #[test]
    fn front_matter_is_dropped() {
        // 无 YAML 开关时文首 `---` 会成伪 Rule/伪 Setext H2 + 乱段落
        let blocks = parse_blocks("---\ntitle: T\nauthor: A\n---\n\nHello world");
        assert_eq!(
            blocks.iter().filter(|b| matches!(b, Block::Paragraph { text }
                if text.iter().any(|i| matches!(i, Inline::Text(t) if t.contains("Hello"))))).count(),
            1,
            "正文段落恰一个: {blocks:?}"
        );
        assert!(
            !blocks.iter().any(|b| matches!(b, Block::Rule | Block::Heading { .. })),
            "front matter 不得泄漏成 Rule/伪标题: {blocks:?}"
        );
        // 文中后置的独立 `---` 不受影响，仍是 Rule
        let blocks = parse_blocks("---\ntitle: T\n---\n\nA\n\n---\n\nB");
        assert!(matches!(blocks[1], Block::Rule), "正文中的 --- 仍是分割线: {blocks:?}");
    }

    #[test]
    fn footnote_ref_and_def_parsed() {
        let blocks = parse_blocks("See[^a] note.\n\n[^a]: The definition.");
        assert!(matches!(&blocks[0], Block::Paragraph { text }
            if text.iter().any(|i| matches!(i, Inline::FootnoteRef(l) if l == "a"))));
        assert!(matches!(&blocks[1], Block::FootnoteDef { label, .. } if label == "a"));
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

    #[test]
    fn table_alignment_captured() {
        let blocks = parse_blocks("| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
        assert!(matches!(&blocks[0], Block::Table { aligns, .. }
            if aligns.as_slice() == [0u8, 1, 2]));
    }
}
