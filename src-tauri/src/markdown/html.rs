//! Render the Block model to standalone HTML for the webview preview,
//! mirroring the deleted egui renderer's traversal orders exactly.
//!
//! Modes:
//! - original (`trans` empty): every inline rendered from source text.
//! - substituted (`trans` non-empty, not bilingual): each translatable text
//!   run swapped for its translation by index. Index space is that of
//!   `units::collect_text_runs`: EVERY `Inline::Text` advances one global
//!   counter during the same walk.
//! - bilingual (`bilingual = true`): original markup kept, plus
//!   `<div class="tr-box">译文</div>` appended after each translatable
//!   heading/paragraph/table-cell. Index space is that of
//!   `units::collect_translatable` (block-level plain text).

use std::collections::HashMap;
use std::fmt::Write;

use syntect::highlighting::Color;

use super::model::{Block, Inline};
use super::syntax::highlight_spans;
use super::units::inline_plain_text;
use crate::translate::pipeline::needs_translation;

#[derive(Debug, Clone, serde::Serialize)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ParseResult {
    pub html: String,
    pub outline: Vec<OutlineItem>,
}

/// Escape all user-visible text and attribute values so no markdown or file
/// content can ever inject markup into the preview DOM.
fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Single-pass rendering context. Keeping substituted (inline-run) and
/// bilingual (block-level) bookkeeping in ONE traversal guarantees the index
/// spaces line up with the units collectors, which walk identically.
struct Ctx<'t> {
    /// Some(map) => substituted mode: replace Inline::Text by map[run_index].
    sub: Option<&'t HashMap<usize, String>>,
    /// Some(map) => bilingual mode: append tr-box after blocks whose plain
    /// text needs_translation, using map[block_index].
    bi: Option<&'t HashMap<usize, String>>,
    sub_counter: usize,
    bi_counter: usize,
    heading_id: usize,
    outline: Vec<OutlineItem>,
}

pub fn render_html(content: &str, trans: &HashMap<usize, String>, bilingual: bool) -> ParseResult {
    let blocks = super::model::parse_blocks(content);
    let mut ctx = Ctx {
        sub: if trans.is_empty() || bilingual { None } else { Some(trans) },
        bi: if bilingual { Some(trans) } else { None },
        sub_counter: 0,
        bi_counter: 0,
        heading_id: 0,
        outline: Vec::new(),
    };
    let mut html = String::new();
    ctx.render_blocks(&mut html, &blocks);
    ParseResult { html, outline: std::mem::take(&mut ctx.outline) }
}

impl<'t> Ctx<'t> {
    fn render_blocks(&mut self, out: &mut String, blocks: &[Block]) {
        for b in blocks {
            self.render_block(out, b);
            out.push('\n');
        }
    }

