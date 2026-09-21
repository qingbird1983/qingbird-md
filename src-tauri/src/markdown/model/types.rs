//! 模型类型：行内 run、列表项、块级元素（纯数据，无解析逻辑）。

/// An inline run inside a block. `Strong`/`Emph`/`Del`/`Mark`/`Link` may nest.
#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(String),
    Strong(Vec<Inline>),
    Emph(Vec<Inline>),
    Del(Vec<Inline>),
    /// `==高亮==`（GFM 扩展，pulldown 无原生支持——由 fold_marks 后处理折出）
    Mark(Vec<Inline>),
    Code(String),
    Link { text: Vec<Inline>, href: String },
    Image { alt: String, src: String },
    LineBreak,
    /// `[^label]` 脚注引用（渲染为上标编号，编号对应文末 FootnoteDef）
    FootnoteRef(String),
    Math(String),
    /// pulldown 0.13 把 DisplayMath 也包在 Paragraph 里 emit（实测探针），
    /// 单独成段时由 paragraph_block 升级为 Block::Math{display:true}；
    /// 夹在行文中间时保持行内 span 渲染。
    DisplayMath(String),
}

/// One item in a list, with optional task-list marker.
#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    pub task: Option<bool>,
    pub blocks: Vec<Block>,
}

/// A block-level element.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u8, text: Vec<Inline> },
    Paragraph { text: Vec<Inline> },
    Code { lang: Option<String>, code: String },
    Quote { blocks: Vec<Block> },
    List { ordered: bool, start: u32, items: Vec<ListItem> },
    Rule,
    Image { alt: String, src: String },
    /// aligns 与 headers 同长：0=default/left、1=center、2=right
    /// （GFM 分隔行 `:---:` / `---:`，pulldown Table tag 携带）。
    Table {
        headers: Vec<Vec<Inline>>,
        rows: Vec<Vec<Vec<Inline>>>,
        aligns: Vec<u8>,
    },
    Math { display: bool, tex: String },
    /// `[^label]: 定义正文`（渲染时统一移到文末脚注区，编号与 FootnoteRef 对应）
    FootnoteDef { label: String, blocks: Vec<Block> },
    /// 文首 YAML front matter 的**源码原文**（含首尾 `---` 行）。
    ///
    /// 刻意只存字符串、**不带 `Inline`**：元数据里的 YAML key 是代码而非自然
    /// 语言，不该被翻译，也绝不能进 `content`（译文红线）。不装 Inline 就
    /// 意味着 `html.rs` 不会对它调 `push_inlines`，Run 号与 data-ri 空间
    /// 天然不受影响——这是本变体唯一的形状约束，改回 `Vec<Inline>` 会
    /// 直接错位整篇译文。
    Metadata { raw: String },
    /// 块级 HTML（CommonMark HTML block，type 1–7）的**源码原文**。
    ///
    /// 什么时候会出现：一行以 `<` 开头且命中块级标签/完整标签（`<table …>`、
    /// `<div>`、`<b>x</b>` 独占一行的 type 7……）。富文本编辑器（tiptap / Notion /
    /// Word 导出）粘进 Markdown 的表格、卡片就是这种形态——此前它落进
    /// `consume_block` 的 `_ =>` 兜底成**空段落**，整块内容静默消失。
    ///
    /// 与 [`Block::Metadata`] 同形约束：刻意只存字符串、**不带 `Inline`**。
    /// HTML 标签不是自然语言，既不该进 run 空间（`data-ri`）也不该占块号
    /// （`data-bi`）——一旦挂了 `Inline`，`html.rs::push_inlines` 就会推进
    /// `sub_counter`，整篇译文立刻错位。这是本变体唯一的形状约束。
    Html { raw: String },
}
