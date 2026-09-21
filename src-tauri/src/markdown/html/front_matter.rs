//! 文首 YAML front matter → 只读键值表。
//!
//! 动机：`Block::Metadata` 曾经被整块丢弃，于是靠 `name`/`description` 承载语义
//! 的文档（SKILL.md、Jekyll/Hugo 文章）在预览里读起来是残缺的。现在按主流
//! Markdown 站点的做法渲染成「key | value 两列」。
//!
//! **刻意不引入 YAML 解析器**：完整 YAML 的多行块标量、嵌套映射、数组、引号
//! 转义都是坑，而这里的失败模式极不对称——解析器不认识的写法会被**吞掉**，
//! 而「被吞」正是这次要修的病。所以只做「本行是不是 `key: value`」这一个判定，
//! 判定失败的走续行/原样行分支，保证**每个非空源行都有落点**。
//!
//! 计数器一律不动：元数据不装 `Inline`，既不占 run 号也不占 `data-bi`，更没有
//! 译文可贴（YAML 的 key 是代码，不该翻译）。

use super::inline::escape_html;

/// 一行元数据。`key` 为空表示该源行不符合 `key: value`，渲染时整行跨两列。
struct Row {
    key: String,
    value: String,
}

/// 渲染成 `<table class="front-matter">`。恒产出一个元素——`<!--sl:N-->` 注释
/// 是配给**紧随其后的第一个元素节点**的，没有元素这条锚点就悬空。
pub(super) fn render(out: &mut String, raw: &str) {
    out.push_str(r#"<table class="front-matter"><tbody>"#);
    for r in parse_rows(raw) {
        if r.key.is_empty() {
            // 不是 `key: value` 的源行（顶部注释、纯标量、坏缩进……）原样整行
            // 显示。宁可不好看，也不能把用户写的元数据吃掉。
            out.push_str(r#"<tr><td colspan="2">"#);
            out.push_str(&escape_html(&r.value));
            out.push_str("</td></tr>");
        } else {
            out.push_str("<tr><th>");
            out.push_str(&escape_html(&r.key));
            out.push_str("</th><td>");
            // 值里可能带 `\n`（多行块标量/续行）；`td` 上挂了 `white-space:
            // pre-wrap`，直接原样输出即可。**本行不留换行**：换行一旦落进 td，
            // pre-wrap 会把它渲染成一个空行。
            out.push_str(&escape_html(&r.value));
            out.push_str("</td></tr>");
        }
    }
    out.push_str("</tbody></table>");
}

/// 拆行。规则见模块头：只认 `key: value`，其余一律不丢。
fn parse_rows(raw: &str) -> Vec<Row> {
    let lines: Vec<&str> = raw.lines().collect();
    // 首行 `---` 是 front matter 的语法边界，不是元数据内容。用「首行确实是
    // 分隔符才跳过」而不是无条件 `skip(1)`：后者在 raw 不带分隔符时会把
    // 第一行元数据丢掉，那正是本模块要防的失败模式。
    let start = usize::from(lines.first().map(|l| is_fence(l)).unwrap_or(false));
    let mut rows: Vec<Row> = Vec::new();
    for line in &lines[start..] {
        if is_fence(line) || line.trim().is_empty() {
            continue; // 收尾 `---` 与空行都只是分隔语法
        }
        match split_kv(line) {
            Some((k, v)) => rows.push(Row {
                key: k.to_string(),
                value: v.trim().to_string(),
            }),
            // 缩进续行（多行块标量 `|`）、嵌套子键、数组项 `- x`：接到上一行
            // 的值里，逐行保留。
            None => match rows.last_mut() {
                Some(last) => {
                    if !last.value.is_empty() {
                        last.value.push('\n');
                    }
                    last.value.push_str(line.trim_end());
                }
                // 首个就不是 `key: value`（整块是标量/注释）：原样成行
                None => rows.push(Row {
                    key: String::new(),
                    value: line.trim_end().to_string(),
                }),
            },
        }
    }
    rows
}

fn is_fence(line: &str) -> bool {
    line.trim() == "---"
}

/// `key: value` 的极简判定：要求冒号前**不含空白**。这一条同时挡掉了缩进子键
/// （`  nested: x`）、数组项与带空格的注释行（`# note: x`）——它们都落到续行
/// 分支，内容不丢。值的形态不限：`https://a.com/x:y` 里的冒号由 `split_once`
/// 的「首个冒号」语义正确处理。
fn split_kv(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once(':')?;
    (!k.is_empty() && !k.contains(char::is_whitespace)).then_some((k, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(raw: &str) -> String {
        let mut out = String::new();
        render(&mut out, raw);
        out
    }

    #[test]
    fn renders_key_value_rows() {
        let out = html(
            "---\nname: ask-matt\ndescription: Router over skills.\n\
             disable-model-invocation: true\n---\n",
        );
        assert_eq!(
            out,
            r#"<table class="front-matter"><tbody>"#
                .to_string()
                + "<tr><th>name</th><td>ask-matt</td></tr>"
                + "<tr><th>description</th><td>Router over skills.</td></tr>"
                + "<tr><th>disable-model-invocation</th><td>true</td></tr>"
                + "</tbody></table>",
            "{out}"
        );
        // 分隔符 `---` 是语法，不进表格
        assert!(!out.contains("---"), "{out}");
    }

    #[test]
    fn value_keeps_colons_and_urls_intact() {
        // 只按**首个**冒号切分：值里的冒号、URL 原样保留
        let out = html("---\nhomepage: https://example.com/a:b\nnote: fix bug: later\n---\n");
        assert!(out.contains("<td>https://example.com/a:b</td>"), "{out}");
        assert!(out.contains("<td>fix bug: later</td>"), "{out}");
    }

    #[test]
    fn continuation_and_nested_lines_are_kept() {
        // 多行块标量（缩进续行）、嵌套子键、数组项都不能丢
        let out = html(
            "---\ndescription: |\n  line one\n  line two\ntags:\n  - a\n  - b\n---\n",
        );
        assert!(
            out.contains("<th>description</th><td>|\n  line one\n  line two</td>"),
            "{out}"
        );
        // `tags:` 的值本来是空的，故第一条数组项不额外顶一个空行（见 parse_rows）
        assert!(out.contains("<th>tags</th><td>  - a\n  - b</td>"), "{out}");
    }

    #[test]
    fn no_source_line_is_lost() {
        // 「被吞」正是本次要修的病，所以逐行钉。`key: value` 行在输出里被拆成
        // `<th>key</th><td>value</td>`（字面整行不会出现），故分别断言 key 与
        // value；其余行（注释/标量/数组项/续行）是原样保留的，可整行断言。
        for raw in [
            "---\nname: x\n---\n",
            "---\n  nested: x\n  - hmm\n---\n",
            "---\njust-a-scalar\n---\n",
            "---\n# a comment\nname: x\n---\n",
            "---\na: 1\nb: |\n  multi\n  line\nc: 3\n---\n",
        ] {
            let out = html(raw);
            for line in raw.lines() {
                let t = line.trim();
                if t.is_empty() || t == "---" {
                    continue;
                }
                match split_kv(line) {
                    Some((k, v)) => {
                        assert!(out.contains(k), "键被吞 {k:?}\nraw={raw:?}\nout={out}");
                        let v = v.trim();
                        if !v.is_empty() {
                            assert!(out.contains(v), "值被吞 {v:?}\nraw={raw:?}\nout={out}");
                        }
                    }
                    None => assert!(out.contains(t), "源行被吞 {t:?}\nraw={raw:?}\nout={out}"),
                }
            }
        }
    }

    #[test]
    fn html_in_values_is_escaped() {
        // 元数据里的尖括号必须转义：否则 `desc: <b>x</b>` 会被当标签解析，
        // 元数据块能把后面的正文整段吃掉。
        let out = html("---\ndesc: <b>&</b>\ntitle: \"x < y\"\n---\n");
        assert!(!out.contains("<b>"), "尖括号必须转义: {out}");
        assert!(out.contains("&lt;b&gt;&amp;&lt;/b&gt;"), "{out}");
        assert!(out.contains("&lt; y"), "{out}");
    }

    #[test]
    fn degenerate_front_matter_still_yields_an_element() {
        // `---\n---`：仍要产出一个元素。`<!--sl:N-->` 注释是配给它后面第一个
        // 元素节点的，没有元素这条锚点就悬空。
        assert_eq!(
            html("---\n---\n"),
            r#"<table class="front-matter"><tbody></tbody></table>"#
        );
    }
}
