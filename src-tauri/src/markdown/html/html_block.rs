//! 块级 HTML → **净化后**上屏。
//!
//! 动机：[`Block::Html`] 此前落进 `consume_block` 的 `_ =>` 兜底成空段落，于是
//! 富文本编辑器（tiptap / Notion / Word 导出）粘进 Markdown 的表格、卡片整块
//! 消失——用户看到的就是「前面的内容被丢弃了」。
//!
//! # 为什么不能原样输出（这条是本模块存在的全部理由）
//!
//! `PreviewView.tsx` / `previewInject.ts` 的文件头都写明了 XSS 信任边界：
//! 「容器 innerHTML 的字符串生产者**唯一**是 `markdown/html.rs`」——所以渲染层
//! 必须自己保证产出里没有可执行物。行内 HTML（`Event::InlineHtml`）至今仍是丢弃的，
//! 本模块是唯一让文档自带标签进 DOM 的通道，放行就等于把边界交给文档作者。
//!
//! # 策略：白名单 + 保内容
//!
//! - **标签**：只放行 [`ALLOWED`]（结构 + 排版，全是无行为标签）；
//! - **属性**：只留 `th`/`td` 上的数字型 `colspan`/`rowspan`。`class`/`style`/`id`
//!   全丢——`style="position:fixed;inset:0"` 能糊住整个应用界面，`on*` 与
//!   `href="javascript:"` 更是直接执行入口；而这两个数字属性不可能承载脚本，
//!   且丢了表格合并单元格会错版，所以单独留出这一条**窄通道**；
//! - **文本**：一律 [`escape_html`]，产出里除白名单标签外不存在裸 `<`；
//! - **非白名单标签**：**只丢标签、保留其中文字**（内容丢失才是要修的病）。
//!   唯一例外是 [`DROP_CONTENT`]——那些元素的「文字」是脚本/CSS/原始标记本身，
//!   留下来只会变成一屏乱码。它们丢到配对闭标签为止；未闭合则丢到本块末尾
//!   （与浏览器同规，但**作用域仅限本 HTML 块**，不会越块吃掉后面正文）。
//!
//! 计数器一律不动：`Block::Html` 不装 `Inline`，既不占 run 号（`data-ri`）
//! 也不占块号（`data-bi`）——HTML 标签不是自然语言，没有可贴译文的位置。

use std::fmt::Write;

/// 放行的标签（小写，结构 + 排版，均无行为）。
const ALLOWED: &[&str] = &[
    "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup",
    "code", "pre", "kbd", "samp", "var", "span", "div", "blockquote", "small", "abbr",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "figure", "figcaption", "details", "summary",
];

/// **连内容一起**丢弃的元素：它们的「文字」是脚本/CSS/原始标记，留着只是乱码。
/// 表内元素在文档里总是成对出现，丢到配对闭标签即可（见模块头对未闭合的说明）。
const DROP_CONTENT: &[&str] = &[
    "script", "style", "iframe", "frame", "frameset", "noscript", "template",
    "textarea", "title", "svg", "math", "canvas", "object", "applet", "marquee",
];

