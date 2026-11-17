//! 翻译方向策略：目标语言、可译判定、缓存键方向标签。
//!
//! 自 `engine.rs` 提取（P0-1 拆分）：判定逻辑、缓存键格式原样搬迁，
//! 只有模块位置变了；Step 1 起本文件另外承载 `TargetLang::from_tag` 这类
//! 「方向怎么进系统」的收口。
//!
//! 为什么单独成模块：「怎么判定 / 缓存怎么按方向区分」与「怎么跑」是两个
//! 不同的变化原因。Step 1 接入语言切换时，改动全部落在本文件，不必在千行的
//! `engine.rs` 里翻找。

// （方向策略不依赖 batch：LLM 批量协议随 AI 功能一并移除。）

/// 翻译方向 = 目标语言。
///
/// **Step 0**：把"方向"从全局隐含状态变成**一个显式参数**，所有调用点先统一传
/// [`TargetLang::Zh`]，行为与改动前逐位一致。
/// **Step 1**：接上 UI 双向切换（中 ⇄ 英），方向从 `translate_document` 入参
/// 一路贯穿到 provider 请求体与 html 渲染。
///
/// 为什么它必须显式、且必须进缓存 key：中英混排文档里同一个串（如
/// `Hello 世界`）会同时出现在两个方向的单元集合里，方向不同的译文不同。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetLang {
    /// 译成简体中文（en → zh）。
    Zh,
    /// 译成英文（zh → en）。
    En,
}

impl TargetLang {
    /// 缓存 key 里的稳定短标签。
    ///
    pub fn tag(self) -> &'static str {
        match self {
            TargetLang::Zh => "zh",
            TargetLang::En => "en",
        }
    }

    /// 缓存键短标签 → 方向（命令入参 / 设置字段的解析口）。
    ///
    /// **未知值一律回落 [`TargetLang::Zh`]，不报错**：方向来自命令入参或盘上的
    /// 配置文件，两者都可能被手改、可能来自旧版本、将来还可能多出语种。
    /// 方向解析失败不该让整篇翻译直接失败——回落到改动前的行为最安全。
    pub fn from_tag(tag: &str) -> Self {
        match tag.trim() {
            "en" => TargetLang::En,
            _ => TargetLang::Zh,
        }
    }
}

/// CJK / 全角标点区段判定。用于「译成英文时哪些文本才需要译」。
///
/// 刻意**不用** `!c.is_ascii()`：那会把弯引号 `“ ” ’`、破折号 `—` 也算成
/// "需要翻译"，纯英文段落里带个弯引号就会被无谓送去翻一遍（白烧 token，
/// 且回来的还是原文）。
fn has_cjk(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32,
            0x3000..=0x303F   // CJK 标点
            | 0x3040..=0x30FF // 平/片假名
            | 0x3400..=0x4DBF // 扩展 A
            | 0x4E00..=0x9FFF // 基本区
            | 0xF900..=0xFAFF // 兼容表意
            | 0xFF00..=0xFFEF // 全角形式
            | 0x20000..=0x2FA1F // 扩展 B 及以后
        )
    })
}

/// 该文本在 `target` 方向下是否需要翻译。
///
/// 判据 = 「含**非目标语言**的字母/字符」：
/// - 译成中文：含 ASCII 字母才要译（纯中文/数字/符号不动）
/// - 译成英文：含 CJK 才要译（纯英文/数字/符号不动）
///
/// ⚠️ **这个函数的调用方必须与索引空间逐位一致**（见 [`crate::markdown::units`]
/// 与 [`crate::markdown::html::render_html`] 的注释）：它同时决定
/// `data-bi` 的占号与收集，单点改方向就会让译文贴错块。所以方向是**参数**，
/// 不是全局状态——三处必须拿到同一个值。
pub fn needs_translation(text: &str, target: TargetLang) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return false;
    }
    match target {
        TargetLang::Zh => compact.chars().any(|c| c.is_ascii_alphabetic()),
        TargetLang::En => has_cjk(&compact),
    }
}

/// Cache-key variant: the direction tag.
///
/// ⚠️ **免费/专业 MT 源也依赖方向**——MyMemory 发的是 `langpair=en|zh-CN`，
/// 腾讯发的是 `"target":{"lang":"zh"}`。改动前 LLM 之外的分支返回**空串**，等于让
/// 两个方向共用同一个 key：中英混排文档第二遍反向翻译会命中第一遍的译文，
/// **不报错、只给错答案**。所以这里不再有"空 variant"这条捷径。
///
/// `provider` / `model` 参数保留仅为调用点形状稳定（所有 provider 走同一签名）：
/// 非 LLM 源不按模型区分缓存，方向才是唯一维度。
pub fn cache_variant(_provider: &str, _model: &str, target: TargetLang) -> String {
    target.tag().to_string()
}

