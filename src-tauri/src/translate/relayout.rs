//! 重排版规则集（A 计划 §五 第 5 步 22，L3 定稿）。
//!
//! 一组**纯确定性、方向相关、幂等、不改块数**的排版规范化，作用在**单条译文
//! 文本**上。它只在用户点「另存为」导出 `.md` 的那一刻、由 `export_translation`
//! 对 `translations` 表的每个 value 施加（见 `bridge/commands.rs`）——绝不进
//! 实时预览、译文 store、Cache（预览期改内容会清译文）。
//!
//! # 为什么安全（不改块数 / 不动索引空间）
//!
//! 本模块只重写字符串 value，**从不增删 map 条目、从不跨 value**，所以
//! `data-bi`/`data-ri` 的 key 集合施加前后完全一致，双语对照的「段段对齐」
//! 不变量（§四 L3 硬约束、红线 8）天然成立。它也不参与 `needs_translation`
//! 的占号判定——[`is_han`] 只是排版用的字符分类，与红线 1「needs_translation
//! 三处同步」无关，独立实现不会引起索引漂移。
//!
//! # 施加顺序（固定，保证幂等）
//!
//! 省略号 → 破折号 → 标点全/半角 → 中英间距。每条各自幂等，叠加后整体幂等。

use crate::translate::engine::TargetLang;

/// 汉字 / 假名（含扩展与兼容表意）。**刻意不含** CJK 标点与全角形式——
/// 中英间距只在「表意文字 ↔ 拉丁/数字」边界插空，标点两侧不加空格。
fn is_han(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF      // 平/片假名
        | 0x3400..=0x4DBF    // 扩展 A
        | 0x4E00..=0x9FFF    // 基本区
        | 0xF900..=0xFAFF    // 兼容表意
        | 0x20000..=0x2FA1F  // 扩展 B 及以后
    )
}

