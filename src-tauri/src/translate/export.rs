//! 双语对照导出（L3 交付物的第二种形态）。
//!
//! 与单语导出的差别只在「原文之外**多输出**一段译文」：每段原文后紧跟它
//! 的译文，空行隔开；不可译块（代码、公式、规则线、图片…）只输出原文。
//!
//! # 为什么这是"重新走一遍 Block 树"而不是"在 cmark 输出上后处理"
//!
//! 双语要求**段段相邻**——翻译块不能跑到源块下面别的位置，否则对照就破。
//! 而 `cmark.rs::Md::block` 已经按 Markdown 协议把每个块收成完整字符串
//! （含内嵌换行、前缀、列表缩进等），要在这个粒度上"插一段译文"就得把
//! 列表项、引用块的"整段拿到再逐行加前缀"逻辑再写一遍——两份实现必然
//! 漂移。所以这里**复用 `cmark::Md::block` 渲染原文**，自己再走一遍块
//! 树控制译文插入位置。
//!
//! # 索引空间：与 `units::walk_collect` 逐位一致
//!
//! `translations` 的 key 是 `data-bi` 块索引——**方向相关**（哪些块"可译"
//! 取决于翻译方向）。所以本文件必须拿到 `target_lang` 才能正确判定"这一块
//! 是不是该出译文、出译文时用哪个块号"。占号规则与 `walk_collect` 完全
//! 一致：Heading/Paragraph/Table 各自推进一次；Quote/List/FootnoteDef 递归
//! 到子块；Math/Code/Rule/Image 不占号。
//!
//! 复用 `units::block_translatable` 与 `units::inline_plain_text`——这是
//! 「块空间（data-bi）的唯一判定点」（units.rs 注释明文）。**不能**自己再
//! 写一遍 `needs_translation` 判定：那条已经在四个调用方之间保持逐位一致，
//! 复制就是分叉的开始。
//!
//! # 块数不变量（§四 L3 硬约束）
//!
//! 双语对照的「段段对齐」依赖"原文 N 段 ↔ 译文 N 段"。重排版**不得**拆合段，
//! 否则 N 对齐就破——这条原则放在 `tri-rs` 那侧（重排版规则集 T07/T08），
//! 本文件**只做"按当前块数逐段对照"，不做"自适应 N"。** 如果某块确实结构
//! 变了，对照仍然按原文块的数对齐——空缺译文回退到原文。

use std::collections::HashMap;

use crate::markdown::cmark;
use crate::markdown::model::{parse_blocks, Block, Inline};
use crate::markdown::units::{block_translatable, inline_plain_text};
use crate::translate::engine::TargetLang;
use crate::translate::skip::RefSkipState;

/// 双语对照导出（§五 第 2 步 #9）。
///
/// `translations` 的 key 是 `data-bi` 块号（**方向相关**）。每个块号的
/// 译文**仅包含块纯文本**（不是 Markdown、不是带格式）——bilingual 模式下
/// 翻译模型收到的是整段的 plain text，存的就是 plain text，对照导出时
/// 也按 plain text 输出（前后各一空行把它从周围 Markdown 中分出来）。
///
/// 缺段时（key 不在表里）回退到源块纯文本——这样永远不会出现"对照里少一段"。
/// 多段时（key 大于块数）忽略——属于跨文档串味，立即丢弃。
pub fn export_bilingual(
    content: &str,
    translations: &HashMap<usize, String>,
    target: TargetLang,
) -> String {
    let blocks = parse_blocks(content);
    let mut st = RefSkipState::default();
    let mut counter = 0usize;
    let mut out = String::new();

    walk_bilingual(
        &blocks,
        translations,
        target,
        &mut st,
        &mut counter,
        &mut out,
    );

    let mut final_out = String::new();
    if let Some(fm) = cmark::front_matter(content) {
        final_out.push_str(fm.trim_end_matches('\n'));
        final_out.push_str("\n\n");
    }
    // body 已经每单元后跟 "\n\n"——trim 掉尾部连续 `\n`，再统一加一个 `\n`
    // 收尾（与 `cmark::export_translation` 的文末补一个换行的 POSIX 惯例对齐）。
    let body = out.trim_end_matches('\n');
    if !body.is_empty() {
        final_out.push_str(body);
    }
    if !final_out.is_empty() && !final_out.ends_with('\n') {
        final_out.push('\n');
    }
    final_out
}

