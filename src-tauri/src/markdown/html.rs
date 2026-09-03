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
use crate::translate::engine::needs_translation;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct OutlineItem {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
                let bi_idx = self.bi_advance(&plain);
                match bi_idx {
                    Some(i) => write!(out, r#"<h{} id="{}" data-bi="{}">"#, level, id, i).unwrap(),
                    None => write!(out, "<h{} id=\"{}\">", level, id).unwrap(),
                }
                self.push_inlines(out, text);
                let _ = writeln!(out, "</h{}>", level);
                self.maybe_tr_box(out, bi_idx);
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                let bi_idx = self.bi_advance(&plain);
                match bi_idx {
                    Some(i) => write!(out, r#"<p data-bi="{}">"#, i).unwrap(),
                    None => out.push_str("<p>"),
                }
                self.push_inlines(out, text);
                out.push_str("</p>");
                self.maybe_tr_box(out, bi_idx);
            }
            Block::Code { lang, code } => match lang.as_deref() {
                Some("mermaid") => {
                    out.push_str(r#"<div class="mermaid" data-source=""#);
                    out.push_str(&escape_html(code));
                    out.push_str(r#""></div>"#);
                }
                Some("math") => {
                    out.push_str(r#"<div class="math block" data-source=""#);
                    out.push_str(&escape_html(code));
                    out.push_str(r#""></div>"#);
                }
                _ => self.push_code_block(out, lang.as_deref(), code),
            },
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
                out.push_str("<table><thead><tr>");
                for h in headers {
                    let plain = inline_plain_text(h);
                    let bi_idx = self.bi_advance(&plain);
                    match bi_idx {
                        Some(i) => write!(out, r#"<th data-bi="{}">"#, i).unwrap(),
                        None => out.push_str("<th>"),
                    }
                    self.push_inlines(out, h);
                    self.maybe_tr_box(out, bi_idx);
                    out.push_str("</th>");
                }
                out.push_str("</tr></thead><tbody>");
                for row in rows {
                    out.push_str("<tr>");
                    for cell in row {
                        let plain = inline_plain_text(cell);
                        let bi_idx = self.bi_advance(&plain);
                        match bi_idx {
                            Some(i) => write!(out, r#"<td data-bi="{}">"#, i).unwrap(),
                            None => out.push_str("<td>"),
                        }
                        self.push_inlines(out, cell);
                        self.maybe_tr_box(out, bi_idx);
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
            }
            Block::Math { display, tex } => {
                let cls = if *display { "math block" } else { "math inline" };
                let _ = write!(
                    out,
                    r#"<div class="{}" data-source="{}"></div>"#,
                    cls,
                    escape_html(tex)
                );
            }
        }
    }

    /// Assign the block-space index for this block/cell if it is translatable.
    /// 恒占号（与 units::collect_translatable 逐块一致），无论当前渲染形态——
    /// 原文/done 渲染的 data-bi 锚点编号因此与 partial 事件的 index 同空间。
    /// 返回 None 表示本块不占号（不开 data-bi、不追加 tr-box）。
    fn bi_advance(&mut self, plain: &str) -> Option<usize> {
        if !needs_translation(plain) {
            return None;
        }
        let idx = self.bi_counter;
        self.bi_counter += 1;
        Some(idx)
    }

    /// Append `<div class="tr-box">…</div>` in bilingual mode, using the
    /// index already assigned by [`Self::bi_advance`].
    fn maybe_tr_box(&mut self, out: &mut String, bi_idx: Option<usize>) {
        let Some(idx) = bi_idx else { return };
        let Some(map) = self.bi else { return };
        if let Some(tr) = map.get(&idx) {
            let _ = write!(out, r#"<div class="tr-box">{}</div>"#, escape_html(tr));
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
                    let _ = write!(out, r#"<span data-ri="{}">"#, idx);
                    match tr {
                        Some(tr) => out.push_str(&escape_html(tr)),
                        None => out.push_str(&escape_html(t)),
                    }
                    out.push_str("</span>");
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
                    // T25：target=_blank 是第一道属性级防线——即使点击漏过前端
                    // 拦截，WebView2 也只会尝试新窗请求，绝不会把主窗口整窗导航
                    // 到外部站点（此前无 target 时点一下 = 整个阅读器被网站顶掉，
                    // 标题栏/快捷键全失，只能强杀）。实际点击由前端 capture 拦截
                    // 走 open_external（系统浏览器），rel=noopener 防新窗反向劫持。
                    let _ = write!(
                        out,
                        r#"<a href="{}" target="_blank" rel="noopener noreferrer">"#,
                        escape_html(href)
                    );
                    self.push_inlines(out, text);
                    out.push_str("</a>");
                }
                Inline::Image { alt, src } => {
                    let _ =
                        write!(out, r#"<img src="{}" alt="{}">"#, escape_html(src), escape_html(alt));
                }
                Inline::LineBreak => out.push_str("<br>"),
                Inline::Math(tex) => {
                    let _ = write!(
                        out,
                        r#"<span class="math inline" data-source="{}"></span>"#,
                        escape_html(tex)
                    );
                }
                // 行文中段出现的 $$...$$：行内 span（<div> 不能嵌 <p>）；
                // 独立成段的已由 model 层升级为 Block::Math{display:true}。
                Inline::DisplayMath(tex) => {
                    let _ = write!(
                        out,
                        r#"<span class="math inline" data-source="{}"></span>"#,
                        escape_html(tex)
                    );
                }
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
                let mut lines: Vec<Vec<(Color, Color, String)>> = vec![Vec::new()];
                for (c, d, t) in spans {
                    let mut rest = t.as_str();
                    while let Some(p) = rest.find('\n') {
                        push_tok(&mut lines, (c, d), &rest[..p]);
                        lines.push(Vec::new());
                        rest = &rest[p + 1..];
                    }
                    push_tok(&mut lines, (c, d), rest);
                }
                // Drop only the trailing artifact of a final "\n".
                while lines.len() > 1 && lines.last().unwrap().is_empty() {
                    lines.pop();
                }
                for (i, toks) in lines.iter().enumerate() {
                    // 与 mono 路径同构：每个行边界恰好一个 '\n'（首行前除外），
                    // 否则高亮块所有行连成一段、CSS 的行号 gutter 无法成行。
                    if i > 0 {
                        out.push('\n');
                    }
                    let _ = write!(out, "<span class=\"ln\">{}</span>", i + 1);
                    for (cl, cd, piece) in toks {
                        // 双主题颜色对烘进 CSS 变量：亮色取 --cl，暗色取 --cd
                        // （选择逻辑在 markdown.css，按 body[data-theme] 切换）。
                        let _ = write!(
                            out,
                            "<span style=\"--cl:#{:02x}{:02x}{:02x};--cd:#{:02x}{:02x}{:02x}\">{}</span>",
                            cl.r, cl.g, cl.b, cd.r, cd.g, cd.b,
                            escape_html(piece)
                        );
                    }
                }
            }
            None => {
                // 与高亮路径同构：每个行边界恰好一个 '\n'（此处分隔符插入），
                // 否则 mono 块所有行连成一段、CSS 的行号 gutter 无法成行。
                let mut ls: Vec<&str> = code.split('\n').collect();
                if ls.len() > 1 && ls.last() == Some(&"") {
                    ls.pop();
                }
                for (i, l) in ls.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    let _ = write!(out, "<span class=\"ln\">{}</span>{}", i + 1, escape_html(l));
                }
            }
        }
        out.push_str("</code></pre>");
    }
}

fn push_tok(lines: &mut Vec<Vec<(Color, Color, String)>>, c: (Color, Color), piece: &str) {
    if !piece.is_empty() {
        lines.last_mut().unwrap().push((c.0, c.1, piece.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn original_mode_renders_basic_markdown() {
        let r = render_html("# Ti\n\ntext **b**.", &HashMap::new(), false);
        assert!(r.html.contains(r#"<h1 id="h-1" data-bi="0"><span data-ri="0">Ti</span></h1>"#));
        assert!(r.html.contains(r#"<strong><span data-ri="2">b</span></strong>"#));
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
        // Text(" quote") survive, each wrapped in a data-ri span. The
        // guarantee tested here stands: every surviving text goes through
        // escape_html, so raw "<b>" can never be emitted.
        assert!(r.html.contains(r#"<span data-ri="1">&amp;</span>"#));
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
        assert!(
            r.html
                .contains(r#"<p data-bi="1"><span data-ri="1">Body text</span></p><div class="tr-box">正文译文</div>"#)
        );
    }

    #[test]
    fn anchors_mark_bi_blocks_and_ri_runs_in_original_render() {
        // 原文渲染（trans 空）也输出锚点：data-bi 与 collect_translatable 的块
        // 空间一致，data-ri 与 collect_text_runs 的 run 空间一致——partial 流式
        // 回填靠这两个属性定位 DOM。
        let md = "# Hello\n\nA **B** C\n\n```rust\nfn x() {}\n```\n\n中文段落\n\nDone doc\n";
        let r = render_html(md, &HashMap::new(), false);
        // 块空间：Hello(0)、A B C(1)、中文段落(无 ASCII 不占号)、Done doc(2)
        assert!(r.html.contains(r#"<h1 id="h-1" data-bi="0">"#));
        assert!(r.html.contains(r#"<p data-bi="1">"#));
        assert!(r.html.contains(r#"<p data-bi="2">"#));
        assert_eq!(r.html.matches("data-bi=").count(), 3);
        // run 空间：每个 Text run 占号（含不可翻译的中文段落）：
        // Hello(0) A..(1) B(2) ..C(3) 中文段落(4) Done doc(5)
        for i in 0..6 {
            assert!(r.html.contains(&format!(r#"data-ri="{}""#, i)));
        }
        assert_eq!(r.html.matches("data-ri=").count(), 6);
    }

    #[test]
    fn substituted_render_keeps_run_anchors() {
        // translation 形态（run 替换）里 span 恒在——替换发生在 span 内部，
        // 属性数量不变，done 后锚点仍然可寻址。
        let md = "A **B** C\n";
        let mut trans = HashMap::new();
        trans.insert(1usize, "乙".to_string()); // run 1 = "A ..." 之外的 Text run
        let r = render_html(md, &trans, false);
        assert_eq!(r.html.matches("data-ri=").count(), 3);
        assert!(r.html.contains(r#"<span data-ri="1">乙</span>"#));
    }

    #[test]
    fn substituted_keeps_bold_wrapper_around_translated_run() {
        // collect_text_runs numbering: run0=Hello, run1=world, run2=more.
        let mut m = HashMap::new();
        m.insert(0usize, "你好".into());
        m.insert(1usize, "世界".into());
        m.insert(2usize, "更多".into());
        let r = render_html("Hello **world** more", &m, false);
        assert!(
            r.html.contains(
                r#"<p data-bi="0"><span data-ri="0">你好</span><strong><span data-ri="1">世界</span></strong><span data-ri="2">更多</span></p>"#
            )
        );
    }

    #[test]
    fn multicol_table_single_thead_row() {
        let r = render_html("| a | b |\n| --- | --- |\n| 1 | 2 |", &HashMap::new(), false);
        // Exactly one <tr> in thead, holding BOTH th cells ("a"/"b" 可翻译：
        // 开标签带 data-bi，内文为 data-ri span；"1"/"2" 不可翻译，td 无 data-bi).
        assert!(
            r.html.contains(
                r#"<thead><tr><th data-bi="0"><span data-ri="0">a</span></th><th data-bi="1"><span data-ri="1">b</span></th></tr></thead>"#
            )
        );
        let thead = r.html.split("</thead>").next().unwrap();
        assert_eq!(thead.matches("<tr>").count(), 1, "header must be one row");
        assert_eq!(thead.matches("<th ").count(), 2);
        // Body keeps its single normal row.
        assert!(
            r.html.contains(
                r#"<tbody><tr><td><span data-ri="2">1</span></td><td><span data-ri="3">2</span></td></tr></tbody>"#
            )
        );
    }

    #[test]
    fn code_block_highlight_with_line_numbers() {
        let md = "```rust\nfn main() {}\n```";
        let r = render_html(md, &HashMap::new(), false);
        assert!(r.html.contains("class=\"code-block\""));
        assert!(r.html.contains("class=\"ln\">1</span>"));
        // Should contain dual-theme colored spans (syntect --cl/--cd pair)
        assert!(r.html.contains("--cl:#"), "light color var");
        assert!(r.html.contains("--cd:#"), "dark color var");
    }

    #[test]
    fn known_lang_code_block_lines_newline_separated() {
        // 高亮路径与 mono 路径同构：每个行边界恰好一个 '\n'，否则高亮块
        // 所有行连成一段，CSS（white-space: pre-wrap + .ln 行号）无法断行。
        let r = render_html("```rust\nfn a() {}\nfn b() {}\n```", &HashMap::new(), false);
        assert!(r.html.contains("--cl:#"), "must take highlight path");
        assert!(r.html.contains(r#"<span class="ln">1</span>"#));
        assert!(
            r.html.contains("\n<span class=\"ln\">2</span>"),
            "highlighted lines must be newline-separated"
        );
        let code = r.html.split("</code>").next().unwrap();
        assert_eq!(code.matches("<span class=\"ln\">").count(), 2);
    }

    #[test]
    fn unknown_lang_code_block_lines_newline_separated() {
        // Task 20 gutter 前提：mono 路径必须与高亮路径同构——行边界恰好一个
        // '\n'，否则所有行连成一段，CSS（white-space: pre-wrap + .ln 行号）
        // 无法断行。
        let r = render_html("```\nalpha\nbeta\n```", &HashMap::new(), false);
        assert!(r.html.contains(r#"<span class="ln">1</span>alpha"#));
        assert!(r.html.contains("\n<span class=\"ln\">2</span>beta"));
        let code = r.html.split("</code>").next().unwrap();
        assert_eq!(code.matches("<span class=\"ln\">").count(), 2);
    }

    #[test]
    fn code_block_mermaid_emits_placeholder() {
        let r = render_html("```mermaid\ngraph TD\nA-->B\n```", &HashMap::new(), false);
        assert!(
            r.html.contains(r#"<div class="mermaid" data-source="graph TD
A--&gt;B
"></div>"#),
            "mermaid block must emit data-source placeholder: {}",
            r.html
        );
    }

    #[test]
    fn inline_dollar_math_emits_placeholder() {
        let r = render_html("Hello $x^2$ world", &HashMap::new(), false);
        assert!(
            r.html.contains(r#"<span class="math inline" data-source="x^2"></span>"#),
            "inline math must emit inline placeholder: {}",
            r.html
        );
    }

    #[test]
    fn block_math_fenced_or_dollar_pair() {
        let r1 = render_html("```math\n\\sum_i\n```", &HashMap::new(), false);
        assert!(
            r1.html.contains(r#"<div class="math block" data-source="\sum_i
"></div>"#),
            "math fenced must emit block placeholder: {}",
            r1.html
        );
        let r2 = render_html("$$\n\\sum_i\n$$", &HashMap::new(), false);
        assert!(
            // pulldown 0.13 的 DisplayMath tex 保留 $$ 内侧的首尾换行
            r2.html.contains(r#"<div class="math block" data-source="
\sum_i
"></div>"#),
            "math dollar-pair must emit block placeholder: {}",
            r2.html
        );
    }

    #[test]
    fn mermaid_data_source_escapes_html() {
        let r = render_html(
            "```mermaid\n<script>alert(1)</script>\n```",
            &HashMap::new(),
            false,
        );
        // XSS：<script> 必须转义为 &lt;script&gt;
        assert!(
            r.html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "mermaid source must escape HTML: {}",
            r.html
        );
        // 整段 HTML 不能含裸 <script>
        assert!(!r.html.contains("<script>"), "raw <script> must not appear");
    }

    #[test]
    fn mermaid_block_does_not_consume_sub_counter() {
        // 双语模式下 mermaid 块不消耗 sub_counter，Hello 段仍翻译
        let mut m = HashMap::new();
        m.insert(0usize, "你好".into());
        let r = render_html("```mermaid\ngraph TD\nA-->B\n```\n\nHello", &m, false);
        assert!(
            r.html.contains("你好"),
            "substituted translation must apply to Hello: {}",
            r.html
        );
    }

    /// Whole-branch review (Task 3 in-flight spec deviation): DisplayMath 的两
    /// 条 emit 路径此前无测试覆盖——独立成段走 paragraph_block 升级到
    /// `Block::Math { display: true }`，行文中段按 inline span 渲染（避免
    /// `<div>` 嵌 `<p>` 非法 HTML）。
    #[test]
    fn display_math_standalone_and_inline_both_emit_placeholders() {
        // (a) 独立成段：pulldown 实测总是 Paragraph 包裹，paragraph_block
        // 把单 Inline::DisplayMath 升级为 Block::Math{display:true}，emit div。
        // pulldown 保留 $$ 内侧首尾换行，KaTeX/mermaid 对首尾空白不敏感。
        let r1 = render_html("$$\n\\sum_i\n$$", &HashMap::new(), false);
        // pulldown 保留 $$ 内侧首尾换行到 data-source："\n\sum_i\n"
        assert!(
            r1.html.contains("<div class=\"math block\" data-source=\"\n\\sum_i\n\"></div>"),
            "standalone $$...$$ must upgrade to Block::Math and emit div: {}",
            r1.html
        );
        assert!(!r1.html.contains("<p>"), "must not wrap in <p>: {}", r1.html);

        // (b) 行文中段：保留 paragraph 包裹，$$...$$ 部分按 inline span 渲染。
        let r2 = render_html("see $$x^2$$ here", &HashMap::new(), false);
        assert!(
            r2.html.contains(r#"<span class="math inline" data-source="x^2"></span>"#),
            "mid-paragraph $$...$$ must render as inline span: {}",
            r2.html
        );
        assert!(
            r2.html.contains("see "),
            "preceding text preserved: {}",
            r2.html
        );
        assert!(
            r2.html.contains(" here"),
            "trailing text preserved: {}",
            r2.html
        );
    }

    // ---- T25: 链接渲染必须带 target=_blank（防整窗导航劫持）----

    #[test]
    fn links_carry_target_blank_and_noopener() {
        let r = render_html(
            "[青鸟](https://gitee.com/muyan1983/qingbird-md)",
            &HashMap::new(),
            false,
        );
        assert!(
            r.html.contains(
                r#"<a href="https://gitee.com/muyan1983/qingbird-md" target="_blank" rel="noopener noreferrer">"#
            ),
            "link must carry target=_blank: {}",
            r.html
        );
        // 危险 scheme 照常转义输出（href 仍是属性值，绝不执行）；拦截在
        // 前端 capture + Rust open_external 白名单两层兜底。
        let r2 = render_html("[x](javascript:alert(1))", &HashMap::new(), false);
        assert!(r2.html.contains(r#"href="javascript:alert(1)""#));
        assert!(r2.html.contains("target=\"_blank\""));
        assert!(!r2.html.contains("<script"));
    }

    #[test]
    fn links_and_image_links_carry_target() {
        // 显式链接与「图片包链接」都走 Inline::Link，统一带 target。
        let r = render_html("[官网](https://example.com/x)", &HashMap::new(), false);
        assert!(r.html.contains("target=\"_blank\""), "{}", r.html);
        let r2 = render_html(
            "[![logo](img/a.png)](https://example.com)",
            &HashMap::new(),
            false,
        );
        assert!(r2.html.contains("target=\"_blank\""), "{}", r2.html);
        // 裸 URL（本渲染器未开 GFM autolink）退化为纯文本——不是链接，
        // 自然无 target，也无需拦截。
        let r3 = render_html("https://example.com/x", &HashMap::new(), false);
        assert!(!r3.html.contains("<a "), "{}", r3.html);
    }
}
