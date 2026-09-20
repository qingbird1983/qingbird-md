//! 代码块绘制（「给代码块 write」）：syntect 高亮行拆分、代码卡片开标签
//! 与列对齐样式片段。

use std::fmt::Write;

use syntect::highlighting::Color;

use super::inline::escape_html;
use crate::markdown::syntax::highlight_spans;
use super::Ctx;

impl Ctx<'_> {
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
    pub(super) fn push_code_block(&self, out: &mut String, lang: Option<&str>, code: &str) {
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
pub(super) fn align_style(a: u8) -> &'static str {
    match a {
        1 => " style=\"text-align:center\"",
        2 => " style=\"text-align:right\"",
        _ => "",
    }
}