/// 拉丁字母 / 数字（半角 ASCII）。中英间距的另一侧。
fn is_latin_or_digit(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// 对单条译文施加确定性重排版（§五 第 5 步 22）。方向决定全/半角取向。
///
/// 幂等：`relayout(&relayout(text, target), target) == relayout(text, target)`。
pub fn relayout(text: &str, target: TargetLang) -> String {
    if text.is_empty() {
        return String::new();
    }
    let s = normalize_ellipsis(text, target);
    let s = normalize_dash(&s, target);
    let s = convert_punctuation(&s, target);
    let s = insert_cjk_spacing(&s);
    s
}

/// 省略号：ASCII 三点/六点 → 目标形态（zh：`……` 双省略号；en：`…` 单省略号）。
///
/// **数字相邻的 `.` 序列不动**（`1...2` 之类极少，宁可漏转不误伤）。已是目标
/// 形态的 `…` 保持，保证幂等。
fn normalize_ellipsis(text: &str, target: TargetLang) -> String {
    let chars: Vec<char> = text.chars().collect();
    let ellipsis = match target {
        TargetLang::Zh => "……",
        TargetLang::En => "…",
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '.' {
            // 数一段连续的 '.'
            let mut j = i;
            while j < chars.len() && chars[j] == '.' {
                j += 1;
            }
            let run = j - i;
            let prev_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let next_digit = j < chars.len() && chars[j].is_ascii_digit();
            if run >= 3 && !prev_digit && !next_digit {
                out.push_str(ellipsis);
            } else {
                for _ in 0..run {
                    out.push('.');
                }
            }
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// 破折号：ASCII 成对 `--` → 目标形态（zh：`——`；en：`—`）。
///
/// 只在**非行首**、且左右都不是 `-` 时替换，避开 markdown 列表/前置符与长串
/// `---`（块级规则线不进 run，纯文本里也极少）。已是 `—`/`——` 不动，保证幂等。
fn normalize_dash(text: &str, target: TargetLang) -> String {
    let chars: Vec<char> = text.chars().collect();
    let dash = match target {
        TargetLang::Zh => "——",
        TargetLang::En => "—",
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        let at_line_start = i == 0 || chars[i - 1] == '\n';
        if chars[i] == '-'
            && i + 1 < chars.len()
            && chars[i + 1] == '-'
            && !at_line_start
            && (i == 0 || chars[i - 1] != '-')
            && (i + 2 >= chars.len() || chars[i + 2] != '-')
        {
            out.push_str(dash);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// 标点全/半角转换（方向相关，保守子集）。
///
/// - `Zh`：半角 `, ; : ! ?` 紧邻汉字→全角；`()` 邻汉字→全角；句末单个 `.`
///   **仅当前一字符是汉字**时→`。`（`3.14`/`v1.2`/缩写一律不动）。
/// - `En`：全角 `，；：！？。（）、`→对应半角。
///
/// 判据基于**转换前**的邻居（邻居里的汉字在两种规则下都不变），稳定且幂等。
fn convert_punctuation(text: &str, target: TargetLang) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for i in 0..chars.len() {
        let c = chars[i];
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied();
        out.push(match target {
            TargetLang::Zh => zh_mark(c, prev, next),
            TargetLang::En => en_mark(c, prev, next),
        });
    }
    out
}

fn zh_mark(c: char, prev: Option<char>, next: Option<char>) -> char {
    let near_han = |p: Option<char>, n: Option<char>| {
        p.map_or(false, is_han) || n.map_or(false, is_han)
    };
    match c {
        ',' if near_han(prev, next) => '，',
        ';' if near_han(prev, next) => '；',
        ':' if near_han(prev, next) => '：',
        '!' if near_han(prev, next) => '！',
        '?' if near_han(prev, next) => '？',
        '(' if next.map_or(false, is_han) => '（',
        ')' if prev.map_or(false, is_han) => '）',
        // 句末点号：前一是汉字（排除数字小数、字母缩写）才转句号
        '.' if prev.map_or(false, is_han) => '。',
        _ => c,
    }
}

fn en_mark(c: char, _prev: Option<char>, _next: Option<char>) -> char {
    match c {
        '，' => ',',
        '；' => ';',
        '：' => ':',
        '！' => '!',
        '？' => '?',
        '。' => '.',
        '（' => '(',
        '）' => ')',
        '、' => ',',
        _ => c,
    }
}

/// 中英间距（盘古之白）：表意文字 ↔ 拉丁/数字 之间补一个半角空格。
///
/// 已有空格/其它字符不重复插；标点（半或全角）不属于两侧，故标点附近不加空
/// 格。幂等。
fn insert_cjk_spacing(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + chars.len() / 4);
    for i in 0..chars.len() {
        out.push(chars[i]);
        if i + 1 < chars.len() {
            let a = chars[i];
            let b = chars[i + 1];
            let need = (is_han(a) && is_latin_or_digit(b))
                || (is_latin_or_digit(a) && is_han(b));
            if need {
                out.push(' ');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::engine::TargetLang::*;

    fn r(s: &str, t: TargetLang) -> String {
        relayout(s, t)
    }

    #[test]
    fn cjk_spacing_both_directions() {
        assert_eq!(r("使用Vue框架", Zh), "使用 Vue 框架");
        assert_eq!(r("版本2.0发布", Zh), "版本 2.0 发布");
        assert_eq!(r("用 React 写", Zh), "用 React 写"); // 已有空格不动
    }

    #[test]
    fn cjk_spacing_idempotent() {
        let once = r("读PDF文件", Zh);
        assert_eq!(r(&once, Zh), once);
    }

    #[test]
    fn zh_punctuation_only_near_han() {
        assert_eq!(r("你好,世界", Zh), "你好，世界");
        assert_eq!(r("真的吗?太好了!", Zh), "真的吗？太好了！");
        assert_eq!(r("注意:看这里", Zh), "注意：看这里");
    }

    #[test]
    fn zh_keeps_decimal_and_english_period() {
        // 小数、英文句、缩写一律不动
        assert_eq!(r("版本 3.14 稳定", Zh), "版本 3.14 稳定");
        assert_eq!(r("Hello world.", Zh), "Hello world.");
        assert_eq!(r("见 v1.2。", Zh), "见 v1.2。");
    }

    #[test]
    fn zh_sentence_final_period_after_han() {
        assert_eq!(r("这样很好.", Zh), "这样很好。");
    }

    #[test]
    fn zh_paren_near_han() {
        assert_eq!(r("参数(必填)默认", Zh), "参数（必填）默认");
    }

    #[test]
    fn ellipsis_both_directions() {
        assert_eq!(r("等等...", Zh), "等等……");
        assert_eq!(r("待续......", Zh), "待续……");
        assert_eq!(r("wait...", En), "wait…");
    }

    #[test]
    fn dash_both_directions() {
        assert_eq!(r("真正的问题--不是工具", Zh), "真正的问题——不是工具");
        assert_eq!(r("the point--not the tool", En), "the point—not the tool");
        // 行首与三连不动（避开列表符 / 长串）
        assert_eq!(r("--start", Zh), "--start");
    }

    #[test]
    fn en_fullwidth_to_halfwidth() {
        // en 方向下译文一般是英文，只是偶带全角标点 → 转回半角
        assert_eq!(r("Hello，world！ok。", En), "Hello,world!ok.");
        assert_eq!(r("苹果、香蕉", En), "苹果,香蕉");
    }

    #[test]
    fn pure_ascii_and_pure_han_untouched_by_punctuation() {
        assert_eq!(r("plain english text", Zh), "plain english text");
        assert_eq!(r("纯中文没有标点", Zh), "纯中文没有标点");
    }

    #[test]
    fn empty_and_whitespace_safe() {
        assert_eq!(r("", Zh), "");
        assert_eq!(r("   ", Zh), "   ");
    }

    #[test]
    fn whole_pipeline_is_idempotent() {
        let cases = [
            "使用Vue,对api..做了--优化,版本1...3.",
            "读PDF文件,然后跑test...",
            "the answer is 42--clear.",
        ];
        for t in [Zh, En] {
            for c in cases {
                let once = r(c, t);
                let twice = r(&once, t);
                assert_eq!(once, twice, "非幂等：{c:?} 方向 {t:?}");
            }
        }
    }
}