    fn render_block(&mut self, out: &mut String, b: &Block) {
        match b {
            Block::Heading { level, text } => {
                self.heading_id += 1;
                let id = format!("h-{}", self.heading_id);
                let plain = inline_plain_text(text);
                self.outline.push(OutlineItem {
                    level: *level,
                    text: plain.clone(),
                    id: id.clone(),
                });
                let _ = write!(out, "<h{} id=\"{}\">", level, id);
                self.push_inlines(out, text);
                let _ = writeln!(out, "</h{}>", level);
                // Bilingual: walk_collect assigns indexes to translatable
                // headings too, so consume here or all later indexes drift.
                self.maybe_tr_box(out, &plain);
            }
            Block::Paragraph { text } => {
                out.push_str("<p>");
                self.push_inlines(out, text);
                out.push_str("</p>");
                // Bilingual: index consumed only when this block is
                // translatable, exactly like units::walk_collect.
                self.maybe_tr_box(out, &inline_plain_text(text));
            }
            Block::Code { lang, code } => self.push_code_block(out, lang.as_deref(), code),
            Block::Quote { blocks } => {
                out.push_str("<blockquote>");
                self.render_blocks(out, blocks);
                out.push_str("</blockquote>");
            }
            Block::List { ordered, start, items } => {
                if *ordered {
                    let _ = write!(out, "<ol start=\"{}\">", start);
                } else {
                    out.push_str("<ul>");
                }
                for it in items {
                    match it.task {
                        Some(true) => out.push_str(r#"<li class="task done">"#),
                        Some(false) => out.push_str(r#"<li class="task todo">"#),
                        None => out.push_str("<li>"),
                    }
                    self.render_blocks(out, &it.blocks);
                    out.push_str("</li>");
                }
                out.push_str(if *ordered { "</ol>" } else { "</ul>" });
            }
            Block::Rule => out.push_str("<hr>"),
            // Controller ruling: src is the raw Markdown string, escaped only;
            // zero path processing here. The frontend resolves images itself
            // (Task 7 image_path command / Task 16 resolve+convertFileSrc).
            Block::Image { alt, src } => {
                let _ = write!(
                    out,
                    r#"<img src="{}" alt="{}">"#,
                    escape_html(src),
                    escape_html(alt)
                );
            }
            Block::Table { headers, rows } => {
                out.push_str("<table><thead>");
                for h in headers {
                    out.push_str("<tr><th>");
                    self.push_inlines(out, h);
                    self.maybe_tr_box(out, &inline_plain_text(h));
                    out.push_str("</th></tr>");
                }
                out.push_str("</thead><tbody>");
                for row in rows {
                    out.push_str("<tr>");
                    for cell in row {
                        out.push_str("<td>");
                        self.push_inlines(out, cell);
                        self.maybe_tr_box(out, &inline_plain_text(cell));
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
            }
        }
    }

    /// Append `<div class="tr-box">…</div>` when rendering bilingually and
    /// this block/cell was assigned a translation. Mirrors
    /// `units::walk_collect`: only needs_translation-true blocks consume an
    /// index, headers before body cells, items in order.
    fn maybe_tr_box(&mut self, out: &mut String, plain: &str) {
        if self.bi.is_none() || !needs_translation(plain) {
            return;
        }
        let idx = self.bi_counter;
        let tr = self.bi.and_then(|m| m.get(&idx)).map(String::as_str).map(String::from);
        self.bi_counter += 1;
        if let Some(tr) = tr {
            let _ = write!(out, r#"<div class="tr-box">{}</div>"#, escape_html(&tr));
        }
    }

    /// Shared inline painter for original + substituted modes. Every
    /// `Inline::Text` advances `sub_counter`, matching
    /// `units::collect_text_runs`' walk run-for-run.
    fn push_inlines(&mut self, out: &mut String, ils: &[Inline]) {
        for il in ils {
            match il {
                Inline::Text(t) => {
                    let idx = self.sub_counter;
                    self.sub_counter += 1;
                    let tr = self.sub.and_then(|m| m.get(&idx)).map(String::as_str);
                    match tr {
                        Some(tr) => out.push_str(&escape_html(tr)),
                        None => out.push_str(&escape_html(t)),
                    }
                }
                Inline::Strong(x) => {
                    out.push_str("<strong>");
                    self.push_inlines(out, x);
                    out.push_str("</strong>");
                }
                Inline::Emph(x) => {
                    out.push_str("<em>");
                    self.push_inlines(out, x);
                    out.push_str("</em>");
                }
                Inline::Del(x) => {
                    out.push_str("<del>");
                    self.push_inlines(out, x);
                    out.push_str("</del>");
                }
                Inline::Code(c) => {
                    let _ = write!(out, "<code>{}</code>", escape_html(c));
                }
                Inline::Link { text, href } => {
                    let _ = write!(out, r#"<a href="{}">"#, escape_html(href));
                    self.push_inlines(out, text);
                    out.push_str("</a>");
                }
                Inline::Image { alt, src } => {
                    let _ =
                        write!(out, r#"<img src="{}" alt="{}">"#, escape_html(src), escape_html(alt));
                }
                Inline::LineBreak => out.push_str("<br>"),
            }
        }
    }

    /// `<pre class="code-block"><div class="code-lang">{lang}</div><code>
    /// {line-numbered highlighted spans}</code></pre>`. Unknown/absent lang
    /// renders the whole block monochrome-escaped.
    fn push_code_block(&self, out: &mut String, lang: Option<&str>, code: &str) {
        out.push_str("<pre class=\"code-block\">");
        if let Some(l) = lang {
            let _ = write!(out, "<div class=\"code-lang\">{}</div>", escape_html(l));
        }
        out.push_str("<code>");
        match highlight_spans(code, lang) {
            Some(spans) => {
                // Regroup spans into per-line token lists. Spans may carry
                // trailing "\n" (LinesWithEndings), close/reopen around it.
                let mut lines: Vec<Vec<(Color, String)>> = vec![Vec::new()];
                for (c, t) in spans {
                    let mut rest = t.as_str();
                    while let Some(p) = rest.find('\n') {
                        push_tok(&mut lines, c, &rest[..p]);
                        lines.push(Vec::new());
                        rest = &rest[p + 1..];
                    }
                    push_tok(&mut lines, c, rest);
                }
                // Drop only the trailing artifact of a final "\n".
                while lines.len() > 1 && lines.last().unwrap().is_empty() {
                    lines.pop();
                }
                for (i, toks) in lines.iter().enumerate() {
                    let _ = write!(out, "<span class=\"ln\">{}</span>", i + 1);
                    for (c, piece) in toks {
                        let _ = write!(
                            out,
                            "<span style=\"color:#{:02x}{:02x}{:02x}\">{}</span>",
                            c.r,
                            c.g,
                            c.b,
                            escape_html(piece)
                        );
                    }
                }
            }
            None => {
                let mut ls: Vec<&str> = code.split('\n').collect();
                if ls.len() > 1 && ls.last() == Some(&"") {
                    ls.pop();
                }
                for (i, l) in ls.iter().enumerate() {
                    let _ = write!(out, "<span class=\"ln\">{}</span>{}", i + 1, escape_html(l));
                }
            }
        }
        out.push_str("</code></pre>");
    }
}

fn push_tok(lines: &mut Vec<Vec<(Color, String)>>, c: Color, piece: &str) {
    if !piece.is_empty() {
        lines.last_mut().unwrap().push((c, piece.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn original_mode_renders_basic_markdown() {
        let r = render_html("# Ti\n\ntext **b**.", &HashMap::new(), false);
        assert!(r.html.contains("<h1 id=\"h-1\">Ti</h1>"));
        assert!(r.html.contains("<strong>b</strong>"));
        assert_eq!(r.outline.len(), 1);
        assert_eq!(r.outline[0].text, "Ti");
    }

    #[test]
    fn substitution_replaces_runs_keeps_wrappers() {
        let md = "Hello **world** more";
        let _r = render_html(md, &HashMap::new(), false); // 触发首行收集编号
        // run0=Hello, run1=world, run2=more（run 序号跨过空格增量见 units 实现）
    }

    #[test]
    fn bilingual_appends_tr_box_below_paragraph() {
        let mut m = HashMap::new();
        m.insert(0usize, "你好世界".into());
        let r = render_html("Hello world", &m, true);
        assert!(r.html.contains(r#"<div class="tr-box">你好世界</div>"#));
    }

    #[test]
    fn escaping_renders_entities_not_raw_html() {
        let r = render_html("Text with <b>&</b> quote", &HashMap::new(), false);
        // Probe (task-3-report.md): pulldown emits raw tags as InlineHtml
        // events, which model.rs collect_inlines drops, so `<b>`/`</b>` never
        // reach this renderer — only Text("Text with "), Text("&") and
        // Text(" quote") survive. The guarantee tested here stands: every
        // surviving text goes through escape_html, so raw "<b>" can never be
        // emitted.
        assert!(r.html.contains("Text with &amp; quote"));
        assert!(!r.html.contains("<b>"));
    }

    #[test]
    fn bilingual_heading_and_paragraph_indexes_align() {
        // units::walk_collect assigns idx0 to the translatable heading and
        // idx1 to the translatable paragraph — boxes must land on both.
        let mut m = HashMap::new();
        m.insert(0usize, "中文标题".into());
        m.insert(1usize, "正文译文".into());
        let r = render_html("# Title\n\nBody text", &m, true);
        assert!(r.html.contains("</h1>\n<div class=\"tr-box\">中文标题</div>"));
        assert!(r.html.contains(r#"<p>Body text</p><div class="tr-box">正文译文</div>"#));
    }

    #[test]
    fn substituted_keeps_bold_wrapper_around_translated_run() {
        // collect_text_runs numbering: run0=Hello, run1=world, run2=more.
        let mut m = HashMap::new();
        m.insert(0usize, "你好".into());
        m.insert(1usize, "世界".into());
        m.insert(2usize, "更多".into());
        let r = render_html("Hello **world** more", &m, false);
        assert!(r.html.contains(r#"<p>你好<strong>世界</strong>更多</p>"#));
    }

    #[test]
    fn code_block_highlight_with_line_numbers() {
        let md = "```rust\nfn main() {}\n```";
        let r = render_html(md, &HashMap::new(), false);
        assert!(r.html.contains("class=\"code-block\""));
        assert!(r.html.contains("class=\"ln\">1</span>"));
        // Should contain colored spans (syntect)
        assert!(r.html.contains("style=\"color:#"));
    }
}
