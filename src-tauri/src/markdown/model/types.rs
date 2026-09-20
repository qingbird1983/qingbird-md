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
}
