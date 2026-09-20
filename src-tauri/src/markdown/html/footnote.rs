//! 脚注绘制（「给脚注区 write」）：定义 label 预扫编号 + FootnoteDef 聚合。
//! FootnoteDef 分支由根模块的 render_block 在单次遍历内委托至此——内容照常
//! 推进 bi/sub 计数，不引入第二轮渲染。

use std::collections::HashMap;
use std::fmt::Write;

use super::super::model::Block;
use super::inline::escape_html;
use super::Ctx;

/// 递归收集脚注定义 label（文档顺序），编号 1 起。
pub(super) fn collect_fn_labels(blocks: &[Block], nums: &mut HashMap<String, usize>) {
    for b in blocks {
        match b {
            Block::FootnoteDef { label, blocks } => {
                if !nums.contains_key(label) {
                    let next = nums.len() + 1;
                    nums.insert(label.clone(), next);
                }
                collect_fn_labels(blocks, nums);
            }
            Block::Quote { blocks } => collect_fn_labels(blocks, nums),
            Block::List { items, .. } => {
                for it in items {
                    collect_fn_labels(&it.blocks, nums);
                }
            }
            _ => {}
        }
    }
}

impl Ctx<'_> {
    /// 定义不原地渲染——聚合进 fn_html，主流程走完后统一包
    /// `<section class="footnotes">` 追加到文末。内容照常过
    /// render_blocks 推进 bi/sub 计数，walk 顺序与 units 收集器
    /// 一致，索引空间不受搬运影响。
    pub(super) fn render_footnote_def(&mut self, label: &str, blocks: &[Block]) {
        let num = self.fn_nums.get(label).copied().unwrap_or(0);
        let esc = escape_html(label);
        let mut buf = std::mem::take(&mut self.fn_html);
        let _ = write!(
            buf,
            "<li id=\"fn-{esc}\"><span class=\"fn-num\">{num}</span>"
        );
        self.render_blocks(&mut buf, blocks);
        let _ = write!(
            buf,
            "<a class=\"fn-back\" href=\"#fnref-{esc}\" aria-label=\"返回正文\">↩</a></li>"
        );
        self.fn_html = buf;
    }
}
