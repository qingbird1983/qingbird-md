//! 解析入口与块级 walker：parse_blocks 事件主循环、consume_block 块级消费、
//! 列表/表格/紧凑项收集，以及 SEC-5 深度上限与 options 唯一出处。

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::inlines::{collect_inlines, collect_raw_text, fold_marks, push_inline};
use super::types::{Block, Inline, ListItem};

/// 嵌套深度上限（SEC-5）。块级互递归（Quote/List/FootnoteDef 经
/// `consume_block` ↔ `collect_blocks`/`collect_items`）与行级互递归
/// （Strong/Em/Del/Link 经 `collect_inlines` ↔ `push_inline`）共用此常量：
/// 递归每深入一层容器加一，超限的整棵子树降级为纯文本。恶意文件
/// （如 `>` × 10 万）曾把解析线程直接爆栈——栈溢出是 abort，panic
/// 配置接不住，只能在上游封顶。下游 units/html 对模型的递归深度
/// 随模型有界，因此也一并安全。
pub(super) const MAX_NESTING_DEPTH: usize = 256;

/// 解析开关的唯一出处——`parse_blocks` 与 [`top_level_block_lines`] 必须同源，
/// 否则两者的顶层事件序列会分叉，源行锚点与块一一对应的前提就没了。
/// `cmark::front_matter` 也用它，理由同上：换个开关可能让文首那三行
/// `---` 从 MetadataBlock 变成别的结构，切出来的 front matter 就错了。
pub(crate) fn options() -> Options {
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
    opts
}

/// Parse Markdown into a list of top-level block elements.
pub fn parse_blocks(md: &str) -> Vec<Block> {
    let parser = Parser::new_ext(md, options());
    let mut it = parser;
    let mut blocks = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            // front matter 元数据不进正文模型（阅读器/翻译器都不消费），
            // 整块跳过——元数据行里的 Text 事件随之丢弃。此分支必须排在
            // Start(tag) 兜底之前，否则落入 consume_block 变成空段落。
            Event::Start(Tag::MetadataBlock(_)) => skip_metadata(&mut it),
            Event::Start(tag) => blocks.push(consume_block(&tag, &mut it, 1)),
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
///
/// `depth` 是本块的容器嵌套深度（顶层为 1）；超过 [`MAX_NESTING_DEPTH`]
/// 时不再递归建块，整棵子树压成一个纯文本段落（SEC-5，防恶意文件爆栈）。
fn consume_block<'a>(tag: &Tag<'a>, it: &mut impl Iterator<Item = Event<'a>>, depth: usize) -> Block {
    if depth > MAX_NESTING_DEPTH {
        // 降级路径：collect_raw_text 迭代收文本（自身无递归），并消费掉
        // 本块自己的 End——与正常路径的边界语义一致。
        return Block::Paragraph { text: vec![Inline::Text(collect_raw_text(it))] };
    }
    match tag {
        Tag::Paragraph => paragraph_block(collect_inlines(it, 1)),
        Tag::Heading { level, .. } => {
            let text = collect_inlines(it, 1);
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
            let blocks = collect_blocks(it, |e| matches!(e, TagEnd::BlockQuote(_)), depth + 1);
            Block::Quote { blocks }
        }
        Tag::List(start) => {
            let ordered = start.is_some();
            let start = start.unwrap_or(1) as u32;
            let items = collect_items(it, depth + 1);
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
            blocks: collect_blocks(it, |e| matches!(e, TagEnd::FootnoteDefinition), depth + 1),
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

fn collect_blocks<'a>(
    it: &mut impl Iterator<Item = Event<'a>>,
    end: impl Fn(&TagEnd) -> bool,
    depth: usize,
) -> Vec<Block> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(e) => {
                if end(&e) {
                    break;
                }
            }
            Event::Start(tag) => out.push(consume_block(&tag, it, depth)),
            Event::Rule => out.push(Block::Rule),
            _ => {}
        }
    }
    out
}

fn collect_items<'a>(it: &mut impl Iterator<Item = Event<'a>>, depth: usize) -> Vec<ListItem> {
    let mut items = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(Tag::Item) => items.push(collect_item(it, depth)),
            Event::End(TagEnd::List(_)) => break,
            _ => {}
        }
    }
    items
}

