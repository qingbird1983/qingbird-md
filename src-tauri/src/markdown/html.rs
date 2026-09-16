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

/// 递归收集脚注定义 label（文档顺序），编号 1 起。
fn collect_fn_labels(blocks: &[Block], nums: &mut HashMap<String, usize>) {
    for b in blocks {
        match b {
            Block::FootnoteDef { label, blocks } => {
                if !nums.contains_key(label) {
                    let next = nums.len() + 1;
                    nums.insert(label.clone(), next);
                }
                collect_fn_labels(blocks, nums);
            }
            Block::Quote { blocks } => collect_fn_labels(blocks, nums),
            Block::List { items, .. } => {
                for it in items {
                    collect_fn_labels(&it.blocks, nums);
                }
            }
            _ => {}
        }
    }
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
            Block::FootnoteDef { label, blocks } => {
                // 定义不原地渲染——聚合进 fn_html，主流程走完后统一包
                // `<section class="footnotes">` 追加到文末。内容照常过
                // render_blocks 推进 bi/sub 计数，walk 顺序与 units 收集器
                // 一致，索引空间不受搬运影响。
                let num = self.fn_nums.get(label).copied().unwrap_or(0);
                let esc = escape_html(label);
                let mut buf = std::mem::take(&mut self.fn_html);
                let _ = write!(
                    buf,
                    "<li id=\"fn-{esc}\"><span class=\"fn-num\">{num}</span>"
                );
                self.render_blocks(&mut buf, blocks);
                let _ = write!(
                    buf,
                    "<a class=\"fn-back\" href=\"#fnref-{esc}\" aria-label=\"返回正文\">↩</a></li>"
                );
                self.fn_html = buf;
            }
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
                Inline::Mark(x) => {
                    out.push_str("<mark>");
                    self.push_inlines(out, x);
                    out.push_str("</mark>");
                }
                Inline::FootnoteRef(label) => {
                    // 上标编号跳到文末定义；无定义的悬空引用退回字面 [^label]
                    let esc = escape_html(label);
                    match self.fn_nums.get(label).copied() {
                        Some(n) => {
                            // 多次引用同一脚注只给首个锚点 id（重复 id 非法）
                            if self.fn_refs.insert(label.clone()) {
                                let _ = write!(
                                    out,
                                    r##"<sup class="fn-ref" id="fnref-{esc}"><a href="#fn-{esc}">{n}</a></sup>"##
                                );
                            } else {
                                let _ = write!(
                                    out,
                                    r##"<sup class="fn-ref"><a href="#fn-{esc}">{n}</a></sup>"##
                                );
                            }
                        }
                        None => {
                            let _ = write!(out, r#"<sup class="fn-ref">[^{esc}]</sup>"#);
                        }
                    }
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

    /// 卡片结构（对齐 openchamber 的代码块布局划分）：
    /// `<div class="code-card"><div class="code-head"><span
    /// class="code-lang">{lang}</span></div><pre class="code-block"><code
    /// style="--ln-digits:{n}">{flex 行}</code></pre></div>`。
    ///
    /// 每行一个 `<span class="cl"><span class="ln">{n}</span><span
    /// class="lc">{tokens}</span></span>`（CSS flex：行号 gutter 列 + 内容
    /// 列两段划分，长行折行对齐内容列、不再顶到 gutter 下面）。gutter 列宽
    /// 由 --ln-digits（总行数的十进制位数）统一决定——若按 2ch 逐行
    /// min-width，行号进到三位数时列宽突变，行号列分隔线会在 9→10、
    /// 99→100 等位数进位处断开/错位。行内不渲染游离 '\n' 文本节点
    /// （white-space 下会多出空行）；除末行外每个 .lc 以 '\n' 结尾。
    /// 注意 .ln 与 .lc 同在 <code> 子树内，`code.textContent` 是
    /// 「行号+内容」交替的串——前端取纯代码必须走 `src/lib/codeText.ts`
    /// 的 `codeTextFrom`（只收 .lc 列），不能直接读 code.textContent。
    /// Unknown/absent lang 以 "text" 标签渲染整块 monochrome-escaped。
    fn push_code_block(&self, out: &mut String, lang: Option<&str>, code: &str) {
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
                let n = lines.len();
                self.emit_code_open(out, lang, n);
                for (i, toks) in lines.iter().enumerate() {
                    let _ = write!(
                        out,
                        "<span class=\"cl\"><span class=\"ln\">{}</span><span class=\"lc\">",
                        i + 1
                    );
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
                    // 行分隔 '\n' 收进 .lc 尾部（非游离节点）：textContent
                    // 逐行带换行，复制与划选语义与源码一致。
                    if i + 1 < n {
                        out.push('\n');
                    }
                    out.push_str("</span></span>");
                }
            }
            None => {
                // 与高亮路径同构：mono 行也是 .cl/.ln/.lc flex 行，行尾 '\n'
                // 收进 .lc（末行除外），textContent 与源码一致。
                let mut ls: Vec<&str> = code.split('\n').collect();
                if ls.len() > 1 && ls.last() == Some(&"") {
                    ls.pop();
                }
                let n = ls.len();
                self.emit_code_open(out, lang, n);
                for (i, l) in ls.iter().enumerate() {
                    let _ = write!(
                        out,
                        "<span class=\"cl\"><span class=\"ln\">{}</span><span class=\"lc\">{}",
                        i + 1,
                        escape_html(l)
                    );
                    if i + 1 < n {
                        out.push('\n');
                    }
                    out.push_str("</span></span>");
                }
            }
        }
        out.push_str("</code></pre></div>");
    }

    /// 卡片与头栏开标签 + 带行号位数变量的 code 开标签（两条渲染路径共用，
    /// n 必须在产出任何行之前已知）。`--ln-digits` 是**总行数的十进制位数**
    /// （不是行数本身——行数直接烘进 calc(var*1ch) 会把 gutter 撑到天上去）。
    fn emit_code_open(&self, out: &mut String, lang: Option<&str>, lines: usize) {
        out.push_str(
            "<div class=\"code-card\"><div class=\"code-head\"><span class=\"code-lang\">",
        );
        out.push_str(&escape_html(lang.unwrap_or("text")));
        let digits = lines.to_string().len();
        let _ = write!(
            out,
            "</span></div><pre class=\"code-block\"><code style=\"--ln-digits:{}\">",
            digits
        );
    }
}

fn push_tok(lines: &mut Vec<Vec<(Color, Color, String)>>, c: (Color, Color), piece: &str) {
    if !piece.is_empty() {
        lines.last_mut().unwrap().push((c.0, c.1, piece.to_string()));
    }
}

/// 列对齐 → th/td 的 style 属性片段（0=default/left 不发样式）。
fn align_style(a: u8) -> &'static str {
    match a {
        1 => " style=\"text-align:center\"",
        2 => " style=\"text-align:right\"",
        _ => "",
    }
}

#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;
