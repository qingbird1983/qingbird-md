//! 顶层块源行锚点：与 parse_blocks 同源 options、镜像其顶层事件消费方式。

use pulldown_cmark::{Event, Parser, Tag};

use super::options;

/// 每个顶层块的源起始行号（1 起），与 [`parse_blocks`] 的返回**逐项对齐**：
/// 第 i 行号属于 `parse_blocks(md)[i]`。
///
/// 存在的理由：预览渲染是 HTML 字符串，DOM 元素本身不知道自己在源码第几行，
/// 而「分栏左右同步滚动」「预览选区映射回源码」都只认源行号这一个公共坐标
/// （两侧像素高差可达十倍，按比例同步必然越滚越偏）。html.rs 把这个行号写成
/// `<!--sl:N-->` 注释挂在块前，前端据此建锚点表。
///
/// 对齐的保证方式是**镜像 parse_blocks 的顶层消费方式**：
/// - `Start(MetadataBlock)` 整块跳过，不占位（parse_blocks 亦然）；
/// - 其余 `Start(tag)` 记一行号后整棵子树跳过（parse_blocks 交给 consume_block
///   消费全部子事件）；
/// - `Rule` / `DisplayMath` 各占一位（parse_blocks 里是独立分支）。
/// 块数一致性由 `top_level_block_lines_align_with_parse_blocks` 单测钉住。
pub fn top_level_block_lines(md: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut it = Parser::new_ext(md, options()).into_offset_iter();
    while let Some((ev, range)) = it.next() {
        match ev {
            Event::Start(Tag::MetadataBlock(_)) => {
                for (inner, _) in it.by_ref() {
                    if matches!(inner, Event::End(_)) {
                        break;
                    }
                }
            }
            Event::Start(_) => {
                out.push(line_of(md, range.start));
                skip_subtree(&mut it);
            }
            Event::Rule | Event::DisplayMath(_) => out.push(line_of(md, range.start)),
            _ => {}
        }
    }
    out
}

/// 跳过一棵已 `Start` 的子树（含配对 `End`）；事件流提前结束也不 panic。
fn skip_subtree<'a>(it: &mut impl Iterator<Item = (Event<'a>, std::ops::Range<usize>)>) {
    let mut depth = 1usize;
    while depth > 0 {
        match it.next() {
            Some((Event::Start(_), _)) => depth += 1,
            Some((Event::End(_), _)) => depth -= 1,
            Some(_) => {}
            None => break,
        }
    }
}

/// 字节偏移 → 1 起行号（偏移总是字符边界，偏移前的 '\n' 数即行号差）。
fn line_of(md: &str, offset: usize) -> usize {
    md.as_bytes()[..offset.min(md.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count()
        + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::model::{parse_blocks, Block, Inline};

    // ---- 顶层块源行锚点（分栏同步用，2026-09-14）----

    #[test]
    fn top_level_block_lines_align_with_parse_blocks() {
        // 覆盖会走不同分支的形态：front matter（整块跳过不占位）、脚注定义、
        // 分割线、独立 $$ 公式（pulldown 包在 Paragraph 里）、表格、引用、
        // 列表、代码围栏。
        let md = "---\ntitle: T\n---\n\n# 标题\n\n正文段落。\n\n> 引用\n> 第二行\n\n\
                  - 项 1\n- 项 2\n\n```rust\nlet a = 1;\n```\n\n---\n\n$$\nE = mc^2\n$$\n\n\
                  | a | b |\n| --- | --- |\n| 1 | 2 |\n\n脚注引用[^a]。\n\n[^a]: 定义正文。\n";
        let blocks = parse_blocks(md);
        let lines = top_level_block_lines(md);
        assert_eq!(
            lines.len(),
            blocks.len(),
            "块数与行号数不一致 → 源行锚点会整体错位\nlines={lines:?}\nblocks={blocks:?}"
        );
        assert_eq!(
            lines,
            vec![5, 7, 9, 12, 15, 19, 21, 25, 29, 31],
            "行号必须与 parse_blocks 的顶层顺序逐项对应：{blocks:?}"
        );
    }

    #[test]
    fn top_level_block_lines_are_one_based() {
        assert_eq!(top_level_block_lines("hi"), vec![1]);
        // 前导空行计入行号
        assert_eq!(top_level_block_lines("\n\n\nhi"), vec![4]);
        // 多行（软换行）段落只占首行
        assert_eq!(top_level_block_lines("a\nb\nc"), vec![1]);
        // 空文档无块
        assert!(top_level_block_lines("").is_empty());
    }

    #[test]
    fn top_level_block_lines_do_not_count_nested_starts() {
        // 引用/列表/表格内部的 Start 事件不得各自占位——否则行号数与块数
        // 会远大于实际（这是本函数唯一的对齐风险点）。
        assert_eq!(top_level_block_lines("> 引用里的**加粗**").len(), 1);
        assert_eq!(top_level_block_lines("- 项 **粗**\n- 项 2").len(), 1);
        assert_eq!(top_level_block_lines("| a | b |\n| --- | --- |\n| 1 | 2 |").len(), 1);
    }
}
