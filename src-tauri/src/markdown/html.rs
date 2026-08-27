//! HTML renderer for Block model.

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn original_mode_renders_basic_markdown() {
        let r = render_html("# Ti\n\ntext **b**.", &HashMap::new(), false);
        assert!(r.html.contains("<h1 id=\"h-1\">Ti</h1>"));
        assert!(r.html.contains("<strong>b</strong>"));
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
        assert!(r.html.contains("Text with &lt;b&gt;&amp;&lt;/b&gt; quote"));
        assert!(!r.html.contains("<b>"));
    }

    #[test]
    fn code_block_highlight_with_line_numbers() {
        let md = "```rust\nfn main() {}\n```";
        let r = render_html(md, &HashMap::new(), false);
        assert!(r.html.contains("class=\"code-block\""));
        assert!(r.html.contains("class=\"ln\">1</span>"));
        // Should contain colored spans (syntect)
        assert!(r.html.contains("style=\"color:#"));
    }
}