/// 渲染成本模块的固定外壳。**恒产出一个元素**：`<!--sl:N-->` 注释是配给紧随其后的
/// 第一个元素节点的，内容被净化干净（整块就是个 `<script>`）时若什么都不输出，
/// 那条锚点就悬空了。
pub(super) fn render(out: &mut String, raw: &str) {
    out.push_str(r#"<div class="html-block">"#);
    out.push_str(&sanitize(raw));
    out.push_str("</div>");
}

/// 扫描净化。**安全性断言**：产出只可能包含白名单标签、我们自己写出的数字属性、
/// 以及 [`escape_html`] 转义过的文本。
fn sanitize(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::new();
    let mut text_start = 0usize; // 待转义的裸文本起点
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // 注释 / `<!DOCTYPE>` / `<?…?>`：整段丢弃（注释里可以有 `>`，不能走 tag_end）
        if raw[i..].starts_with("<!--") {
            push_escaped(&mut out, &raw[text_start..i]);
            i = find_ci(raw, "-->", i + 4).map_or(bytes.len(), |p| p + 3);
            text_start = i;
            continue;
        }
        if raw[i + 1..].starts_with(['!', '?']) {
            push_escaped(&mut out, &raw[text_start..i]);
            i = tag_end(raw, i + 1).map_or(bytes.len(), |e| e + 1);
            text_start = i;
            continue;
        }
        let Some(end) = tag_end(raw, i + 1) else {
            // 未闭合的 `<`：留作文本（转义后可见），内容不丢
            i += 1;
            continue;
        };
        let tag = &raw[i + 1..end];
        let closing = tag.starts_with('/');
        let name = tag_name(tag);
        // `<` 后面不是标签名（`3 < 5`、`<3`、`</>`）：按浏览器规则当**字面文本**，
        // 只把下标推进一格，`text_start` 不动——这段会随收尾转义一起出去。
        // 少了这一步，`< 5 且 a >` 会被当成一个无名标签整段吃掉（内容丢失）。
        if name.is_empty() {
            i += 1;
            continue;
        }
        push_escaped(&mut out, &raw[text_start..i]);
        i = end + 1;
        text_start = i;

        if DROP_CONTENT.contains(&name.as_str()) {
            if !closing {
                let close = format!("</{name}");
                i = match find_ci(raw, &close, i) {
                    Some(p) => tag_end(raw, p + 1).map_or(bytes.len(), |e| e + 1),
                    None => bytes.len(),
                };
                text_start = i;
            }
            continue;
        }
        if !ALLOWED.contains(&name.as_str()) {
            continue; // 只丢标签，文字留着
        }
        out.push('<');
        if closing {
            out.push('/');
        }
        out.push_str(&name);
        // 唯一的属性通道：合并单元格的列/行跨度。丢了它表格会错版。
        if !closing && matches!(name.as_str(), "th" | "td") {
            for attr in ["colspan", "rowspan"] {
                if let Some(n) = span_attr(tag, attr) {
                    let _ = write!(out, r#" {attr}="{n}""#);
                }
            }
        }
        out.push('>');
    }
    push_escaped(&mut out, &raw[text_start..]);
    out
}

/// 标签名：跳过 `/`，取到第一个非字母数字为止（`<br/>` → `br`，`</td >` → `td`）。
/// **首字符必须是 ASCII 字母**，否则返回空串——HTML 分词在这里也一样：`<` 后面跟
/// 空格/数字（`3 < 5`、`<3`）不算标签开头，是字面文本。返回空串时调用方按文本处理，
/// 不能当标签吃掉后面的内容。
fn tag_name(tag: &str) -> String {
    let name = tag
        .trim_start_matches('/')
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect::<String>();
    if name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        name.to_ascii_lowercase()
    } else {
        String::new()
    }
}

/// 从 `from` 起找标签的 `>`，引号内的 `>` 不算（`<td title="a>b">`）。
fn tag_end(raw: &str, from: usize) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (i, &c) in raw.as_bytes().iter().enumerate().skip(from) {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == b'"' || c == b'\'' => quote = Some(c),
            None if c == b'>' => return Some(i),
            None => {}
        }
    }
    None
}

/// ASCII 大小写不敏感的子串查找（`</SCRIPT>` 也要认出来），返回字节下标。
fn find_ci(hay: &str, needle: &str, from: usize) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    if n.is_empty() || h.len() < n.len() {
        return None;
    }
    (from.min(h.len())..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// 取 `colspan`/`rowspan` 的十进制值，钳在 1..=100。只认数字——这是白名单里
/// 唯一的属性通道，必须窄到不可能承载脚本。非数字/越界一律丢弃该属性。
fn span_attr(tag: &str, attr: &str) -> Option<u16> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(p) = lower.get(from..)?.find(attr) {
        let at = from + p;
        // 属性名必须以空白/标签开头为界：否则 `data-colspan="3"` 会被当成
        // `colspan`（前一个字符是 `-`），凭空多出一个我们自己写的属性。
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = lower[at + attr.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            // 值可能带引号（`colspan="3"` / `colspan='3'`），先剥掉再取数字
            let val = rest[1..].trim_start();
            let val = val.strip_prefix(['"', '\'']).unwrap_or(val);
            let digits: String = val.chars().take_while(char::is_ascii_digit).collect();
            let n: u32 = digits.parse().ok()?;
            return u16::try_from(n.clamp(1, 100)).ok();
        }
        from = at + attr.len();
    }
    None
}

fn push_escaped(out: &mut String, text: &str) {
    if !text.is_empty() {
        out.push_str(&escape_text_node(text));
    }
}

