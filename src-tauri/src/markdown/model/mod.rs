//! Pure, egui-free Markdown document model.
//!
//! `parse_blocks` turns Markdown into a `Vec<Block>` so the renderer (Phase 1)
//! and the translation engine (Phase 2) can both walk the same model. This
//! module has no egui dependency and is fully unit-testable.
//!
//! P2-7e 拆分布局：types = 模型类型；anchors = 顶层块源行锚点（与
//! parse_blocks 共用 [`options`]，事件序镜像）；parse = 解析入口与块级
//! walker（含 MAX_NESTING_DEPTH 与 options 唯一出处）；inlines = 行级
//! walker（折叠/嵌套行内/裸文本收集）。

mod anchors;
mod inlines;
mod parse;
mod types;

pub use anchors::top_level_block_lines;
pub use parse::parse_blocks;
pub use types::{Block, Inline};
pub(crate) use parse::options;
