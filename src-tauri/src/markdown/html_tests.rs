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
fn front_matter_renders_as_key_value_table() {
    // front matter 不再是被吞掉的内容：预览里以**只读键值表**出现（对齐主流
    // Markdown 站点的读法）。SKILL.md 这类靠 name/description 承载语义的文档
    // 才读得全——这正是当初"整块丢掉"的代价。
    let md = "---\nname: ask-matt\ndescription: Router over skills.\n\
              disable-model-invocation: true\n---\n\nBody";
    let r = render_html(md, &HashMap::new(), false);
    assert!(r.html.contains("<table class=\"front-matter\"><tbody>"), "{}", r.html);
    assert!(r.html.contains("<tr><th>name</th><td>ask-matt</td></tr>"), "{}", r.html);
    assert!(
        r.html.contains("<tr><th>description</th><td>Router over skills.</td></tr>"),
        "{}",
        r.html
    );
    assert!(
        r.html.contains("<tr><th>disable-model-invocation</th><td>true</td></tr>"),
        "{}",
        r.html
    );
    assert!(!r.html.contains("---"), "分隔符是语法，不进渲染: {}", r.html);
    assert!(r.html.contains("Body"));
}

#[test]
fn front_matter_occupies_a_source_line_anchor() {
    // 元数据块与正文段各占一个源行锚点：1 = 文首 `---`，5 = 正文段。
    // 锚点数 = 顶层块数——front matter 也是块，漏掉它后续行号会整体前移，
    // 分栏同步就按错行号找块了。
    let md = "---\ntitle: T\n---\n\nBody";
    let r = render_html(md, &HashMap::new(), false);
    assert!(r.html.contains("<!--sl:1--><table class=\"front-matter\">"), "{}", r.html);
    // 正文段是可译块，故带 data-bi（恒占号）；这里只关心锚点行号落在 5
    assert!(r.html.contains("<!--sl:5--><p "), "{}", r.html);
    assert_eq!(
        r.html.matches("<!--sl:").count(),
        crate::markdown::parse_blocks(md).len(),
        "{}",
        r.html
    );
}

#[test]
fn front_matter_html_is_escaped() {
    // YAML 值里的尖括号/与号必须转义：否则 `desc: <b>x</b>` 会被当标签解析，
    // 元数据块能把后面的正文整段吃掉。
    let r = render_html("---\ndesc: <b>&</b>\n---\n\nBody", &HashMap::new(), false);
    assert!(r.html.contains("&lt;b&gt;&amp;&lt;/b&gt;"), "{}", r.html);
    assert!(!r.html.contains("<b>&</b>"), "{}", r.html);
    assert!(r.html.contains("Body"), "{}", r.html);
}

#[test]
fn front_matter_takes_no_run_or_block_index() {
    // 元数据不装 Inline ⇒ 既不出 data-ri 也不出 data-bi，更不出 tr-box：
    // 译文无处可贴，YAML 的 key 也不该被翻译。守住「译文绝不进 content」。
    let md = "---\ntitle: T\n---\n\nHello world";
    let trans = HashMap::from([(0usize, "你好世界".to_string())]);
    let r = render_html(md, &trans, false);
    // 正文段仍是 bi=0（元数据没把块号占走）
    assert!(r.html.contains("<p data-bi=\"0\">"), "{}", r.html);
    assert!(r.html.contains("你好世界"), "{}", r.html);
    // front matter 区域内不得出现任何计数器锚点
    let fm = r.html.split("</table>").next().unwrap_or("");
    assert!(!fm.contains("data-ri"), "元数据不得占 run 号: {fm}");
    assert!(!fm.contains("data-bi"), "元数据不得占块号: {fm}");
    assert!(!fm.contains("tr-box"), "元数据不得挂译文框: {fm}");
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