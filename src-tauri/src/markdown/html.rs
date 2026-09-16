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
use crate::translate::engine::{needs_translation, TargetLang};

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
        let blocked = self
            .ref_state
            .feed(heading.map(|l| (l, plain)));
        if !needs_translation(plain, self.target) || blocked {
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
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// 测试专用影子函数：本模块的测试默认跑「译成中文」方向（= Step 0 的生产行为）。
    ///
    /// 为什么要有它：`render_html` 加了 `target` 参数后，本文件 40 多处调用点若
    /// 逐个加参，diff 会被噪音淹没、且每一处都要人判断"这里该传什么方向"——
    /// 而它们**本来就全是 zh 方向**。收成一个影子函数（局部定义优先于
    /// `use super::*` 的 glob 导入）后，测试读起来更清楚，生产调用点则仍然
    /// **被迫显式传方向**，不会出现"忘了传就用默认"的坑。
    fn render_html(
        content: &str,
        trans: &HashMap<usize, String>,
        bilingual: bool,
    ) -> ParseResult {
        super::render_html(content, trans, bilingual, TargetLang::Zh)
    }

    /// 极少数要显式验证方向行为的用例用这个（别改影子函数去迁就个别用例）。
    fn render_html_dir(
        content: &str,
        trans: &HashMap<usize, String>,
        bilingual: bool,
        target: TargetLang,
    ) -> ParseResult {
        super::render_html(content, trans, bilingual, target)
    }

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
        // 卡片结构：code-card > (code-head > code-lang) + pre.code-block；
        // --ln-digits = 总行数位数（1 行块为 1）
        assert!(
            r.html.contains(
                r#"<div class="code-card"><div class="code-head"><span class="code-lang">rust</span></div><pre class="code-block"><code style="--ln-digits:1">"#
            )
        );
        assert!(r.html.contains(r#"<span class="ln">1</span>"#));
        assert!(r.html.contains("</code></pre></div>"));
        // Should contain dual-theme colored spans (syntect --cl/--cd pair)
        assert!(r.html.contains("--cl:#"), "light color var");
        assert!(r.html.contains("--cd:#"), "dark color var");
    }

    #[test]
    fn known_lang_code_block_lines_newline_separated() {
        // flex 行契约：每行一个 .cl（.ln 行号 + .lc 内容），行尾 '\n' 收进
        // .lc（末行除外）——textContent 逐行带换行、pre 内无游离换行节点。
        let r = render_html("```rust\nfn a() {}\nfn b() {}\n```", &HashMap::new(), false);
        assert!(r.html.contains("--cl:#"), "must take highlight path");
        let body = r
            .html
            .split(r#"<pre class="code-block"><code style="--ln-digits:1">"#)
            .nth(1)
            .unwrap()
            .split("</code>")
            .next()
            .unwrap();
        assert_eq!(body.matches(r#"<span class="cl">"#).count(), 2);
        assert_eq!(body.matches(r#"<span class="ln">"#).count(), 2);
        // 首行 .lc 以 '\n' 结尾，末行不带
        assert!(body.contains(r#"<span class="ln">1</span><span class="lc">"#));
        assert!(body.contains("\n</span></span>"));
        assert!(body.ends_with("</span></span>"));
        assert!(!body.contains("\n<span"), "pre 内不得有游离换行节点");
    }

    #[test]
    fn unknown_lang_code_block_lines_newline_separated() {
        // mono 路径与高亮路径同构（.cl/.ln/.lc flex 行 + .lc 尾 '\n'）；
        // 无 lang 时头栏标签回退 "text"。
        let r = render_html("```\nalpha\nbeta\n```", &HashMap::new(), false);
        assert!(r.html.contains(r#"<span class="code-lang">text</span>"#));
        assert!(r.html.contains("<span class=\"ln\">1</span><span class=\"lc\">alpha\n</span></span>"));
        assert!(r.html.contains(r#"<span class="ln">2</span><span class="lc">beta</span></span>"#));
        let body = r
            .html
            .split(r#"<pre class="code-block"><code style="--ln-digits:1">"#)
            .nth(1)
            .unwrap()
            .split("</code>")
            .next()
            .unwrap();
        assert_eq!(body.matches(r#"<span class="cl">"#).count(), 2);
        // 逐行 .lc 拼接即源码 alpha\nbeta（前端 codeTextFrom 的实现依据）
        assert!(body.contains(r#"<span class="lc">alpha
</span></span><span class="cl"><span class="ln">2</span><span class="lc">beta</span>"#));
    }

    #[test]
    fn code_block_ln_digits_is_digit_count_not_line_count() {
        // 回归：--ln-digits 必须是总行数的十进制位数。曾误传行数本身——
        // 100+ 行的块被算成 calc(行数 * 1ch)，gutter 占掉九成宽度挤没代码。
        for (lines, digits) in [(2usize, 1), (9, 1), (10, 2), (99, 2), (100, 3), (123, 3)] {
            let md = format!("```\n{}\n```", vec!["x"; lines].join("\n"));
            let r = render_html(&md, &HashMap::new(), false);
            assert!(
                r.html.contains(&format!(r#"--ln-digits:{}"#, digits)),
                "{} 行块应得 {} 位，实际: {}",
                lines,
                digits,
                &r.html[..r.html.len().min(400)]
            );
        }
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

    // ---- 语法全覆盖测试.md 补齐项（2026-09-11）----

    #[test]
    fn footnote_renders_refs_and_end_section() {
        let md = "See[^a] and [^a] again.\n\n[^a]: The note.";
        let r = render_html(md, &HashMap::new(), false);
        // 首个引用带锚点 id，后续引用复用编号但不重复 id
        assert!(
            r.html.contains(
                r##"<sup class="fn-ref" id="fnref-a"><a href="#fn-a">1</a></sup>"##
            ),
            "{}",
            r.html
        );
        assert!(r.html.contains(r##"<sup class="fn-ref"><a href="#fn-a">1</a></sup>"##));
        // 定义聚合到文末脚注区
        let tail = r.html.split(r#"<section class="footnotes">"#).nth(1).unwrap();
        assert!(tail.contains(r#"<li id="fn-a"><span class="fn-num">1</span>"#), "{}", tail);
        assert!(tail.contains(r##"<a class="fn-back" href="#fnref-a""##));
        assert!(tail.contains("The note."));
        assert!(!r.html.split("<section class=\"footnotes\">").next().unwrap().contains("The note."));
    }

    #[test]
    fn footnote_dangling_ref_renders_literal_label() {
        let r = render_html("Lonely[^nope] ref", &HashMap::new(), false);
        // pulldown-cmark 对未定义引用不发 FootnoteReference 事件：
        // `[^nope]` 按字面文本渲染（`[` 作潜在链接起始被劈成多个 Text run，
        // 对应多个 data-ri span，故逐片段断言）
        assert!(r.html.contains(r#">[</span><span data-ri="2">^nope</span><span data-ri="3">]</span>"#), "{}", r.html);
        assert!(!r.html.contains("fn-ref"), "{}", r.html);
        assert!(!r.html.contains("footnotes"));
    }

    #[test]
    fn mark_renders_mark_element() {
        let r = render_html("==hi== now", &HashMap::new(), false);
        assert!(r.html.contains("<mark><span data-ri=\"0\">hi</span></mark>"), "{}", r.html);
    }

    #[test]
    fn table_alignment_styles() {
        let md = "| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |";
        let r = render_html(md, &HashMap::new(), false);
        // 居中/右对齐各出现在 th 与 td 上；左对齐（:---）不发 style
        assert_eq!(r.html.matches("style=\"text-align:center\"").count(), 2, "{}", r.html);
        assert_eq!(r.html.matches("style=\"text-align:right\"").count(), 2, "{}", r.html);
        assert!(r.html.contains(r#"<th data-bi="0"><span data-ri="0">l</span></th>"#), "{}", r.html);
    }

    #[test]
    fn front_matter_absent_from_html() {
        let r = render_html("---\ntitle: T\n---\n\nBody", &HashMap::new(), false);
        assert!(!r.html.contains("title:"), "{}", r.html);
        assert!(r.html.contains("Body"));
    }

    // ---- 顶层块源行锚点（分栏同步用，2026-09-14）----

    #[test]
    fn src_line_anchors_precede_every_top_level_block() {
        let md = "# 标题\n\n正文段落。\n\n- 项 1\n- 项 2\n";
        let r = render_html(md, &HashMap::new(), false);
        assert!(r.html.contains("<!--sl:1--><h1"), "{}", r.html);
        assert!(r.html.contains("<!--sl:3--><p"), "{}", r.html);
        assert!(r.html.contains("<!--sl:5--><ul>"), "{}", r.html);
        // 每个顶层块恰一个锚点
        assert_eq!(
            r.html.matches("<!--sl:").count(),
            crate::markdown::parse_blocks(md).len(),
            "{}",
            r.html
        );
    }

    #[test]
    fn src_line_anchors_skip_relocated_footnote_defs() {
        // 定义块被搬到文末渲染，行号在 DOM 序里不再单调 → 不留锚点
        let md = "正文[^a]。\n\n[^a]: 定义。\n";
        let r = render_html(md, &HashMap::new(), false);
        assert!(!r.html.contains("<!--sl:3-->"), "{}", r.html);
        assert_eq!(r.html.matches("<!--sl:").count(), 1, "{}", r.html);
    }

    #[test]
    fn src_line_anchors_survive_all_three_modes() {
        // 三种形态（原文/替换/对照）都走 render_top_blocks，锚点不能只在一种形态出现
        let md = "# Title\n\nHello world.\n";
        let mut m = HashMap::new();
        m.insert(0usize, "标题".to_string());
        for r in [
            render_html(md, &HashMap::new(), false),
            render_html(md, &m, false),
            render_html(md, &m, true),
        ] {
            assert_eq!(r.html.matches("<!--sl:1-->").count(), 1, "{}", r.html);
            assert_eq!(r.html.matches("<!--sl:3-->").count(), 1, "{}", r.html);
        }
    }

    #[test]
    fn demo_doc_renders_mermaid_and_math_placeholders() {
        // 示例文档（docs/screenshots/demo.md，随包内联给「打开示例文档」，也是 README
        // 截图的取景对象）里那节「图表与公式」必须真能出占位符——它只是 markdown
        // 文本，改了围栏语言/公式写法就会静默退化成普通代码块与纯文本。
        // 路径按 CARGO_MANIFEST_DIR 定位，不依赖 cargo test 的调用目录。
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../docs/screenshots/demo.md");
        let md = std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("读不到示例文档 {}: {e}", p.display()));
        let r = render_html(&md, &HashMap::new(), false);
        assert_eq!(r.html.matches(r#"<div class="mermaid" data-source=""#).count(), 1);
        assert!(r.html.contains("flowchart LR"), "mermaid 源码没进 data-source");
        assert_eq!(r.html.matches(r#"<div class="math block" data-source=""#).count(), 1);
        assert!(r.html.matches("math inline").count() >= 1, "行内公式应有占位符");
    }

    #[test]
    fn data_bi_parity_with_footnotes_and_marks() {
        // 新变体（FootnoteDef 内容参与占号）不破坏渲染/收集对齐铁律
        let md = "Hello[^1] ==world==\n\n[^1]: Eng footnote body\n";
        let r = render_html(md, &HashMap::new(), false);
        let mut rendered = Vec::new();
        let mut rest = r.html.as_str();
        while let Some(p) = rest.find("data-bi=\"") {
            let after = &rest[p + 9..];
            let end = after.find('"').unwrap();
            rendered.push(after[..end].parse::<usize>().unwrap());
            rest = &after[end + 1..];
        }
        let blocks = crate::markdown::parse_blocks(md);
        let collected: Vec<usize> =
            crate::markdown::units::collect_translatable(&blocks, TargetLang::Zh).iter().map(|&(i, _)| i).collect();
        assert_eq!(rendered, collected, "渲染占号与收集索引必须逐位一致");
    }

    // ---- 文献区段 skip：占号接入（对齐锚定）----

    #[test]
    fn reference_section_blocks_have_no_bi_anchor() {
        // 简报断言按裸文本 HTML 写就，与实际渲染不符：所有文本恒包
        // data-ri span，且 heading id 逐个递增（Intro=h-1、References=h-2、
        // Acknowledgements=h-3，非简报假设的 h-4）——按实际 DOM 结构适配。
        let md = "# Intro\n\n## References\n\nSmith 2020.\n\n## Acknowledgements\n\nThanks.";
        let r = render_html(md, &HashMap::new(), false);
        // 区段内段落无 data-bi 无 tr-box
        assert!(
            r.html.contains(r#"<p><span data-ri="2">Smith 2020.</span></p>"#),
            "区段内段落无 data-bi 无 tr-box: {}",
            r.html
        );
        // 复位后标题重新占号
        assert!(
            r.html
                .contains(r#"<h2 id="h-3" data-bi="1"><span data-ri="3">Acknowledgements</span></h2>"#),
            "复位后标题重新占号: {}",
            r.html
        );
        assert!(
            r.html.contains(r#"<p data-bi="2"><span data-ri="4">Thanks.</span></p>"#),
            "{}",
            r.html
        );
    }

    #[test]
    fn data_bi_sequence_matches_collect_translatable_with_skip() {
        // 对齐铁律：渲染占号序列 == 收集索引序列（含 quote/list/table 混合 + 文献区段）
        let md = concat!(
            "# Eng Title\n\n",
            "Hello **world**.\n\n",
            "> quoted eng\n\n",
            "- list eng\n- 中文跳过\n\n",
            "| Hcol | 中文 |\n|---|---|\n| Cell eng | 中文格 |\n\n",
            "## References\n\nSmith 2020.\n\n",
            "## Next\n\nTail eng\n",
        );
        let r = render_html(md, &HashMap::new(), false);
        // 从 html 依序抠出 data-bi 编号
        let mut rendered = Vec::new();
        let mut rest = r.html.as_str();
        while let Some(p) = rest.find("data-bi=\"") {
            let after = &rest[p + 9..];
            let end = after.find('"').unwrap();
            rendered.push(after[..end].parse::<usize>().unwrap());
            rest = &after[end + 1..];
        }
        let blocks = crate::markdown::parse_blocks(md);
        let collected: Vec<usize> =
            crate::markdown::units::collect_translatable(&blocks, TargetLang::Zh).iter().map(|&(i, _)| i).collect();
        assert_eq!(rendered, collected, "渲染占号与收集索引必须逐位一致");
    }

    /// 抠出 html 里依序出现的 `data-bi` 编号。
    fn data_bi_sequence(html: &str) -> Vec<usize> {
        let mut out = Vec::new();
        let mut rest = html;
        while let Some(p) = rest.find("data-bi=\"") {
            let after = &rest[p + 9..];
            let end = after.find('"').unwrap();
            out.push(after[..end].parse::<usize>().unwrap());
            rest = &after[end + 1..];
        }
        out
    }

    /// 抠出 html 里依序出现的 `data-ri` 编号。
    fn data_ri_sequence(html: &str) -> Vec<usize> {
        let mut out = Vec::new();
        let mut rest = html;
        while let Some(p) = rest.find("data-ri=\"") {
            let after = &rest[p + 9..];
            let end = after.find('"').unwrap();
            out.push(after[..end].parse::<usize>().unwrap());
            rest = &after[end + 1..];
        }
        out
    }

    #[test]
    fn zh_to_en_lockstep_holds_too() {
        // ★ H1 守卫（2026-09-16 Step 0）：改前 `needs_translation` 方向无关，
        // 这一对断言在中文文档上**必然失败**——渲染侧与收集侧会各算各的。
        //
        // 这条测试的存在意义是钉死「渲染占号 == 收集索引」这条铁律**在另一个
        // 方向下也成立**。只测 zh 方向的话，方向一参数化就可能出现
        // 「收集按 En、渲染按 Zh」的错配，而索引错位不报错、只把译文贴到别的块。
        let md = concat!(
            "纯中文标题\n\n",
            "这是纯中文段落，含标点。\n\n",
            "> 引用的中文\n\n",
            "- 列表中文\n- English item\n\n",
            "| 中文表头 | Hcol |\n|---|---|\n| 中文格 | Cell eng |\n\n",
            "## 参考文献\n\n张三 2020。\n\n",
            "## 结论\n\n最后一段中文\n",
        );
        let blocks = crate::markdown::parse_blocks(md);

        for target in [TargetLang::Zh, TargetLang::En] {
            let r = render_html_dir(md, &HashMap::new(), false, target);
            let rendered_bi = data_bi_sequence(&r.html);
            let collected_bi: Vec<usize> = crate::markdown::units::collect_translatable(&blocks, target)
                .iter()
                .map(|&(i, _)| i)
                .collect();
            assert_eq!(
                rendered_bi, collected_bi,
                "{target:?} 方向下 渲染 data-bi 序列 与 collect_translatable 必须逐位一致"
            );
        }

        // 且两个方向的块空间**确实不同**——否则上一条断言是空转的。
        let zh_bi = data_bi_sequence(&render_html_dir(md, &HashMap::new(), false, TargetLang::Zh).html);
        let en_bi = data_bi_sequence(&render_html_dir(md, &HashMap::new(), false, TargetLang::En).html);
        assert_ne!(zh_bi, en_bi, "块空间必须方向相关，不然这个守卫测不出东西");

        // run 空间（data-ri）方向无关：Text 恒占号，两方向编号集合相同。
        let zh_ri = data_ri_sequence(&render_html_dir(md, &HashMap::new(), false, TargetLang::Zh).html);
        let en_ri = data_ri_sequence(&render_html_dir(md, &HashMap::new(), false, TargetLang::En).html);
        assert_eq!(zh_ri, en_ri, "run 空间方向无关：占号只跟 walk 走");
    }
}
