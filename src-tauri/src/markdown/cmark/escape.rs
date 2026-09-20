//! 纯转义函数（零状态）：块级前缀转义、Markdown 文本转义、行内代码围串、
//! 围栏长度与行前缀。供 writer 按 `super::escape::` 引用。

/// 段落类内容（段落/标题/列表项/表格单元格）**行首**的块级前缀转义。
///
/// `escape_md` 不转义 `-`/`+`/`=`/数字——它们在正文中间极常见（`well-known`、
/// `1.5`），全转义会让源码很脏。但落在行首就会变成列表/分割线/setext 标题，
/// 把结构改掉，所以只在这一处补。
pub(super) fn block_start(s: &str) -> String {
    match s.chars().next() {
        Some('-') | Some('+') | Some('=') => format!("\\{s}"),
        Some(c) if c.is_ascii_digit() => {
            let rest = &s[1..];
            let nd = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
            let after = &rest[nd..];
            let ordered = (after.starts_with('.') || after.starts_with(')'))
                && matches!(after[1..].chars().next(), Some(' ') | Some('\t'));
            if !ordered {
                return s.to_string();
            }
            let at = 1 + nd;
            let mut out = String::with_capacity(s.len() + 1);
            out.push_str(&s[..at]);
            out.push('\\');
            out.push_str(&s[at..]);
            out
        }
        _ => s.to_string(),
    }
}

/// Markdown 文本转义。`in_table` 时额外带上 `|`（单元格里的裸 `|` 会多切一列）。
pub(super) fn escape_md(s: &str, in_table: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '~' | '#')
            || (in_table && c == '|')
        {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 行内代码围串：内容里的连续反引号若 ≥3 个，围串要比它长（且首尾带空格）。
pub(super) fn code_span(c: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for ch in c.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat((longest + 1).max(1));
    if c.starts_with('`') || c.ends_with('`') || longest > 0 {
        format!("{fence} {c} {fence}")
    } else {
        format!("{fence}{c}{fence}")
    }
}

/// 围栏长度：代码里若已有 ≥3 个连续反引号的行，围栏要比它长。
pub(super) fn fence_for(code: &str) -> String {
    let mut n = 3usize;
    for line in code.lines() {
        let t = line.trim_start();
        if t.starts_with("```") {
            n = n.max(t.chars().take_while(|&c| c == '`').count() + 1);
        }
    }
    "`".repeat(n)
}

/// 给每行加前缀；空行只留前缀的裁剪形态（引用块的 `>`、列表缩进的空）。
pub(super) fn prefix_lines(text: &str, prefix: &str) -> String {
    let bare = prefix.trim_end();
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                bare.to_string()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    // 两个转义守卫走 export_translation 公共面（转义行为经 writer 生效），
    // 故经 cmark 根再导出取用；模型/收集侧导入为断言服务。
    use crate::markdown::cmark::export_translation;
    use crate::markdown::model::parse_blocks;
    use crate::markdown::units::collect_text_runs;
    use crate::translate::engine::TargetLang;

    const ZH: TargetLang = TargetLang::Zh;

    /// 译文里的 Markdown 特殊字符必须被转义，否则用户拿到的文件结构会破。
    #[test]
    fn translation_metachars_are_escaped() {
        let md = "Hello world";
        let map = HashMap::from([(0usize, "a*b_c[d]e#f".to_string())]);
        let out = export_translation(md, &map);
        assert!(out.contains(r"a\*b\_c\[d\]e\#f"), "特殊字符需转义: {out}");
        // 表格单元格里的 `|` 会多切一列，必须转义
        let md2 = "| a |\n| --- |\n| x |";
        let cell_run = collect_text_runs(&parse_blocks(md2), ZH)[0].0;
        let out2 = export_translation(md2, &HashMap::from([(cell_run, "p|q".to_string())]));
        assert!(out2.contains(r"p\|q"), "单元格竖线需转义: {out2}");
    }

    /// 行首危险前缀（会被误认成列表/分割线/setext 标题）要转义。
    #[test]
    fn block_start_prefixes_are_escaped() {
        let map = HashMap::from([(0usize, "- dash led".to_string())]);
        let out = export_translation("Hello", &map);
        assert!(out.starts_with(r"\- dash led"), "{out}");
        let map2 = HashMap::from([(0usize, "1. ordered led".to_string())]);
        let out2 = export_translation("Hello", &map2);
        assert!(out2.starts_with(r"1\. ordered led"), "{out2}");
    }
}
