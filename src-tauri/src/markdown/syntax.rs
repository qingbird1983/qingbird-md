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

/// Highlight `code` into foreground-colored spans (skipping background colors,
/// which egui text formatting can't render). Returns `None` when the language
/// is unknown or absent, so callers can fall back to plain monospace.
pub fn highlight_spans(code: &str, lang: Option<&str>) -> Option<Vec<(Color, String)>> {
    let lang = lang?;
    let syn = find_syntax(lang)?;
    let mut h = HighlightLines::new(syn, &themes().themes["base16-ocean.dark"]);
    let mut spans: Vec<(Color, String)> = Vec::new();
    for line in LinesWithEndings::from(code) {
        if let Ok(ranges) = h.highlight_line(line, syntaxes()) {
            for (style, s) in ranges {
                if let Some((color, buf)) = spans.last_mut() {
                    if *color == style.foreground {
                        buf.push_str(s);
                        continue;
                    }
                }
                spans.push((style.foreground, s.to_string()));
            }
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