/// **文本节点**专用的转义：只转尖括号，**`&` 原样留着**。
///
/// 为什么不复用 `inline::escape_html`（它把 `&` 一并转掉）：
/// HTML 分词在 data 状态里把字符引用解成**字符**，这些字符不会再被重新分词成
/// 标签——`&lt;script&gt;` 落进 DOM 就是一段纯文本，不可能变成元素。反过来把 `&`
/// 转掉，Word / Google Docs 粘贴进来的 `&nbsp;` / `&#8203;` 会原样显示成实体
/// 字面量，而修好这类文档正是本模块的初衷。裸 `&` 在 HTML 里本就只是普通字符。
/// 已用真实浏览器实测（`&lt;script&gt;` / `&#x3c;script&#x3e;` 均不成元素、不执行）。
///
/// ⚠️ **只能用于标签之间的文本节点，绝不可用于属性值**：留着的 `&` 在属性上下文里
/// 会被解码，`&quot;` 能直接闭合属性、越出引号。属性在本模块只有数字型
/// `colspan`/`rowspan` 一条通道，由 [`span_attr`] 自己写，不经此处。
fn escape_text_node(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(raw: &str) -> String {
        let mut out = String::new();
        render(&mut out, raw);
        out
    }

    /// 真实病历：`UI 设计师.md` 第 3 行的 tiptap 表格。结构必须完整留下
    /// （否则字符卡读不成表），而 `class`/`style`/`colwidth` 这些编辑器私有
    /// 属性必须一个不剩。
    #[test]
    fn tiptap_table_keeps_structure_and_drops_editor_attrs() {
        let raw = r#"<table class="tiptap-table" style="min-width: 126px;"><colgroup><col style="width: 101px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" colwidth="101"><p><strong>名称</strong></p></th><td colspan="1" rowspan="1"><p>UI设计师</p></td></tr><tr><th><p><strong>颜色</strong></p></th><td><p>紫色</p></td></tr></tbody></table>
"#;
        let out = html(raw);
        assert!(out.starts_with(r#"<div class="html-block">"#), "{out}");
        for keep in ["<table>", "<colgroup>", "<tbody>", "<tr>", "<th", "<td", "<strong>"] {
            assert!(out.contains(keep), "结构标签被丢 {keep}: {out}");
        }
        for needle in ["名称", "UI设计师", "颜色", "紫色"] {
            assert!(out.contains(needle), "文字被丢 {needle}: {out}");
        }
        assert!(out.contains(r#"<th colspan="1" rowspan="1">"#), "合并跨度须保留: {out}");
        // 我们自己的外壳 class 之外，属性面必须是空的——编辑器私有属性一个不剩
        let inner = out.replace(r#"<div class="html-block">"#, "");
        for gone in ["class=", "style=", "colwidth", "tiptap-table", "min-width"] {
            assert!(!inner.contains(gone), "编辑器私有属性必须剥掉 {gone}: {inner}");
        }
    }

    /// 脚本与样式**连内容**一起消失——留下 JS/CSS 源码只是一屏乱码。
    #[test]
    fn script_and_style_are_dropped_with_their_content() {
        let out = html(r#"<div><script>alert('x')</script><style>p{color:red}</style><p>正文</p></div>"#);
        assert!(!out.contains("alert"), "{out}");
        assert!(!out.contains("color:red"), "{out}");
        assert!(out.contains("<p>正文</p>"), "{out}");
        assert!(!out.contains("<script"), "{out}");
    }

    /// 事件处理器与 `javascript:` 链接没有任何到达 DOM 的路径：属性全剥，
    /// 非白名单标签（`a`）只丢标签、文字留着。
    #[test]
    fn attributes_and_event_handlers_cannot_reach_the_dom() {
        let out = html(r#"<p onclick="steal()" style="position:fixed">hi</p><a href="javascript:evil()">点我</a>"#);
        assert!(!out.contains("onclick"), "{out}");
        assert!(!out.contains("javascript:"), "{out}");
        assert!(!out.contains("href"), "{out}");
        assert!(out.contains("<p>hi</p>"), "{out}");
        assert!(out.contains("点我"), "非白名单标签的文字必须保留: {out}");
    }

    /// 裸文本里的尖括号必须转义——否则「净化」反而成了注入通道。
    /// `&` 故意留着（见 [`escape_text_node`]）：实体在 data 状态里只会解成字符。
    #[test]
    fn text_is_escaped_so_no_raw_markup_leaks() {
        let out = html("<div>a &lt;script&gt; b</div>");
        assert!(out.contains("a &lt;script&gt; b"), "{out}");
        assert!(!out.contains("<script"), "产出的 `<` 只可能来自白名单标签: {out}");

        // 实体不能被二次转义（`&nbsp;` 要真的渲染成不换行空格）
        let nbsp = html("<p>甲&nbsp;乙</p>");
        assert!(nbsp.contains("&nbsp;"), "{nbsp}");
        assert!(!nbsp.contains("&amp;nbsp;"), "{nbsp}");

        // 裸 `<` 落进文本（非法 HTML）时转义，不产生新标签
        let stray = html("<p>3 < 5 且 a > b</p>");
        assert!(stray.contains("3 &lt; 5 且 a &gt; b"), "{stray}");
    }

    #[test]
    fn entities_cannot_smuggle_markup_in() {
        // `&#x3c;` / `&#60;` 解出来是字符、不再分词；这里断言它们**没被我们**转成
        // 标签，也不破坏外壳结构。
        for raw in ["<p>&#x3c;script&#x3e;x</p>", "<p>&#60;b&#62;</p>"] {
            let out = html(raw);
            assert!(out.starts_with(r#"<div class="html-block">"#), "{out}");
            assert!(out.ends_with("</div>"), "{out}");
            assert_eq!(out.matches('<').count(), out.matches('>').count(), "{out}");
        }
    }

    #[test]
    fn comments_and_doctype_are_dropped() {
        let out = html("<!DOCTYPE html><!-- 注释里的 > 不能吃掉后面 --><p>正文</p>");
        assert!(!out.contains("注释"), "{out}");
        assert!(!out.contains("DOCTYPE"), "{out}");
        assert!(out.contains("<p>正文</p>"), "{out}");
    }

    /// 跨度只认数字且钳在 1..=100：`colspan=">999999"` 之类不许改写属性面。
    #[test]
    fn span_attributes_are_numeric_only() {
        assert_eq!(span_attr(r#" colspan="3" "#, "colspan"), Some(3));
        assert_eq!(span_attr(r#" colSpan='2' "#, "colspan"), Some(2));
        assert_eq!(span_attr(r#" colspan="9999" "#, "colspan"), Some(100));
        assert_eq!(span_attr(r#" colspan="abc" "#, "colspan"), None);
        assert_eq!(span_attr(r#" data-colspan="3" "#, "colspan"), None);
        assert_eq!(span_attr("", "colspan"), None);
    }

    /// 恒产出一个元素：整块都是脚本时，外壳仍在——`<!--sl:N-->` 才不会悬空。
    #[test]
    fn always_yields_an_element() {
        assert_eq!(html("<script>x</script>"), r#"<div class="html-block"></div>"#);
        assert_eq!(html(""), r#"<div class="html-block"></div>"#);
    }

    /// 未闭合的 `<script>` 丢到本块末尾（与浏览器同规），但**不越块**：调用方
    /// 一次只交一个块进来，后面的正文不受影响。
    #[test]
    fn unterminated_drop_content_stops_at_block_end() {
        let out = html("<script>never closed");
        assert_eq!(out, r#"<div class="html-block"></div>"#);
    }

    /// 与渲染主循环的集成：净化产物必须**紧跟在 `<!--sl:N-->` 后面**（锚点是配给
    /// 下一个元素节点的），且原来的空段落消失。放这里而不是 `html_tests.rs`：
    /// 那份文件已顶在 700 行总量线上，一行都加不得。
    #[test]
    fn render_html_integrates_the_sanitized_block() {
        let md = "---\n\n<table class=\"tiptap-table\"><tr><th>名称</th><td>UI设计师</td></tr></table>\n\n# Title\n";
        let r = crate::markdown::html::render_html(
            md,
            &std::collections::HashMap::new(),
            false,
            crate::translate::engine::TargetLang::Zh,
        );
        assert!(
            r.html.contains(r#"<!--sl:3--><div class="html-block"><table>"#),
            "锚点必须贴住净化后的元素: {}",
            r.html
        );
        assert!(r.html.contains("UI设计师"), "{}", r.html);
        assert!(!r.html.contains("<p></p>"), "不得再出现空段落: {}", r.html);
        // 块级 HTML 不占号：整篇只有标题一个 data-bi / 一个 data-ri
        assert_eq!(r.html.matches("data-bi=").count(), 1, "{}", r.html);
        assert_eq!(r.html.matches("data-ri=").count(), 1, "{}", r.html);
    }
}
