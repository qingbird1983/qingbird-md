//! 导出入口与 Md 序列化器：front matter 切回、单块导出、译文另存为主流程。
//! **红线**：`Md::inlines` 的 data-ri run 计数只有 `Inline::Text` 推进，
//! 与 `html.rs::push_inlines` 逐位一致——此逻辑一行不动。

use std::collections::HashMap;

use super::escape::{block_start, code_span, escape_md, fence_for, prefix_lines};
use crate::markdown::model::{Block, Inline};

/// 文首 YAML front matter 的**源码切片**（含首尾 `---` 行）。
///
/// 这是**委托**：唯一实现是 `model::front_matter_raw`（`parse_blocks` 造
/// `Block::Metadata` 用的也是它），保证「切出来的切片」与「模型里的块」永远
/// 是同一段字节。
///
/// 导出侧单独切回的理由：`Block::Metadata` 在导出时会跳过（免得和这里的拼回
/// 逻辑打架），而「译文另存为」产出的是**交付物**——把 title/author 丢掉属于
/// 内容损失，不是格式规范化。
pub fn front_matter(content: &str) -> Option<&str> {
    crate::markdown::model::front_matter_raw(content)
}

/// 渲染**单个** Block 为 Markdown（不带任何译文替换）。
///
/// 给「双语对照导出」用：调用方自己控制"每块出完原文再出译文"的节奏，
/// 而不需要把整篇都过一次 `Md::blocks`、再回头找位置插译文（那会破坏
/// 列表/引用块的"整段拿到再逐行加前缀"逻辑）。这里 `sub` 是空表 + 单独的
/// `Md` 实例，所以不会污染任何外部状态——每次调用都是独立的。
pub fn render_block_for_export(b: &Block) -> String {
    let empty: HashMap<usize, String> = HashMap::new();
    let mut md = Md {
        sub: &empty,
        sub_counter: 0,
        out: String::new(),
    };
    md.block(b)
}

/// 译文另存为（单语）。`translations` 的 key 是 run 索引（`data-ri` 空间）。
///
/// 未在表里的 run 保留原文；`translations` 为空时输出与原文**语义等价**的
/// 规范化 Markdown（块级重排，不保证逐字节相同）。
pub fn export_translation(content: &str, translations: &HashMap<usize, String>) -> String {
    let blocks = crate::markdown::model::parse_blocks(content);
    let mut md = Md {
        sub: translations,
        sub_counter: 0,
        out: String::new(),
    };
    md.blocks(&blocks);
    let mut s = String::new();
    if let Some(fm) = front_matter(content) {
        s.push_str(fm.trim_end_matches('\n'));
    }
    let body = md.out.trim_end_matches('\n');
    if !body.is_empty() {
        if !s.is_empty() {
            s.push_str("\n\n"); // front matter 与正文之间留空行
        }
        s.push_str(body);
    }
    if !s.is_empty() {
        s.push('\n'); // 文末收一个换行（大多数 Markdown 工具的习惯）
    }
    s
}

struct Md<'t> {
    sub: &'t HashMap<usize, String>,
    sub_counter: usize,
    out: String,
}