/// 块树双语走查：**源只在顶层**走一次（容器嵌套由 cmark 内部递归渲染），
/// **译文**按 `data-bi` 递归发射——容器块的子块译文在容器源之后、独立成段，
/// 不与子块源混排（后者已含在 cmark 渲染里）。
///
/// 与 `units::walk_collect` 的占号规则**逐位对齐**：Quote/List/FootnoteDef
/// 递归到子块（自己不占号）；Heading/Paragraph 各占号一次；Math/Code/Rule/
/// Image 不占号。占号是「data-bi 的唯一判定点」（units.rs 注释明文）。
///
/// 为什么源不递归：本文件想用 `cmark::render_block_for_export` 拿到**带正确
/// 容器前缀**的 Markdown（引用块的 `> `、列表项的 `- `、嵌套引用块的 `> > `
/// 等）。若在容器块上自己递归渲染子块，要么复制一份 `cmark` 的前缀规则
/// （两份实现必然漂移），要么丢前缀（回归里看到的"- first item 不带 - "）。
/// 折中：源走 cmark（顶层一次），译文按容器结构递归发射——每段对照仍是
/// 独立的 Markdown 段，不嵌进父容器，但能保证"占号与收集逐位一致"。
fn walk_bilingual(
    blocks: &[Block],
    translations: &HashMap<usize, String>,
    target: TargetLang,
    st: &mut RefSkipState,
    counter: &mut usize,
    out: &mut String,
) {
    for b in blocks {
        // 1) 整块源（含所有容器嵌套）由 cmark 一次性渲染，**末尾跟 `\n\n`**
        //    形成"块间一空行"的分隔
        let src_md = cmark::render_block_for_export(b);
        out.push_str(&src_md);
        out.push_str("\n\n");

        // 2) 出译文：仅叶子型可译块（Heading/Paragraph）触发；容器块不触发
        //    emit_translation 内部负责把 `translation + \n\n` 拼好（不嵌前后换行）
        emit_translation(b, translations, target, st, counter, out);

        // 3) 容器块：递归处理其子块的占号 + 出译文——子块源已在上面渲染过了；
        //    表格不是容器但同属"源已在整块渲染里、译文要按格拆开发射"的构造，
        //    与 walk_collect 的 Table 分支同序逐格占号
        match b {
            Block::Quote { blocks: inner } => {
                emit_children_translations(inner, translations, target, st, counter, out)
            }
            Block::List { items, .. } => {
                for it in items {
                    emit_children_translations(
                        &it.blocks,
                        translations,
                        target,
                        st,
                        counter,
                        out,
                    );
                }
            }
            Block::FootnoteDef { blocks: inner, .. } => {
                emit_children_translations(inner, translations, target, st, counter, out)
            }
            Block::Table { headers, rows, .. } => {
                emit_table_translations(headers, rows, translations, target, st, counter, out)
            }
            _ => {}
        }
    }
}

/// 给一个**叶子**块出译文。返回是否真的出了译文（影响块间空行）。
///
/// 输出格式约定：本函数**不写前导 `\n`**，但**写尾随 `\n\n`**（与源块
/// 后的"块间一空行"对齐）。这是"每单元后跟 `\n\n`"格式规则的统一落点：
/// 调用方负责把源写到 `out` 末尾时也跟 `\n\n`，自然就形成"源 → 空行 → 译文
/// → 空行 → 下一源"的视觉分隔。
fn emit_translation(
    b: &Block,
    translations: &HashMap<usize, String>,
    target: TargetLang,
    st: &mut RefSkipState,
    counter: &mut usize,
    out: &mut String,
) -> bool {
    let plain = block_plain(b);
    let translatable = match b {
        Block::Heading { level, .. } => {
            block_translatable(st, Some(*level), &plain, target)
        }
        Block::Paragraph { .. } => block_translatable(st, None, &plain, target),
        _ => false,
    };
    if !translatable {
        return false;
    }
    let idx = *counter;
    *counter += 1;
    let trans = translations.get(&idx).cloned().unwrap_or(plain);
    out.push_str(&trans);
    out.push_str("\n\n");
    true
}

