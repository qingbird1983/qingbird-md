//! 译文另存为：把 Block 树重新序列化为 Markdown，可译 run 换成译文。
//!
//! # 为什么是「重新序列化」而不是「在原文上做字符串替换」
//!
//! 译文只活在 `translations: Map<run 索引, 译文>` 里（**从不写回 content**），
//! 所以导出必须自己把译文落到 Markdown 上。两条路：
//!
//! - **源码 span 替换**：拿 `Parser::into_offset_iter` 的 `Event::Text` 范围
//!   直接改写原文。已实测（0.13.4）：范围确实精确覆盖源片段（含 `&amp;`、
//!   `\*` 这类转义/实体会把整个片段包住）。**但不能用**——`==高亮==` 落在
//!   一个 `Event::Text` 内，`model::fold_marks` 会在**节点内部**二次切分成
//!   `Mark(Text)` 等多个 `Inline::Text`，于是一个事件范围对应多个 run；整段
//!   替换会把 `==` 标记一起吃掉（破格式），按 run 切分又要重写一遍 fold 的
//!   切分规则（两份实现必然漂移）。
//! - **重新序列化**（本文件）← 采用。只在 Block 树上走一遍，结构由模型给，
//!   不需要任何源码偏移。
//!
//! # 索引空间：与收集侧逐位一致是**唯一的正确性条件**
//!
//! `translations` 的 key 是 `units::collect_text_runs` 的 run 号，所以本文件
//! 的遍历顺序与计数规则必须与它（以及 `html.rs::push_inlines`）**完全一致**：
//!
//! - 块的递归顺序：`walk_run_collect_blocks` 的镜像
//!   （Quote/List/FootnoteDef 递归；Table 先 headers 后 rows）。
//! - **只有 `Inline::Text` 推进 run 计数**，`Code`/`Image`/`Math`/`DisplayMath`/
//!   `LineBreak`/`FootnoteRef` 都不占号——任一侧改动都会让 run 号指向别的文本。
//!
//! 本文件**不做**「这个 run 该不该译」的判定：译文表就是收集时的产物，
//! 表里有就替换、没有就保留原文。不可译块（如参考文献区段）内的 run 当时
//! 就没进表，天然回落到原文。这比重新判定更稳——少一处会漂的判据。
//! （因此本文件也不需要 `block_translatable`，方向已隐含在表里。）
//!
//! # 已知天花板（都是格式规范化，不是内容丢失——唯一的例外已就地处理）
//!
//! - **front matter**：`parse_blocks` 刻意丢弃 MetadataBlock，导出会连
//!   title/author 一起丢——已由 `front_matter()` 单独切回并拼在文首。
//! - **块级 HTML**：在 `parse_blocks` 里落进 `_ =>` 兜底成空段落（未建模），
//!   导出随之不输出。预览本就不渲染它，两边同口径。
//! - **行内 HTML**（`<b>` 等）：不在 `Inline` 模型里，`parse_blocks` 已丢弃，
//!   只留下其中的文本。同上，与预览一致。
//! - **软/硬换行不分**：`Inline::LineBreak` 是 SoftBreak 与 HardBreak 折成的
//!   同一个变体，一律输出软换行。原文的 `  \n` 导出后渲染从 `<br>` 变空格。
//! - **Setext 标题**（`Title\n=====`）统一输出 ATX（`# Title`）。
//! - **无序列表标记统一成 `-`**：`model::Block::List` 只留 `ordered`，没有记录
//!   原文用的是 `*` 还是 `+`。三者渲染完全等价，但源码会变。
//! - **表格分隔行补齐空格**（`|---|---|` → `| --- | --- |`），同样等价。
//! - **文末补一个换行**（原文没有时），符合 POSIX 惯例。
//! - **紧凑列表会变松散**：列表项内有多个块时，块之间按 Markdown 惯例插空行
//!   （不插的话相邻段落会被并成一段）。语义与渲染等价，run 顺序也不受影响，
//!   只是源码里多了空行。
//!
//! 实测口径：拿 165 行的 `README.md` 跑空表导出，26 行有差异、全部属于上面
//! 几条，无一处内容增减。

use std::collections::HashMap;

use super::model::{Block, Inline};

/// 文首 YAML front matter 的**源码切片**（含首尾 `---` 行）。
///
/// `parse_blocks` 刻意丢弃 MetadataBlock（元数据不进正文模型，阅读器与翻译器
/// 都不消费它），但「译文另存为」产出的是**交付物**——把 title/author 丢掉
/// 属于内容损失，不是格式规范化。这里用同一套解析开关把那一块切出来原样拼回。
pub fn front_matter(content: &str) -> Option<&str> {
    use pulldown_cmark::{Event, Parser, Tag};
    let mut it = Parser::new_ext(content, super::model::options()).into_offset_iter();
    match it.next() {
        Some((Event::Start(Tag::MetadataBlock(_)), r)) => Some(&content[r]),
        _ => None,
    }
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
    let blocks = super::model::parse_blocks(content);
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
        for (i, b) in blocks.iter().enumerate() {
            if i > 0 {
                self.out.push('\n'); // 块间空行（块自身已在上一轮收尾换行）
            }
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

/// 段落类内容（段落/标题/列表项/表格单元格）**行首**的块级前缀转义。
///
/// `escape_md` 不转义 `-`/`+`/`=`/数字——它们在正文中间极常见（`well-known`、
/// `1.5`），全转义会让源码很脏。但落在行首就会变成列表/分割线/setext 标题，
/// 把结构改掉，所以只在这一处补。
fn block_start(s: &str) -> String {
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
fn escape_md(s: &str, in_table: bool) -> String {
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
fn code_span(c: &str) -> String {
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
fn fence_for(code: &str) -> String {
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
fn prefix_lines(text: &str, prefix: &str) -> String {
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
}
