//! Pure, egui-free Markdown document model.
//!
//! `parse_blocks` turns Markdown into a `Vec<Block>` so the renderer (Phase 1)
//! and the translation engine (Phase 2) can both walk the same model. This
//! module has no egui dependency and is fully unit-testable.

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

/// An inline run inside a block. `Strong`/`Emph`/`Del`/`Link` may nest.
#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Strong(Vec<Inline>),
    Emph(Vec<Inline>),
    Del(Vec<Inline>),
    Code(String),
    Link { text: Vec<Inline>, href: String },
    Image { alt: String, src: String },
    LineBreak,
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
    Table { headers: Vec<Vec<Inline>>, rows: Vec<Vec<Vec<Inline>>> },
}

/// Parse Markdown into a list of top-level block elements.
pub fn parse_blocks(md: &str) -> Vec<Block> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_STRIKETHROUGH);

    let parser = Parser::new_ext(md, opts);
    let mut it = parser;
    let mut blocks = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::Start(tag) => blocks.push(consume_block(&tag, &mut it)),
            Event::End(_) => {}
            Event::Rule => blocks.push(Block::Rule),
            Event::SoftBreak
            | Event::HardBreak
            | Event::Html(_)
            | Event::InlineHtml(_)
            | Event::FootnoteReference(_)
            | Event::InlineMath(_)
            | Event::DisplayMath(_)
            | Event::TaskListMarker(_)
            | Event::Text(_)
            | Event::Code(_) => {
                // stray inline content at block level: ignore for phase 1
            }
        }
    }
    blocks
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
        Tag::Table(_) => consume_table(it),
        _ => Block::Paragraph { text: Vec::new() },
    }
}

fn paragraph_block(text: Vec<Inline>) -> Block {
    if text.len() == 1 {
        if let Inline::Image { alt, src } = &text[0] {
            return Block::Image { alt: alt.clone(), src: src.clone() };
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

/// Collect nested inlines until the next `Event::End` (the caller's container).
fn collect_inlines<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> Vec<Inline> {
    let mut out = Vec::new();
    while let Some(ev) = it.next() {
        match ev {
            Event::End(_) => break,
            Event::Text(t) => out.push(Inline::Text(t.into_string())),
            Event::Code(c) => out.push(Inline::Code(c.into_string())),
            Event::SoftBreak | Event::HardBreak => out.push(Inline::LineBreak),
            Event::Start(Tag::Strong) => out.push(Inline::Strong(collect_inlines(it))),
            Event::Start(Tag::Emphasis) => out.push(Inline::Emph(collect_inlines(it))),
            Event::Start(Tag::Strikethrough) => out.push(Inline::Del(collect_inlines(it))),
            Event::Start(Tag::Link { dest_url, .. }) => {
                let text = collect_inlines(it);
                out.push(Inline::Link { text, href: dest_url.into_string() });
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                let alt = collect_raw_text(it);
                out.push(Inline::Image { alt, src: dest_url.into_string() });
            }
            _ => {}
        }
    }
    out
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
    while let Some(ev) = it.next() {
        match ev {
            Event::End(TagEnd::Item) => break,
            Event::TaskListMarker(checked) => task = Some(checked),
            Event::Start(tag) => blocks.push(consume_block(&tag, it)),
            Event::Rule => blocks.push(Block::Rule),
            _ => {}
        }
    }
    ListItem { task, blocks }
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
    Block::Table { headers, rows }
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
    fn parses_table() {
        let blocks = parse_blocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
        assert!(matches!(
            &blocks[0],
            Block::Table { headers, rows }
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
}