/// 容器块内部只发射**译文**——源已在 cmark 的整块渲染里覆盖。逐块判定：
/// - 叶子可译 → 出译文 + 推进 counter
/// - 容器 → 继续递归
/// - 表格 → 与 walk_collect 同序逐格占号 + 发射（`emit_table_translations`）
/// - 非文本叶子（Code/Math/Image/Rule） → 跳过
///
/// 每个 emit_translation 自己管 `\n\n`，所以这里**不再额外加换行**——多个
/// 译文之间就靠每段自带的尾随 `\n\n` 形成"块间一空行"的视觉分隔。
fn emit_children_translations(
    blocks: &[Block],
    translations: &HashMap<usize, String>,
    target: TargetLang,
    st: &mut RefSkipState,
    counter: &mut usize,
    out: &mut String,
) {
    for b in blocks {
        emit_translation(b, translations, target, st, counter, out);
        match b {
            Block::Quote { blocks: inner } => {
                emit_children_translations(inner, translations, target, st, counter, out)
            }
            Block::List { items, .. } => {
                for it in items {
                    emit_children_translations(
                        &it.blocks,
                        translations,
                        target,
                        st,
                        counter,
                        out,
                    );
                }
            }
            Block::FootnoteDef { blocks: inner, .. } => {
                emit_children_translations(inner, translations, target, st, counter, out)
            }
            Block::Table { headers, rows, .. } => {
                emit_table_translations(headers, rows, translations, target, st, counter, out)
            }
            _ => {}
        }
    }
}

/// 表格译文：与 `units::walk_collect` 的 Table 分支**逐位一致**——先逐表头、
/// 再按行逐单元格，每格调 `block_translatable`（heading=None）喂同一套 skip
/// 状态机；可译者推进 counter 并发射该格译文（取 `inline_plain_text`，缺段
/// 回退原文）。不可译格既不占号也不发射。表格源已由 `cmark` 整块渲染覆盖，
/// 这里只发射各格译文，每格自管尾随 `\n\n`。
fn emit_table_translations(
    headers: &[Vec<Inline>],
    rows: &[Vec<Vec<Inline>>],
    translations: &HashMap<usize, String>,
    target: TargetLang,
    st: &mut RefSkipState,
    counter: &mut usize,
    out: &mut String,
) {
    for h in headers {
        emit_table_cell_translation(h, translations, target, st, counter, out);
    }
    for row in rows {
        for cell in row {
            emit_table_cell_translation(cell, translations, target, st, counter, out);
        }
    }
}

/// 表格单格的占号 + 发射，与 `emit_translation` 的叶子语义一致：
/// 不可译（含空格）不占号；可译则 `idx = counter` 后推进。
fn emit_table_cell_translation(
    inlines: &[Inline],
    translations: &HashMap<usize, String>,
    target: TargetLang,
    st: &mut RefSkipState,
    counter: &mut usize,
    out: &mut String,
) {
    let plain = inline_plain_text(inlines);
    if block_translatable(st, None, &plain, target) {
        let idx = *counter;
        *counter += 1;
        let trans = translations.get(&idx).cloned().unwrap_or(plain);
        out.push_str(&trans);
        out.push_str("\n\n");
    }
}