impl Md<'_> {
    /// 在独立 buffer 里跑一段渲染，返回其产物并把 `self.out` 原样还原。
    /// 引用块/列表项要把子内容**整体拿到**再逐行加前缀，不能边渲染边拼。
    fn capture<F: FnOnce(&mut Self)>(&mut self, f: F) -> String {
        let saved = std::mem::take(&mut self.out);
        f(self);
        std::mem::replace(&mut self.out, saved)
    }

    fn blocks(&mut self, blocks: &[Block]) {
        // `emit` 只对**有源码表示**的块计数：front matter 元数据块整块跳过
        // （导出里它由 `front_matter()` 单独拼在文首），若照旧占块间空行，
        // 导出文首会平白多出两行空行。无 front matter 的文档走路径与改前
        // 逐字节相同。
        let mut emit = 0usize;
        for b in blocks {
            if matches!(b, Block::Metadata { .. }) {
                continue;
            }
            if emit > 0 {
                self.out.push('\n'); // 块间空行（块自身已在上一轮收尾换行）
            }
            emit += 1;
            let t = self.block(b);
            self.out.push_str(&t);
            self.out.push('\n');
        }
    }

    fn block(&mut self, b: &Block) -> String {
        match b {
            Block::Heading { level, text } => {
                let body = self.inlines(text, false);
                format!("{} {}", "#".repeat(*level as usize), block_start(&body))
            }
            Block::Paragraph { text } => {
                let body = self.inlines(text, false);
                block_start(&body)
            }
            Block::Code { lang, code } => {
                let fence = fence_for(code);
                let body = code.strip_suffix('\n').unwrap_or(code);
                match lang.as_deref() {
                    Some(l) if !l.is_empty() => format!("{fence}{l}\n{body}\n{fence}"),
                    _ => format!("{fence}\n{body}\n{fence}"),
                }
            }
            Block::Quote { blocks } => {
                let inner = self.capture(|s| s.blocks(blocks));
                prefix_lines(inner.trim_end_matches('\n'), "> ")
            }
            Block::List { ordered, start, items } => {
                let mut lines: Vec<String> = Vec::new();
                for (i, it) in items.iter().enumerate() {
                    let task = match it.task {
                        Some(true) => "[x] ",
                        Some(false) => "[ ] ",
                        None => "",
                    };
                    let bullet = if *ordered {
                        format!("{}. ", *start as usize + i)
                    } else {
                        "- ".to_string()
                    };
                    // 缩进按 **bullet 宽度**算，**不含任务标记**：`[x] ` 是列表项的
                    // 内容而非 marker，把它算进去会让嵌套子块相对内容列多缩进 4 格，
                    // 重新解析时被当成缩进代码块——那些 run 会直接从译文空间里消失
                    // （守卫测试 export_keeps_run_space_aligned 抓的就是这个）。
                    let indent = " ".repeat(bullet.len());
                    let marker = format!("{bullet}{task}");
                    let inner = self.capture(|s| s.blocks(&it.blocks));
                    let inner = inner.trim_end_matches('\n');
                    let mut first = true;
                    for line in inner.split('\n') {
                        if first {
                            first = false;
                            lines.push(format!("{marker}{line}"));
                        } else if line.is_empty() {
                            lines.push(String::new());
                        } else {
                            lines.push(format!("{indent}{line}"));
                        }
                    }
                    if first {
                        lines.push(marker.trim_end().to_string()); // 空列表项
                    }
                }
                lines.join("\n")
            }
            Block::Rule => "---".to_string(),
            Block::Image { alt, src } => {
                format!("![{}]({})", escape_md(alt, false), escape_md(src, false))
            }
            Block::Table { headers, rows, aligns } => self.table(headers, rows, aligns),
            Block::Math { tex, .. } => {
                // tex 已含首尾换行（pulldown 的 DisplayMath 载荷如此），直接拼
                format!("$${tex}$$")
            }
            Block::FootnoteDef { label, blocks } => {
                // 原地输出 `[^label]: 正文`；正文首段接在冒号后，其余段缩进 4 空格
                let inner = self.capture(|s| s.blocks(blocks));
                let inner = inner.trim_end_matches('\n');
                let mut lines = inner.split('\n');
                let head = lines.next().unwrap_or("");
                let mut out = format!("[^{}]: {}", escape_md(label, false), head);
                for line in lines {
                    out.push('\n');
                    if !line.is_empty() {
                        out.push_str("    ");
                        out.push_str(line);
                    }
                }
                out
            }
            // 导出里 front matter 由 `front_matter()` 单独拼在文首，`Md::blocks`
            // 也已整块跳过它，所以这里恒为空串。**不能**输出 raw——否则与那段
            // 拼回逻辑重复，导出会出两份 front matter。
            Block::Metadata { .. } => String::new(),
            // 块级 HTML：**原样回写**。它承载的是用户文档的实体内容（富文本粘进来
            // 的表格、卡片），丢掉它等于把交付物改瘦——与预览同口径。
            // `raw` 是源码切片（每行自带行尾换行），去掉尾部换行即可：本函数
            // 的调用方 `Md::blocks` 会自己补一个。
            Block::Html { raw } => raw.trim_end_matches('\n').to_string(),
        }
    }

    fn table(&mut self, headers: &[Vec<Inline>], rows: &[Vec<Vec<Inline>>], aligns: &[u8]) -> String {
        let mut out = String::new();
        let cell = |m: &mut Self, c: &[Inline]| m.inlines(c, true);
        out.push('|');
        for h in headers {
            let t = cell(self, h);
            out.push(' ');
            out.push_str(&block_start(&t));
            out.push_str(" |");
        }
        out.push('\n');
        out.push('|');
        for i in 0..headers.len() {
            let sep = match aligns.get(i).copied().unwrap_or(0) {
                1 => ":---:",
                2 => "---:",
                _ => "---",
            };
            out.push(' ');
            out.push_str(sep);
            out.push_str(" |");
        }
        for row in rows {
            out.push('\n');
            out.push('|');
            for c in row {
                let t = cell(self, c);
                out.push(' ');
                out.push_str(&block_start(&t));
                out.push_str(" |");
            }
        }
        out
    }

    /// 行内序列化。**run 计数规则与 `html.rs::push_inlines` 逐位一致**：
    /// 只有 `Inline::Text` 推进，其余变体不占号。
    fn inlines(&mut self, ils: &[Inline], in_table: bool) -> String {
        let mut s = String::new();
        for il in ils {
            match il {
                Inline::Text(t) => {
                    let idx = self.sub_counter;
                    self.sub_counter += 1;
                    let raw = self.sub.get(&idx).map(String::as_str).unwrap_or(t);
                    s.push_str(&escape_md(raw, in_table));
                }
                Inline::Strong(x) => {
                    s.push_str("**");
                    s.push_str(&self.inlines(x, in_table));
                    s.push_str("**");
                }
                Inline::Emph(x) => {
                    s.push('*');
                    s.push_str(&self.inlines(x, in_table));
                    s.push('*');
                }
                Inline::Del(x) => {
                    s.push_str("~~");
                    s.push_str(&self.inlines(x, in_table));
                    s.push_str("~~");
                }
                Inline::Mark(x) => {
                    s.push_str("==");
                    s.push_str(&self.inlines(x, in_table));
                    s.push_str("==");
                }
                // 行内代码里的反引号要按 CommonMark 规则换用更长的围串
                Inline::Code(c) => s.push_str(&code_span(c)),
                Inline::Link { text, href } => {
                    s.push('[');
                    s.push_str(&self.inlines(text, in_table));
                    s.push_str("](");
                    s.push_str(&escape_md(href, in_table));
                    s.push(')');
                }
                Inline::Image { alt, src } => {
                    s.push_str("![");
                    s.push_str(&escape_md(alt, in_table));
                    s.push_str("](");
                    s.push_str(&escape_md(src, in_table));
                    s.push(')');
                }
                // 表格单元格内不能出现裸换行（会破表格）→ 退化成空格
                Inline::LineBreak => s.push(if in_table { ' ' } else { '\n' }),
                Inline::FootnoteRef(label) => {
                    s.push_str("[^");
                    s.push_str(&escape_md(label, in_table));
                    s.push(']');
                }
                Inline::Math(tex) => {
                    s.push('$');
                    s.push_str(tex);
                    s.push('$');
                }
                Inline::DisplayMath(tex) => {
                    s.push_str("$$");
                    s.push_str(tex);
                    s.push_str("$$");
                }
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::model::parse_blocks;
    use crate::markdown::units::collect_text_runs;
    use crate::translate::engine::TargetLang;

    const ZH: TargetLang = TargetLang::Zh;

    /// 覆盖全部 Block 变体 + 全部 Inline 变体的综合文档。
    /// 列表里混了嵌套与任务项；`==高亮==` 会走 fold_marks 的节点内切分
    /// （这正是"源码 span 替换"方案作废的原因）。
    const DOC: &str = "\
# Title one

Para with **bold** and *em* and ~~del~~ and ==mark== and `code` here.

> Quoted **strong** line
> second line

- item one
- [x] task **done**
  - nested item

1. first
2. second

| head a | head b |
| :--- | ---: |
| cell 1 | cell 2 |

```rust
let x = 1;
```

---

Inline math $a^2$ tail.

$$
E = mc^2
$$

Image below:

![alt text](img/pic.png)

Footnote ref[^n] here.

[^n]: Footnote body text.
";

    /// 把每个可译 run 换成可识别的 `Torun{i}`。
    fn tagged_map(md: &str) -> (HashMap<usize, String>, Vec<(usize, String)>) {
        let runs = collect_text_runs(&parse_blocks(md), ZH);
        let map = runs
            .iter()
            .map(|(i, _)| (*i, format!("Torun{i}")))
            .collect::<HashMap<usize, String>>();
        (map, runs)
    }

    /// **核心守卫**：导出 → 重新解析 → 重新收集，run 必须逐位对上。
    ///
    /// 导出侧只要多占一个 run 号（比如给 `Inline::Code` 也 `+1`）、少占一个，
    /// 或递归顺序与 `walk_run_collect_blocks` 不同（比如 Table 先 rows 后
    /// headers），`Torun{i}` 就会整体错位——这里立刻变红。这是"译文贴错块"
    /// 这类静默错误唯一能被钉死的地方。
    #[test]
    fn export_keeps_run_space_aligned() {
        let (map, runs) = tagged_map(DOC);
        assert!(runs.len() > 20, "综合文档应收集到足量 run，实得 {}", runs.len());
        let out = export_translation(DOC, &map);
        let after = collect_text_runs(&parse_blocks(&out), ZH)
            .into_iter()
            .map(|(_, t)| t)
            .collect::<Vec<_>>();
        let expect = runs
            .iter()
            .map(|(i, _)| format!("Torun{i}"))
            .collect::<Vec<_>>();
        assert_eq!(
            after, expect,
            "导出后 run 顺序与收集侧不一致 → 译文会贴错块\n导出结果:\n{out}"
        );
    }

    /// 反向守卫：**不可译**的 run 必须留在原地（不能被某个译文顶掉）。
    /// 与上一条互补——上一条盯"顺序"，这条盯"错位到不可译位置上"。
    ///
    /// 用 `*42*` 把数字隔成独立 run：收集时它**占号但不收集**（纯数字不满足
    /// needs_translation），所以表里没有它。导出侧若把"占号"与"有译文"混为
    /// 一谈（比如给不收集的 run 不推进计数），后面的 run 就会整体前移，
    /// 译文贴到 `42` 上。
    #[test]
    fn untranslatable_runs_keep_source_text() {
        let md = "Hello *42* world";
        let runs = collect_text_runs(&parse_blocks(md), ZH);
        assert_eq!(runs.len(), 2, "中间的数字 run 不该被收集: {runs:?}");
        let map = HashMap::from([(runs[0].0, "CHANGED".to_string())]);
        let out = export_translation(md, &map);
        assert!(out.contains("42"), "纯数字 run 必须留在原地: {out}");
        assert!(out.contains("CHANGED"), "目标 run 必须被替换: {out}");
        assert!(out.contains("world"), "后续 run 不受影响: {out}");
    }

    /// 标记与代码块原样保留——这是「标记/代码块原样保留」那条要求的守卫。
    #[test]
    fn markup_and_code_fences_survive() {
        let (map, _) = tagged_map(DOC);
        let out = export_translation(DOC, &map);
        assert!(out.contains("# Torun"), "ATX 标题标记: {out}");
        assert!(out.contains("**Torun"), "粗体标记保留: {out}");
        assert!(out.contains("~~Torun"), "删除线标记保留: {out}");
        assert!(out.contains("==Torun"), "高亮标记保留: {out}");
        assert!(out.contains("```rust\nlet x = 1;\n```"), "代码围栏原样: {out}");
        assert!(out.contains("| --- | ---: |") || out.contains("| :--- | ---: |"), "表格: {out}");
        assert!(out.contains("> "), "引用前缀: {out}");
        assert!(out.contains("- [x] "), "任务项标记: {out}");
        assert!(out.contains("$a^2$"), "行内公式不被翻译、原样输出: {out}");
        assert!(out.contains("$$\nE = mc^2\n$$"), "块级公式原样: {out}");
        assert!(out.contains("![alt text](img/pic.png)"), "图片: {out}");
        assert!(out.contains("[^n]"), "脚注引用: {out}");
    }

    /// 代码块与公式**不进译文表**（收集侧就不收集它们），导出也不能动。
    #[test]
    fn code_and_math_have_no_translatable_runs() {
        let md = "```rust\nlet x = 1;\n```\n\n$$\nE = mc^2\n$$\n";
        let runs = collect_text_runs(&parse_blocks(md), ZH);
        assert!(runs.is_empty(), "代码/公式不该产生可译 run: {runs:?}");
        let out = export_translation(md, &HashMap::new());
        assert!(out.contains("let x = 1;"), "{out}");
        assert!(out.contains("E = mc^2"), "{out}");
    }

    /// 空译文表 ⇒ 原文内容一字不少（只是块级重排 + 转义）。
    #[test]
    fn empty_translations_preserve_all_text() {
        let out = export_translation(DOC, &HashMap::new());
        for needle in [
            "Title one",
            "Para with",
            "Quoted",
            "item one",
            "nested item",
            "first",
            "head a",
            "cell 2",
            "Footnote body text.",
        ] {
            assert!(out.contains(needle), "缺 {needle:?}:\n{out}");
        }
    }

    /// front matter 不能被丢掉——导出是交付物，title/author 属于内容，
    /// 不是"规范化"能牺牲的东西。
    #[test]
    fn front_matter_is_preserved_verbatim() {
        let md = "---\ntitle: T\nauthor: A\n---\n\nHello world";
        let (map, runs) = tagged_map(md);
        assert_eq!(runs.len(), 1, "front matter 不进可译 run: {runs:?}");
        let out = export_translation(md, &map);
        assert!(
            out.starts_with("---\ntitle: T\nauthor: A\n---\n\n"),
            "front matter 应原样居于文首: {out}"
        );
        assert!(out.contains("Torun0"), "正文照常替换: {out}");
    }

    /// front matter 必须**恰好出一份**——两条导出路径都要守：`export_translation`
    /// 走 `Md::blocks`，`export_bilingual` 走 `walk_bilingual`，两边都是
    /// 「跳过 `Block::Metadata` + 文首拼回源码切片」。都输出 → 正文前多一份重复
    /// 元数据；都不输出 → 交付物丢 title；跳过时若顺手占掉块间空行 → 文首多空行。
    ///
    /// 为何放 writer.rs 而非 `translate/export.rs`：后者的内联测试块已顶到 400 行
    /// 冻结上限（codeSizeBudget 的 GRANDFATHERED，只剩 1 行余量），而 `front_matter()`
    /// 这个不变式的所有者本来就是本文件。
    #[test]
    fn export_emits_front_matter_exactly_once() {
        let md = "---\ntitle: T\nauthor: A\n---\n\nHello world";
        let (map, _) = tagged_map(md);
        let out = export_translation(md, &map);
        assert_eq!(out.matches("title: T").count(), 1, "元数据只许出现一次:\n{out}");
        assert_eq!(out.matches("author: A").count(), 1, "元数据只许出现一次:\n{out}");
        assert_eq!(out.matches("\n---\n").count(), 1, "只许有收尾那一行 `---`:\n{out}");
        // 跳过元数据块时也不能顺带占掉「块间空行」——否则文首多一行空白
        assert!(out.starts_with("---\ntitle: T\nauthor: A\n---\n\n"), "文首格式:\n{out}");
        // 无 front matter 的文档走同一入口，行为与改前一致
        let out2 = export_translation("Hello world", &tagged_map("Hello world").0);
        assert_eq!(out2, "Torun0\n", "无 front matter 时不得多出空行: {out2:?}");

        // 双语对照路径：同一条不变式（双语是最容易被肉眼忽略重复的形态）
        let zh = HashMap::from([(0usize, "你好世界。".to_string())]);
        let bi =
            crate::translate::export::export_bilingual("---\ntitle: T\n---\n\nHello world.", &zh, ZH);
        assert_eq!(bi.matches("title: T").count(), 1, "元数据只许出现一次:\n{bi}");
        assert_eq!(bi.matches("---\n").count(), 2, "恰好首尾两行 `---`:\n{bi}");
        assert!(bi.starts_with("---\ntitle: T\n---\n\n"), "文首格式:\n{bi}");
        assert!(bi.contains("Hello world.\n\n你好世界。"), "正文对照丢失:\n{bi}");
    }

    /// 块级 HTML 是**内容**，不是格式：导出必须原样带回、且恰好一份。
    /// 修复前它落成空段落、导出随之整块不输出——富文本粘进来的表格（tiptap 卡片，
    /// 见 `UI 设计师.md`）会在交付物里静默消失。两条导出路径共用
    /// `render_block_for_export`，所以这里一并钉住。
    #[test]
    fn html_block_is_exported_verbatim_exactly_once() {
        let table = r#"<table class="tiptap-table"><tr><td>甲</td></tr></table>"#;
        let md = format!("---\n\n{table}\n\nHello world.");
        let (map, runs) = tagged_map(&md);
        assert_eq!(runs.len(), 1, "块级 HTML 不该产生可译 run: {runs:?}");

        let out = export_translation(&md, &map);
        assert!(out.contains(table), "原文须逐字保留:\n{out}");
        assert_eq!(out.matches("tiptap-table").count(), 1, "恰一份:\n{out}");
        assert!(out.contains("Torun0"), "正文照常替换:\n{out}");

        // 双语对照路径：同一条不变式
        let bi = crate::translate::export::export_bilingual(&md, &map, ZH);
        assert!(bi.contains("甲"), "{bi}");
        assert_eq!(bi.matches("tiptap-table").count(), 1, "双语里也恰一份:\n{bi}");
    }
}
