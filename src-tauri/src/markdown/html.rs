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
//!
//! P2-7f 拆分布局（按「给谁 write」）：inline = 行内绘制与转义；code =
//! 代码块卡片；footnote = 脚注编号预扫与定义聚合。遍历核（render_blocks /
//! render_top_blocks / render_block / bi_advance / maybe_tr_box）留在本文件
//! ——sub/bi/ref 三个计数器在**单次**遍历内同轮推进，绝不拆成多轮，否则
//! 索引空间错位（译文贴错块）。

mod code;
mod footnote;
mod inline;

use std::collections::HashMap;
use std::fmt::Write;

use code::align_style;
use footnote::collect_fn_labels;
use inline::escape_html;

use super::model::Block;
use super::units::inline_plain_text;
use crate::translate::engine::TargetLang;

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
    /// 参考文献区段状态机：与 units.rs 收集器同源判定（Task: skip.rs）
    ref_state: crate::translate::skip::RefSkipState,
    /// 脚注：label → 编号（1 起，按定义出现顺序）；fn_html 聚合 `<li>` 条目，
    /// 主渲染走完后包上 `<section class="footnotes">` 追加到文档末尾。
    fn_nums: HashMap<String, usize>,
    fn_html: String,
    /// 已分配锚点 id 的引用 label（多次引用同一脚注只给首个 id，防重复）
    fn_refs: std::collections::HashSet<String>,
    /// 本次渲染的翻译方向。**必须与调用方收集译文时所传的方向一致**：
    /// `data-bi` 的占号由它决定，方向不同则同一份 translations 表会错位。
    /// 放在 Ctx 里而不是穿参数，是因为 `bi_advance` 被十几个渲染分支调用。
    target: TargetLang,
}

pub fn render_html(
    content: &str,
    trans: &HashMap<usize, String>,
    bilingual: bool,
    target: TargetLang,
) -> ParseResult {
    let blocks = super::model::parse_blocks(content);
    let mut ctx = Ctx {
        sub: if trans.is_empty() || bilingual { None } else { Some(trans) },
        bi: if bilingual { Some(trans) } else { None },
        sub_counter: 0,
        bi_counter: 0,
        heading_id: 0,
        outline: Vec::new(),
        ref_state: crate::translate::skip::RefSkipState::default(),
        fn_nums: HashMap::new(),
        fn_html: String::new(),
        fn_refs: std::collections::HashSet::new(),
        target,
    };
    // 预扫：脚注定义按出现顺序编号（引用在定义之前渲染，需先备好映射）。
    // 预扫递归顺序与渲染 walk 一致，编号即文档顺序。
    collect_fn_labels(&blocks, &mut ctx.fn_nums);
    let mut html = String::new();
    let src_lines = super::model::top_level_block_lines(content);
    ctx.render_top_blocks(&mut html, &blocks, &src_lines);
    if !ctx.fn_html.is_empty() {
        html.push_str("<section class=\"footnotes\"><ol>");
        html.push_str(&ctx.fn_html);
        html.push_str("</ol></section>");
    }
    ParseResult { html, outline: std::mem::take(&mut ctx.outline) }
}

impl<'t> Ctx<'t> {
    fn render_blocks(&mut self, out: &mut String, blocks: &[Block]) {
        for b in blocks {
            self.render_block(out, b);
            out.push('\n');
        }
    }

    /// 顶层块渲染：与 [`Self::render_blocks`] 的唯一差别是给块前置一行
    /// `<!--sl:N-->` **源行锚点**（N = 该块在源码里的 1 起行号，由
    /// `model::top_level_block_lines` 按同一事件序列算出）。
    ///
    /// 为什么是注释而不是块上的 `data-sl` 属性：属性要插进块的开标签，而
    /// 开标签串（`<p data-bi="1">` 等）被大量测试与前端逻辑当作契约字面量；
    /// 注释作为独立兄弟节点既能被前端按序配对，又完全不参与布局、不进
    /// `textContent` / `Range.toString()`（全选、复制、代码取文一律不受影响）。
    /// 嵌套块不挂锚点——顶层粒度已足够定位，且嵌套块的位置由父块决定。
    ///
    /// 脚注定义块不挂锚点：它被搬到文末 footnotes 区渲染，行号在 DOM 序里
    /// 不再单调，留作锚点会让「按行号最近的块」查错。
    fn render_top_blocks(&mut self, out: &mut String, blocks: &[Block], lines: &[usize]) {
        for (i, b) in blocks.iter().enumerate() {
            if !matches!(b, Block::FootnoteDef { .. }) {
                if let Some(line) = lines.get(i) {
                    let _ = write!(out, "<!--sl:{}-->", line);
                }
            }
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
                let bi_idx = self.bi_advance(&plain, Some(*level));
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
                let bi_idx = self.bi_advance(&plain, None);
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
            Block::Table { headers, rows, aligns } => {
                out.push_str("<table><thead><tr>");
                for (ci, h) in headers.iter().enumerate() {
                    let plain = inline_plain_text(h);
                    let bi_idx = self.bi_advance(&plain, None);
                    let sty = align_style(aligns.get(ci).copied().unwrap_or(0));
                    match bi_idx {
                        Some(i) => write!(out, r#"<th data-bi="{}"{}>"#, i, sty).unwrap(),
                        None => write!(out, "<th{}>", sty).unwrap(),
                    }
                    self.push_inlines(out, h);
                    self.maybe_tr_box(out, bi_idx);
                    out.push_str("</th>");
                }
                out.push_str("</tr></thead><tbody>");
                for row in rows {
                    out.push_str("<tr>");
                    for (ci, cell) in row.iter().enumerate() {
                        let plain = inline_plain_text(cell);
                        let bi_idx = self.bi_advance(&plain, None);
                        let sty = align_style(aligns.get(ci).copied().unwrap_or(0));
                        match bi_idx {
                            Some(i) => write!(out, r#"<td data-bi="{}"{}>"#, i, sty).unwrap(),
                            None => write!(out, "<td{}>", sty).unwrap(),
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
            // 定义不原地渲染：委托 footnote::render_footnote_def 聚合进
            // fn_html（仍在本次遍历内执行，bi/sub 计数照常推进）。
            Block::FootnoteDef { label, blocks } => self.render_footnote_def(label, blocks),
        }
    }

    /// Assign the block-space index for this block/cell if it is translatable.
    /// 恒占号（与 units::collect_translatable 逐块一致），无论当前渲染形态——
    /// 原文/done 渲染的 data-bi 锚点编号因此与 partial 事件的 index 同空间。
    /// 参考文献区段内的块不占号（skip 判定与收集器同源，Task skip.rs）。
    /// 返回 None 表示本块不占号（不开 data-bi、不追加 tr-box）。
    fn bi_advance(&mut self, plain: &str, heading: Option<u8>) -> Option<usize> {
        // 判定走 units 的**唯一实现**（feed + needs_translation）——此前这里
        // 是同一逻辑的第二份拷贝，与收集器/导出 writer 靠注释对齐；三处任一
        // 漂移都会让译文贴错块且不报错，故收敛为单点。
        if !super::units::block_translatable(&mut self.ref_state, heading, plain, self.target) {
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
}

#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;