/// **无方向入参路径的兜底方向**：划词/查词这类没有语言选择入口的调用点，
/// 以及测试与老配置，一律取这里。**有方向入参的路径不许用它**——那等于悄悄
/// 把用户选的方向丢掉。
///
/// 为什么要有这个函数而不是到处写 `TargetLang::Zh`：所有生产调用点都必须
/// 经由此函数取方向——**看到直接写 `TargetLang::Zh` 的生产代码就是 bug**
/// （它绕过了这条唯一的默认值收口）。
pub const fn default_target() -> TargetLang {
    TargetLang::Zh
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::cache::Cache;

    /// 测试默认方向 = 译成中文（= Step 0 的生产行为）。
    const ZH: TargetLang = TargetLang::Zh;

    #[test]
    fn needs_translation_into_chinese_skips_chinese_and_symbols() {
        assert!(needs_translation("Hello world", ZH));
        assert!(needs_translation("mixed 中文 here", ZH));
        assert!(!needs_translation("这是纯中文", ZH));
        assert!(!needs_translation("12345", ZH));
        assert!(!needs_translation("   ", ZH));
    }

    #[test]
    fn needs_translation_into_english_inverts_the_predicate() {
        // H1：改前 needs_translation 是"含 ASCII 字母才译"，方向无关 →
        // 译成英文时**纯中文段返回 false，整段静默跳过**（最严重的那条）。
        assert!(
            needs_translation("这是纯中文", TargetLang::En),
            "纯中文段在 zh→en 必须可译"
        );
        assert!(needs_translation("mixed 中文 here", TargetLang::En));
        assert!(
            !needs_translation("Hello world", TargetLang::En),
            "纯英文段译成英文无需处理"
        );
        assert!(!needs_translation("12345", TargetLang::En));
        assert!(!needs_translation("   ", TargetLang::En));
    }

    #[test]
    fn needs_translation_into_english_ignores_latin_punctuation() {
        // 判据用 CJK 区段而不是 `!is_ascii()`：否则纯英文段里一个弯引号
        // 就会被判成"需要翻译"，白送一次请求且回来的还是原文。
        assert!(!needs_translation("it’s fine — really", TargetLang::En));
        assert!(!needs_translation("“quoted ASCII”", TargetLang::En));
        assert!(needs_translation("中文，全角标点。", TargetLang::En));
    }

    #[test]
    fn tag_round_trips_and_unknown_values_fall_back_to_chinese() {
        for t in [TargetLang::Zh, TargetLang::En] {
            assert_eq!(TargetLang::from_tag(t.tag()), t, "tag 必须可往返");
        }
        // 方向来自命令入参和盘上的配置，两者都可能手改/来自旧版本/将来多语种。
        // 这里只要求**不 panic、回落到改动前行为**，不要求报错。
        for junk in ["", "  ", "zh", "ja", "EN", "english"] {
            assert_eq!(TargetLang::from_tag(junk), TargetLang::Zh, "{junk:?}");
        }
    }

    #[test]
    fn direction_is_part_of_the_cache_key_for_every_provider() {
        // H3 回归（本次 patch 的主修复）：中英混排文档里 "Hello 世界" 会同时
        // 出现在两个方向的单元集合里。variant 不含方向 → 第二遍反向翻译命中
        // 第一遍的译文，**不报错、只给错答案**。
        for provider in [
            "mymemory",
            "transmart",
            "iciba",
            "tencent",
            "baidu",
            "youdao",
            "auto",
        ] {
            let zh = cache_variant(provider, "m", TargetLang::Zh);
            let en = cache_variant(provider, "m", TargetLang::En);
            assert_ne!(zh, en, "{provider}: variant 必须区分方向");
            assert!(
                !zh.is_empty() && !en.is_empty(),
                "{provider}: variant 不得为空串"
            );
        }
    }

    #[test]
    fn same_text_in_two_directions_never_shares_a_cache_entry() {
        let mut c = Cache::new();
        let zh = cache_variant("transmart", "m", TargetLang::Zh);
        let en = cache_variant("transmart", "m", TargetLang::En);
        c.set(
            Cache::key("transmart", &zh, "Hello 世界"),
            "你好世界".into(),
        );
        assert_eq!(
            c.get(&Cache::key("transmart", &zh, "Hello 世界")),
            Some("你好世界")
        );
        assert!(
            c.get(&Cache::key("transmart", &en, "Hello 世界"))
                .is_none(),
            "同串反向必须 miss——这正是改前的串味形态"
        );
    }
}
