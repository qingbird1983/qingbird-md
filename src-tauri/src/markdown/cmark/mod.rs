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
//!
//! P2-7g 拆分布局：escape = 纯转义函数（零状态）；writer = 导出入口与
//! Md 序列化器（data-ri run 计数只在 `Inline::Text` 推进，逻辑一行不动）。

mod escape;
mod writer;

pub use writer::{export_translation, front_matter, render_block_for_export};