fn collect_item<'a>(it: &mut impl Iterator<Item = Event<'a>>, depth: usize) -> ListItem {
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
                blocks.push(consume_block(&tag, it, depth));
            }
            Event::Start(tag) => {
                push_inline(&mut stray, Event::Start(tag), it, 1);
            }
            Event::Rule => {
                flush_stray(&mut stray, &mut blocks);
                blocks.push(Block::Rule);
            }
            ev => {
                if !push_inline(&mut stray, ev, it, 1) {
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
            Event::Start(Tag::TableCell) => cells.push(collect_inlines(it, 1)),
            Event::End(e) if e == end => break,
            _ => {}
        }
    }
    cells
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
    fn table_alignment_captured() {
        let blocks = parse_blocks("| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |");
        assert!(matches!(&blocks[0], Block::Table { aligns, .. }
            if aligns.as_slice() == [0u8, 1, 2]));
    }

    // ---- SEC-5 嵌套深度上限（2026-09-20）----

    /// 模型树的最大块嵌套深度（Quote/List/FootnoteDef 各算一层；仅测试用）。
    /// 空切片为 0，叶子块为 1。
    fn block_depth(blocks: &[Block]) -> usize {
        let mut max = 0usize;
        for b in blocks {
            let d = match b {
                Block::Quote { blocks } | Block::FootnoteDef { blocks, .. } => 1 + block_depth(blocks),
                Block::List { items, .. } => items
                    .iter()
                    .map(|it| 1 + block_depth(&it.blocks))
                    .max()
                    .unwrap_or(1),
                _ => 1,
            };
            max = max.max(d);
        }
        max
    }

    /// 修复前：5 万层引用让解析线程直接爆栈 abort（独立探针实测，栈溢出
    /// 不受 panic 配置影响）。修复后：解析正常返回，模型深度被
    /// MAX_NESTING_DEPTH 封顶，超限内容以纯文本段落出现且文本不丢。
    #[test]
    fn deep_quote_50k_parses_without_crash_and_degrades_to_plain_text() {
        let md = "> ".repeat(50_000) + "deep tail";
        let blocks = parse_blocks(&md);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], Block::Quote { .. }));
        let depth = block_depth(&blocks);
        assert!(
            depth <= MAX_NESTING_DEPTH + 1,
            "模型块深度必须封顶于 {}: {depth}",
            MAX_NESTING_DEPTH + 1
        );
        // 沿最左链走到最深处：应为降级的纯文本段落，原文内容保留
        let mut cur = &blocks[0];
        while let Block::Quote { blocks } = cur {
            assert!(!blocks.is_empty(), "降级前不得出现空引用层");
            cur = &blocks[0];
        }
        match cur {
            Block::Paragraph { text } => assert!(
                text.iter().any(|i| matches!(i, Inline::Text(t) if t.contains("deep tail"))),
                "超限内容必须按纯文本保留: {text:?}"
            ),
            other => panic!("引用链最深处应为降级纯文本段落: {other:?}"),
        }
    }

    /// 列表路径（collect_items → collect_item → consume_block）同样封顶：
    /// 300 层缩进列表超限降级；50 层以内的正常嵌套结构不受影响。
    #[test]
    fn deep_list_degrades_but_shallow_nesting_stays_structured() {
        let mut deep = String::new();
        for i in 0..300 {
            deep.push_str(&" ".repeat(2 * i));
            deep.push_str("- item\n");
        }
        let blocks = parse_blocks(&deep);
        assert!(matches!(&blocks[0], Block::List { .. }));
        assert!(
            block_depth(&blocks) <= MAX_NESTING_DEPTH + 1,
            "列表模型深度必须封顶"
        );

        let mut shallow = String::new();
        for i in 0..50 {
            shallow.push_str(&" ".repeat(2 * i));
            shallow.push_str("- x\n");
        }
        // 50 层列表 + 最内层 item 的段落叶子 = 51；远低于上限，结构完整
        assert_eq!(block_depth(&parse_blocks(&shallow)), 51, "正常浅嵌套不得受封顶影响");
    }
}
