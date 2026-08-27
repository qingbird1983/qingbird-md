//! Pure Markdown editing operations (bold/italic/heading/list/…), applied to
//! the document text given a byte selection. egui-free and unit-testable.

/// Apply a formatting operation `op` to `content` given the byte selection
/// `(start, end)`. Returns `(new_content, new_selection)`.
pub fn apply_op(content: &str, sel: (usize, usize), op: &str) -> (String, (usize, usize)) {
    let (s, e) = clamp_sel(content.len(), sel);
    let selected = &content[s..e];
    let before = content[..s].to_string();
    let after = content[e..].to_string();

    match op {
        "bold" => wrap(&before, &after, selected, "**", "**", "粗体"),
        "italic" => wrap(&before, &after, selected, "*", "*", "斜体"),
        "strike" => wrap(&before, &after, selected, "~~", "~~", "删除线"),
        "code" => wrap(&before, &after, selected, "`", "`", "代码"),
        "link" => wrap(&before, &after, selected, "[", "](https://)", "链接文字"),
        "image" => wrap(&before, &after, selected, "![", "](https://)", "图片描述"),
        "h1" => line_prefix(content, sel, "# "),
        "h2" => line_prefix(content, sel, "## "),
        "h3" => line_prefix(content, sel, "### "),
        "ul" => line_prefix(content, sel, "- "),
        "ol" => line_prefix(content, sel, "1. "),
        "task" => line_prefix(content, sel, "- [ ] "),
        "quote" => line_prefix(content, sel, "> "),
        "codeblock" => {
            let body = if selected.is_empty() { "在此输入代码" } else { selected };
            (format!("{before}\n```\n{body}\n```\n{after}"), (s, e))
        }
        "table" => {
            let t = "\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 单元格 | 单元格 | 单元格 |\n| 单元格 | 单元格 | 单元格 |\n";
            (format!("{before}{t}{after}"), (s, e))
        }
        "hr" => (format!("{before}\n\n---\n\n{after}"), (s, e)),
        _ => (content.to_string(), sel),
    }
}

fn clamp_sel(len: usize, sel: (usize, usize)) -> (usize, usize) {
    let s = sel.0.min(len);
    let e = sel.1.min(len).max(s);
    (s, e)
}

/// Wrap `selected` with `pre`/`post`; if not selected, insert `placeholder`.
fn wrap(before: &str, after: &str, selected: &str, pre: &str, post: &str, placeholder: &str) -> (String, (usize, usize)) {
    let s = before.len() + pre.len();
    if selected.is_empty() {
        let e = s + placeholder.len();
        (format!("{before}{pre}{placeholder}{post}{after}"), (s, e))
    } else {
        let e = s + selected.len();
        (format!("{before}{pre}{selected}{post}{after}"), (s, e))
    }
}

/// Prefix the current line (the line containing the selection start) with
/// `prefix`, applied to each line the selection spans.
fn line_prefix(content: &str, sel: (usize, usize), prefix: &str) -> (String, (usize, usize)) {
    let (s, e) = clamp_sel(content.len(), sel);
    let bytes = content.as_bytes();
    let line_start = bytes[..s].iter().rposition(|&b| b == b'\n').map(|p| p + 1).unwrap_or(0);
    let mut line_end = e;
    if let Some(p) = bytes[e..].iter().position(|&b| b == b'\n') {
        line_end = e + p;
    }
    let block = &content[line_start..line_end];
    let lines: Vec<&str> = block.split('\n').collect();
    let inner = lines.iter().map(|l| format!("{prefix}{l}")).collect::<Vec<_>>().join("\n");
    let new = format!("{}{}{}", &content[..line_start], inner, &content[line_end..]);
    (new, (line_start + prefix.len(), line_start + prefix.len() + inner.len() - prefix.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bold_wraps_selection() {
        let (new, _) = apply_op("hello world", (0, 5), "bold");
        assert_eq!(new, "**hello** world");
    }

    #[test]
    fn bold_inserts_placeholder() {
        let (new, _sel) = apply_op("abc", (1, 1), "bold");
        assert_eq!(new, "a**粗体**bc");
    }

    #[test]
    fn heading_prefixes_line() {
        let (new, _) = apply_op("title\nbody", (0, 5), "h1");
        assert!(new.starts_with("# title\n"));
    }

    #[test]
    fn unordered_list_prefixes_each_line() {
        let (new, _) = apply_op("a\nb", (0, 3), "ul");
        assert_eq!(new, "- a\n- b");
    }

    #[test]
    fn quote_prefixes() {
        let (new, _) = apply_op("quote", (0, 5), "quote");
        assert_eq!(new, "> quote");
    }
}
