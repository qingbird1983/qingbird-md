//! Syntax highlighting for fenced code blocks, built on syntect (pure-Rust
//! regex engine via `default-fancy`, so no C compiler is needed on Windows).

use std::sync::OnceLock;

use syntect::easy::HighlightLines;
use syntect::highlighting::{Color, ThemeSet};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
static THEMES: OnceLock<ThemeSet> = OnceLock::new();

fn syntaxes() -> &'static SyntaxSet {
    SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn themes() -> &'static ThemeSet {
    THEMES.get_or_init(ThemeSet::load_defaults)
}

fn find_syntax(lang: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
    let ss = syntaxes();
    ss.find_syntax_by_token(lang)
        .or_else(|| ss.find_syntax_by_extension(lang))
        .or_else(|| ss.find_syntax_by_extension(&lang.to_lowercase()))
}

/// Highlight `code` into **dual-theme** foreground spans
/// `(light_fg, dark_fg, text)`：同一语法解析跑两遍——浅色用
/// InspiredGitHub（唯一内置浅色默认主题，白纸面上呈淡灰底深字），暗色用
/// base16-ocean.dark（暗底浅字）。两遍基于同一语法解析器，逐 range 一一
/// 对应，故能按位置配对出同 token 的两套颜色；前端以 CSS 变量 `--cl/--cd`
/// 烘进 span 内联 style，按 body[data-theme] 自动选边（见 markdown.css）。
///
/// Returns `None` when the language is unknown/absent, so callers can fall
/// back to plain monospace.
pub fn highlight_spans(code: &str, lang: Option<&str>) -> Option<Vec<(Color, Color, String)>> {
    let lang = lang?;
    let syn = find_syntax(lang)?;
    let themes = themes();
    let mut hl_light = HighlightLines::new(syn, &themes.themes["InspiredGitHub"]);
    let mut hl_dark = HighlightLines::new(syn, &themes.themes["base16-ocean.dark"]);
    let mut spans: Vec<(Color, Color, String)> = Vec::new();
    for line in LinesWithEndings::from(code) {
        let lr = hl_light.highlight_line(line, syntaxes()).ok()?;
        let dr = hl_dark.highlight_line(line, syntaxes()).ok()?;
        // 两遍共享同一语法解析，range 序列理论上严格同构；万一失配
        // （防御性，宁可退化为 mono 块也不能错位配对颜色）。
        if lr.len() != dr.len() {
            return None;
        }
        for ((ls, lt), (ds, _)) in lr.into_iter().zip(dr) {
            // 配对合并：浅/暗两色都与当前组一致才并入，否则开新组——
            // 保证每组 span 恰好一种 (light, dark) 颜色对。
            if let Some((lc, dc, buf)) = spans.last_mut() {
                if *lc == ls.foreground && *dc == ds.foreground {
                    buf.push_str(&lt);
                    continue;
                }
            }
            spans.push((ls.foreground, ds.foreground, lt.to_string()));
        }
    }
    Some(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_known_language() {
        let spans = highlight_spans("fn main() {}", Some("rust")).expect("rust must highlight");
        assert!(!spans.is_empty());
        // 双主题：浅暗两色应当不同（关键字在浅色主题为深红、暗色主题为浅蓝紫）
        assert!(spans.iter().any(|(l, d, _)| l != d));
    }

    #[test]
    fn no_lang_falls_back_to_plain() {
        assert!(highlight_spans("plain text", None).is_none());
    }

    #[test]
    fn unknown_lang_falls_back_to_plain() {
        assert!(highlight_spans("text", Some("not-a-real-lang-xyz")).is_none());
    }
}
