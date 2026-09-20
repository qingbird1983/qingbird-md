//! 行内内容绘制（「给行内 write」）：HTML 转义与 inline 树上屏。
//! `push_inlines` 内 `Inline::Text` 的 sub_counter 推进是替换模式索引空间的
//! 唯一出处，由根模块的单次遍历在同一轮内调用——不引入第二轮渲染。

use std::fmt::Write;

use super::super::model::Inline;
use super::Ctx;

/// Escape all user-visible text and attribute values so no markdown or file
/// content can ever inject markup into the preview DOM.
pub(super) fn escape_html(s: &str) -> String {
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

impl Ctx<'_> {
    /// Shared inline painter for original + substituted modes. Every
    /// `Inline::Text` advances `sub_counter`, matching
    /// `units::collect_text_runs`' walk run-for-run.
    pub(super) fn push_inlines(&mut self, out: &mut String, ils: &[Inline]) {
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
}