/// 提取块纯文本（heading/paragraph 走 inlines；table 走表头/单元 inlines）。
fn block_plain(b: &Block) -> String {
    match b {
        Block::Heading { text, .. } | Block::Paragraph { text } => inline_plain_text(text),
        Block::Table { headers, rows, .. } => {
            let mut s = String::new();
            for h in headers {
                s.push_str(&inline_plain_text(h));
                s.push('\n');
            }
            for row in rows {
                for cell in row {
                    s.push_str(&inline_plain_text(cell));
                    s.push('\t');
                }
                s.push('\n');
            }
            s
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::engine::TargetLang;

    /// 双语导出签名 + 模式分发：
    /// - `mode == "bilingual"` 走新路径
    /// - 段落级 ASCII 源（zh 方向 = 译成中文）→ 应逐段出原文 + 译文
    #[test]
    fn bilingual_emits_source_then_translation_per_paragraph() {
        let content = "Para one.\n\nPara two.\n\nPara three.";
        let map = HashMap::from([
            (0usize, "段落一。".to_string()),
            (1usize, "段落二。".to_string()),
            (2usize, "段落三。".to_string()),
        ]);

        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 段段相邻：每段原文后紧跟其译文
        assert!(
            out.contains("Para one.\n\n段落一。"),
            "原文与译文必须相邻：\n{out}"
        );
        assert!(
            out.contains("Para two.\n\n段落二。"),
            "第二段对照丢失：\n{out}"
        );
        assert!(
            out.contains("Para three.\n\n段落三。"),
            "第三段对照丢失：\n{out}"
        );

        // 整体顺序：1 → 1 → 2 → 2 → 3 → 3
        let expect = "Para one.\n\n段落一。\n\nPara two.\n\n段落二。\n\nPara three.\n\n段落三。\n";
        assert_eq!(out, expect, "段段对照顺序错乱");
    }

    /// 不可译块（代码块、公式、图片、规则线、setext 横线、空 heading）必须
    /// **不出译文槽**——`block_translatable` 返回 false，本块只输出原文。
    ///
    /// 反向守卫：若 walker 把不可译块也按"占号 + 出译文"处理，可译块的
    /// `data-bi` 就会整体前移/后移，下游表里的译文贴错段。
    /// 这里具体盯三个不可译构造：代码块（Code）、块级公式（DisplayMath）
    /// 与图片（Image）。其它不可译构造（Rule、Heading 空 inline）由
    /// `block_translatable` 同口径覆盖，测这一组足以代表。
    #[test]
    fn untranslatable_blocks_emit_only_source() {
        let content = "\
Intro paragraph.

```rust
let x = 1;
```

Mid paragraph.

$$
E = mc^2
$$

![alt text](img.png)

Outro paragraph.
";
        // 3 个段落占 data-bi 0/1/2
        let map = HashMap::from([
            (0usize, "引言段。".to_string()),
            (1usize, "中段。".to_string()),
            (2usize, "尾段。".to_string()),
        ]);
        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 三段都要有对照
        assert!(out.contains("Intro paragraph.\n\n引言段。"), "首段对照：\n{out}");
        assert!(out.contains("Mid paragraph.\n\n中段。"), "中段对照：\n{out}");
        assert!(out.contains("Outro paragraph.\n\n尾段。"), "尾段对照：\n{out}");

        // 代码块、公式、图片原文各出现一次
        let code_count = out.matches("```rust").count();
        assert_eq!(code_count, 1, "代码块围栏必须原文出现：\n{out}");
        let math_count = out.matches("E = mc^2").count();
        assert_eq!(math_count, 1, "块级公式必须原文出现：\n{out}");
        let img_count = out.matches("![alt text](img.png)").count();
        assert_eq!(img_count, 1, "图片必须原文出现：\n{out}");

        // 代码块/公式/图片后面**绝不**跟一个独立的"伪译文"段
        // （即代码块后只接空行 + 下一个块的原文，没有翻译槽）
        assert!(
            !out.contains("```rust\n\nlet"),
            "代码块后面不能塞译文槽（伪译文会让对照错位）：\n{out}"
        );
    }

    /// 容器块递归：列表项里的段落各自占号 + 出译文；引用块、嵌套列表同样。
    /// 反向守卫：若 walker 把容器整块当成一个 data-bi，列表项里的多个段落
    /// 就会被压成一段译文 → 列表越长越错位。
    ///
    /// 引用块用 `\n>\n` 在两段间留空行——pulldown_cmark 会把 `> a\n> b`
    /// （无空行）合并成单段含软换行的 Paragraph，只占 1 个 data-bi；要看
    /// 多段对照必须给两个独立段落。
    #[test]
    fn containers_recurse_and_each_leaf_gets_its_own_translation() {
        let content = "\
- first item
- second item
- third item

> quoted line one
>
> quoted line two

Final paragraph.
";
        // 列表项 3 个段落占 0/1/2；引用块里 2 个独立段落占 3/4；尾段占 5
        let map = HashMap::from([
            (0usize, "第一条".to_string()),
            (1usize, "第二条".to_string()),
            (2usize, "第三条".to_string()),
            (3usize, "引用一".to_string()),
            (4usize, "引用二".to_string()),
            (5usize, "尾段。".to_string()),
        ]);
        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 列表项原文按 Markdown 输出后紧跟其译文
        assert!(out.contains("- first item"), "列表项原文：\n{out}");
        assert!(out.contains("- second item"), "第二项原文：\n{out}");
        assert!(out.contains("- third item"), "第三项原文：\n{out}");
        assert!(out.contains("\n\n第一条\n"), "第一项译文：\n{out}");
        assert!(out.contains("\n\n第二条\n"), "第二项译文：\n{out}");
        assert!(out.contains("\n\n第三条\n"), "第三项译文：\n{out}");

        // 引用块两个独立段落都对照
        assert!(out.contains("> quoted line one"), "引用一原文：\n{out}");
        assert!(out.contains("> quoted line two"), "引用二原文：\n{out}");
        assert!(out.contains("\n\n引用一\n"), "引用一译文：\n{out}");
        assert!(out.contains("\n\n引用二\n"), "引用二译文：\n{out}");

        // 尾段对照
        assert!(out.contains("Final paragraph.\n\n尾段。"), "尾段对照：\n{out}");
    }

    /// **表格占号**（BUG-1 回归）：`units::walk_collect` 对表格**逐表头、
    /// 再按行逐单元格**推进 data-bi，导出侧必须同序占号并发射译文——否则
    /// 表格之后的可译块在导出侧整体错号（译文张冠李戴）。
    ///
    /// 文档为「表格前后各一段」：前段占 0；表头 2 个占 1/2；两行单元格占
    /// 3-6；后段占 7。修复前 `emit_translation` 不认 Table（counter 不推进、
    /// 也不发射格译文），后段会错拿 key=1「表头一」→ 本测试必红。
    #[test]
    fn table_headers_and_cells_occupy_bi_and_following_paragraph_aligns() {
        let content = "\
Before paragraph.

| H1 | H2 |
|----|----|
| a1 | a2 |
| b1 | b2 |

After paragraph.
";
        // 与 walk_collect 同序：前段0 → 表头1/2 → 单元格3-6 → 后段7
        let map = HashMap::from([
            (0usize, "前段。".to_string()),
            (1usize, "表头一".to_string()),
            (2usize, "表头二".to_string()),
            (3usize, "甲一".to_string()),
            (4usize, "甲二".to_string()),
            (5usize, "乙一".to_string()),
            (6usize, "乙二".to_string()),
            (7usize, "后段。".to_string()),
        ]);
        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 表格前段照常对照
        assert!(
            out.contains("Before paragraph.\n\n前段。"),
            "表前段对照：\n{out}"
        );
        // 表头/单元格译文逐格发射（修复前一个都不出现）
        for (t, name) in [
            ("表头一", "表头1"),
            ("表头二", "表头2"),
            ("甲一", "a1"),
            ("甲二", "a2"),
            ("乙一", "b1"),
            ("乙二", "b2"),
        ] {
            assert!(out.contains(t), "{name} 的译文缺失：\n{out}");
        }
        // 表格之后段落对号必须正确（修复前后段错拿 key=1「表头一」）
        assert!(
            out.contains("After paragraph.\n\n后段。"),
            "表后段对照错位：\n{out}"
        );
        // 整体顺序：前段对照 → 表格源 → 六格译文 → 后段对照
        let mut last = 0usize;
        for s in [
            "前段。", "| H1", "表头一", "表头二", "甲一", "甲二", "乙一", "乙二",
            "After paragraph.", "后段。",
        ] {
            let p = out.find(s).unwrap_or_else(|| panic!("缺「{s}」：\n{out}"));
            assert!(p > last, "顺序错乱，「{s}」位置不对：\n{out}");
            last = p;
        }
    }

    /// **缺段**：translations 表里少几个 key，缺的段必须**回退原文**而不是
    /// 把后续段往前挪。这是 §五 第 2 步 #8 的硬约束——「表里没有就保留原文」，
    /// 否则用户在交付物里会看到**段段错位**（下游表里的 key=2 贴到了源=0
    /// 的位置上）。
    #[test]
    fn missing_translations_fall_back_to_source() {
        let content = "Para one.\n\nPara two.\n\nPara three.";
        // 故意缺 1 和 2
        let map = HashMap::from([(0usize, "段落一。".to_string())]);

        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 缺段的对照应回退原文，保证段段不缺
        assert!(out.contains("Para one.\n\n段落一。"), "已译段对照：\n{out}");
        assert!(
            out.contains("Para two.\n\nPara two."),
            "缺段 2 必须回退原文（不能消失、也不能让译文跑错位置）：\n{out}"
        );
        assert!(
            out.contains("Para three.\n\nPara three."),
            "缺段 3 必须回退原文：\n{out}"
        );

        // 整篇 3 个段落都保留，顺序不乱
        assert!(out.contains("Para one."), "段 1 出现：\n{out}");
        assert!(out.contains("Para two."), "段 2 出现：\n{out}");
        assert!(out.contains("Para three."), "段 3 出现：\n{out}");
    }

    /// **空表**：完全没翻译过的文档导出双语——每个对照里都是"原文 → 原文"。
    /// 仍要保证"每段都对照、不漏"。
    #[test]
    fn empty_translations_yields_source_in_both_slots() {
        let content = "First paragraph.\n\nSecond paragraph.";
        let map = HashMap::<usize, String>::new();

        let out = export_bilingual(content, &map, TargetLang::Zh);

        assert!(
            out.contains("First paragraph.\n\nFirst paragraph."),
            "空表：原文照原样进对照：\n{out}"
        );
        assert!(
            out.contains("Second paragraph.\n\nSecond paragraph."),
            "空表：每段都有原文：\n{out}"
        );
    }

    /// **多段**：translations 里 key > 块数（跨文档串味、stale 表）——超出的
    /// key 必须**丢弃**，否则会污染下一段对照。多出的 key 是**第三方串味**
    /// 的明确信号；与单语导出"按 key 替换"不同（单语模式下 key 不存在就
    /// 不替换，多的 key 也无害），双语模式必须明确"按当前块数决定对照长度"，
    /// 否则段段对齐立刻破。
    ///
    /// 反向守卫：若实现把多出的 key 当成"出现在末尾的额外对照段"——这是
    /// 对照文件中"末尾多一段"的隐蔽 bug，看起来无害但用户在文档外引用
    /// 段落号时立刻崩。
    #[test]
    fn extra_translation_keys_are_dropped() {
        let content = "One.\n\nTwo.";
        // 段 0/1 + 多出的 key 99（模拟跨文档串味的 stale 表）
        let map = HashMap::from([
            (0usize, "一。".to_string()),
            (1usize, "二。".to_string()),
            (99usize, "STALE串味".to_string()),
        ]);

        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 多出的 key 99 不出现在对照里
        assert!(
            !out.contains("STALE串味"),
            "超出当前块数的 key 必须丢弃（防跨文档串味）：\n{out}"
        );
        // 段 0/1 对照都在
        assert!(out.contains("One.\n\n一。"), "段 0：\n{out}");
        assert!(out.contains("Two.\n\n二。"), "段 1：\n{out}");
    }

    /// **乱序**：translations 里 key 顺序与文档序不一致（Rust 端接收的是
    /// `Vec<(usize, String)>`，会被聚合成 HashMap，**理论上**乱序不影响；
    /// 但要守住"`HashMap` 替换不会因为遍历顺序漂移"这条隐性契约。
    #[test]
    fn unordered_translation_map_still_aligns() {
        let content = "Alpha.\n\nBeta.\n\nGamma.";
        // 故意按倒序插入
        let map = HashMap::from([
            (2usize, "γ。".to_string()),
            (0usize, "α。".to_string()),
            (1usize, "β。".to_string()),
        ]);

        let out = export_bilingual(content, &map, TargetLang::Zh);

        // 顺序由文档决定（不是 HashMap 迭代序）
        assert!(out.contains("Alpha.\n\nα。"), "段 0 对照：\n{out}");
        assert!(out.contains("Beta.\n\nβ。"), "段 1 对照：\n{out}");
        assert!(out.contains("Gamma.\n\nγ。"), "段 2 对照：\n{out}");
    }

    /// 纯中文文档，en 方向（译英文）：所有段都应占号。
    #[test]
    fn pure_chinese_doc_translated_to_english() {
        let content = "第一段。\n\n第二段。\n\n第三段。";
        let map = HashMap::from([
            (0usize, "First.".to_string()),
            (1usize, "Second.".to_string()),
            (2usize, "Third.".to_string()),
        ]);
        let out = export_bilingual(content, &map, TargetLang::En);

        // 3 个段落都对照
        assert!(out.contains("第一段。\n\nFirst."), "段 0：\n{out}");
        assert!(out.contains("第二段。\n\nSecond."), "段 1：\n{out}");
        assert!(out.contains("第三段。\n\nThird."), "段 2：\n{out}");

        // 整体顺序：源 → 译 → 源 → 译 → 源 → 译
        let expect = "第一段。\n\nFirst.\n\n第二段。\n\nSecond.\n\n第三段。\n\nThird.\n";
        assert_eq!(out, expect);
    }

    /// 纯英文文档，zh 方向（译中文）：所有段都应占号。
    /// （与 Cycle 1 测试结构对称，但**方向相反**——守住 `data-bi` 方向相关
    /// 的两端都能跑通。）
    #[test]
    fn pure_english_doc_translated_to_chinese() {
        let content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
        let map = HashMap::from([
            (0usize, "第一段。".to_string()),
            (1usize, "第二段。".to_string()),
            (2usize, "第三段。".to_string()),
        ]);
        let out = export_bilingual(content, &map, TargetLang::Zh);

        let expect = "First paragraph.\n\n第一段。\n\nSecond paragraph.\n\n第二段。\n\nThird paragraph.\n\n第三段。\n";
        assert_eq!(out, expect);
    }

    /// **中英混排**语料——这是「data-bi 方向相关」这条规则真正的考验。
    /// 同一份文档在两种方向下：
    /// - **en 方向**（译英文）：纯中文段（占号）+ ASCII 段（跳过），对照**只有中文段**
    /// - **zh 方向**（译中文）：ASCII 段（占号）+ 纯中文段（跳过），对照**只有英文段**
    ///
    /// 反向守卫：若实现按"文档序固定为 0..N"分配 data-bi，混排下译出来的
    /// 对照就会让 0 号原文对 1 号译文、1 号对 0 号——对照完全错位。
    #[test]
    fn mixed_doc_yields_different_alignment_per_direction() {
        // 4 段：英/中/英/中
        let content = "First English.\n\n第一中文。\n\nSecond English.\n\n第二中文。";

        // zh 方向：ASCII 段（0/2）占号，纯中文段被跳过 → data-bi = {0, 1}
        // 译文表只有 2 项，正好对应原文 0/2
        let zh_map = HashMap::from([
            (0usize, "第一英文。".to_string()),
            (1usize, "第二英文。".to_string()),
        ]);
        let out_zh = export_bilingual(content, &zh_map, TargetLang::Zh);
        assert!(
            out_zh.contains("First English.\n\n第一英文。"),
            "zh 方向段 0 对照：\n{out_zh}"
        );
        assert!(
            out_zh.contains("Second English.\n\n第二英文。"),
            "zh 方向段 2 对照：\n{out_zh}"
        );
        // 纯中文段没对照（它们不是 data-bi）——只能原文出现一次
        let cn_in_zh = out_zh.matches("第一中文。").count();
        assert_eq!(cn_in_zh, 1, "纯中文段不出对照槽：\n{out_zh}");
        let cn2_in_zh = out_zh.matches("第二中文。").count();
        assert_eq!(cn2_in_zh, 1, "纯中文段不出对照槽：\n{out_zh}");

        // en 方向：纯中文段（0/1）占号，ASCII 段被跳过 → data-bi = {0, 1}
        let en_map = HashMap::from([
            (0usize, "First Chinese.".to_string()),
            (1usize, "Second Chinese.".to_string()),
        ]);
        let out_en = export_bilingual(content, &en_map, TargetLang::En);
        assert!(
            out_en.contains("第一中文。\n\nFirst Chinese."),
            "en 方向段 0 对照：\n{out_en}"
        );
        assert!(
            out_en.contains("第二中文。\n\nSecond Chinese."),
            "en 方向段 1 对照：\n{out_en}"
        );
        // ASCII 段没对照
        let en_in_en = out_en.matches("First English.").count();
        assert_eq!(en_in_en, 1, "ASCII 段在 en 方向不出对照槽：\n{out_en}");
        let en2_in_en = out_en.matches("Second English.").count();
        assert_eq!(en2_in_en, 1, "ASCII 段在 en 方向不出对照槽：\n{out_en}");
    }
}