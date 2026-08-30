use super::model::{Block, Inline};
use crate::translate::pipeline::needs_translation;

/// Concatenated plain text of an inline run.
pub fn inline_plain_text(inlines: &[Inline]) -> String {
    let mut s = String::new();
    for il in inlines {
        match il {
            Inline::Text(t) => s.push_str(t),
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) => s.push_str(&inline_plain_text(x)),
            Inline::Code(c) => s.push_str(c),
            Inline::Link { text, .. } => s.push_str(&inline_plain_text(text)),
            Inline::Image { alt, .. } => s.push_str(alt),
            Inline::LineBreak => s.push(' '),
            Inline::Math(_) => {} // LaTeX 不进翻译 plain text
            Inline::DisplayMath(_) => {}
        }
    }
    s
}

/// Collect translatable inline text *runs* in document order, assigning a
/// running index to every `Inline::Text` (so the renderer can substitute in
/// the same order and keep bold/links/code wrappers intact). Non-translatable
/// runs are still counted but not collected.
pub fn collect_text_runs(blocks: &[Block]) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut out = Vec::new();
    walk_run_collect(blocks, &mut counter, &mut out);
    out
}

fn walk_run_collect(blocks: &[Block], counter: &mut usize, out: &mut Vec<(usize, String)>) {
    for b in blocks {
        match b {
            Block::Heading { text, .. } | Block::Paragraph { text } => {
                collect_runs_inline(text, counter, out);
            }
            Block::Quote { blocks } => walk_run_collect(blocks, counter, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_run_collect(&it.blocks, counter, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    collect_runs_inline(h, counter, out);
                }
                for row in rows {
                    for cell in row {
                        collect_runs_inline(cell, counter, out);
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}

fn collect_runs_inline(inlines: &[Inline], counter: &mut usize, out: &mut Vec<(usize, String)>) {
    for il in inlines {
        match il {
            Inline::Text(t) => {
                let idx = *counter;
                *counter += 1;
                if !t.trim().is_empty() && needs_translation(t) {
                    out.push((idx, t.clone()));
                }
            }
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) => collect_runs_inline(x, counter, out),
            Inline::Link { text, .. } => collect_runs_inline(text, counter, out),
            Inline::Math(_) => {}
            _ => {}
        }
    }
}

/// Collect translatable text units in document order. Each heading/paragraph,
/// and each nested paragraph/list-item/table-cell that needs translation, is
/// assigned a running index. The renderer traverses in the same order with the
/// same `needs_translation` predicate, so indices align.
pub fn collect_translatable(blocks: &[Block]) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut out = Vec::new();
    walk_collect(blocks, &mut counter, &mut out);
    out
}

fn walk_collect(
    blocks: &[Block],
    counter: &mut usize,
    out: &mut Vec<(usize, String)>,
) {
    for b in blocks {
        match b {
            Block::Heading { text, .. } | Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                if needs_translation(&plain) {
                    out.push((*counter, plain));
                    *counter += 1;
                }
            }
            Block::Quote { blocks } => walk_collect(blocks, counter, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_collect(&it.blocks, counter, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    let p = inline_plain_text(h);
                    if needs_translation(&p) {
                        out.push((*counter, p));
                        *counter += 1;
                    }
                }
                for row in rows {
                    for cell in row {
                        let p = inline_plain_text(cell);
                        if needs_translation(&p) {
                            out.push((*counter, p));
                            *counter += 1;
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::{parse_blocks};

    #[test]
    fn collect_runs_indexes_all_texts() {
        // Parity with the egui renderer: every non-empty run with ASCII
        // letters is collected, CJK-only runs are not.
        let blocks = parse_blocks("Hi\n\n中文 skip");
        let runs = collect_text_runs(&blocks);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], (0, "Hi".into()));
        assert_eq!(runs[1], (1, "中文 skip".into()));
    }

    #[test]
    fn collect_translatable_uses_block_plain_text() {
        let blocks = parse_blocks("# Eng title\n\n## 中文标题");
        let u = collect_translatable(&blocks);
        assert_eq!(u.len(), 1);          // 中文标题被 needs_translation 跳过
        assert_eq!(u[0].1, "Eng title");  // inline 前缀不带 "# "
    }
}
