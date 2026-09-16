//! 分批与分片策略：把单元切成请求批、按视口语义排批、超长单元切分。
//!
//! 自 `engine.rs` 提取（P0-1 拆分），内容为**原样搬迁**。全部是纯函数、零副作用
//! ——也是整套翻译链路里最好测的一块。

/// Tuning knobs for a run.
#[derive(Clone, Copy, Debug)]
pub struct EngineConfig {
    /// Max units packed into one request.
    pub units_per_batch: usize,
    /// Max characters in one request (a unit longer than this goes alone).
    pub max_batch_chars: usize,
    /// Concurrent workers (and therefore concurrent requests).
    pub concurrency: usize,
    /// Per-request timeout.
    pub timeout_ms: u64,
}

impl EngineConfig {
    /// Pick sensible knobs for a provider.
    ///
    /// LLM batches are small so the first unit appears quickly; free engines
    /// are request-bound rather than decode-bound, so they favour more
    /// parallelism and no batching protocol at all.
    pub fn for_provider(provider: &str, max_len: usize, max_concurrency: usize) -> Self {
        if provider == "llm" {
            EngineConfig {
                units_per_batch: 8,
                max_batch_chars: ((max_len as f32) * 0.8) as usize,
                concurrency: max_concurrency.max(1),
                timeout_ms: 120_000,
            }
        } else {
            EngineConfig {
                units_per_batch: 4,
                max_batch_chars: ((max_len as f32) * 0.8) as usize,
                concurrency: max_concurrency.max(1),
                timeout_ms: 30_000,
            }
        }
    }
}

/// Group unit indices into batches by unit count and character budget.
/// An oversized unit becomes a single-unit batch.
pub fn pack_batches(
    units: &[(usize, String)],
    max_units: usize,
    max_chars: usize,
) -> Vec<Vec<usize>> {
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_chars = 0usize;

    for (i, (_, text)) in units.iter().enumerate() {
        let len = text.chars().count();
        if cur.is_empty() && len > max_chars {
            batches.push(vec![i]); // too big to merge with anything
            continue;
        }
        if !cur.is_empty() && (cur.len() >= max_units || cur_chars + len > max_chars) {
            batches.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur.push(i);
        cur_chars += len;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// Order batches so the one containing `viewport` runs first, wrapping around
/// at the end — the document after the viewport is lower priority than the
/// viewport itself but higher than what's far above it.
///
/// Batches are produced in document order, so this is just a rotation.
pub fn order_batches(
    batches: &[Vec<usize>],
    doc_pos: &[usize],
    viewport: Option<usize>,
) -> Vec<usize> {
    let n = batches.len();
    let Some(v) = viewport else {
        return (0..n).collect();
    };
    let start = batches
        .iter()
        .position(|b| b.iter().any(|&i| doc_pos[i] >= v))
        .unwrap_or(0);
    (0..n).map(|k| (start + k) % n).collect()
}

/// Split `text` into chunks of at most `max_len` **characters**, preferring a
/// sentence boundary, then a word boundary, then a hard cut.
///
/// All math is in char units, not bytes: byte-offset slicing on CJK text
/// would panic on non-boundaries and silently mis-split otherwise.
pub fn split_long(text: &str, max_len: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_len {
        return vec![text.to_string()];
    }
    let n = chars.len();
    let min = max_len / 2;
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while n - start > max_len {
        let window_end = start + max_len;
        // Last sentence boundary within [start+min, window_end], in char units.
        let mut cut: Option<usize> = None;
        for p in (start + min)..=window_end {
            if matches!(chars[p - 1], '。' | '！' | '？' | '!' | '?' | '.')
                && chars.get(p).map(|c| c.is_whitespace()).unwrap_or(true)
            {
                cut = Some(p);
            }
        }
        // Then the last word boundary.
        if cut.is_none() {
            for p in ((start + min)..=window_end).rev() {
                if chars[p - 1] == ' ' {
                    cut = Some(p);
                    break;
                }
            }
        }
        let cut = cut.unwrap_or(window_end);
        chunks.push(chars[start..cut].iter().collect::<String>().trim_end().to_string());
        let mut next = cut;
        while next < n && chars[next].is_whitespace() {
            next += 1;
        }
        start = next;
    }
    if start < n {
        chunks.push(chars[start..].iter().collect());
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(chars: &[usize]) -> Vec<(usize, String)> {
        chars
            .iter()
            .enumerate()
            .map(|(i, &n)| (i, "x".repeat(n)))
            .collect()
    }

    #[test]
    fn packs_by_unit_count() {
        let u = units(&[1, 1, 1, 1, 1]);
        assert_eq!(pack_batches(&u, 2, 1000), vec![vec![0, 1], vec![2, 3], vec![4]]);
    }

    #[test]
    fn packs_by_char_budget() {
        let u = units(&[6, 6, 6]);
        assert_eq!(pack_batches(&u, 10, 10), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn oversized_unit_goes_alone() {
        let u = units(&[2, 500, 2]);
        let b = pack_batches(&u, 10, 100);
        // 超限单元必须独占一批：process_batch 只对单单元批做分片，
        // 混进多单元批就会绕过分片直接走批处理协议。
        assert_eq!(b, vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn oversized_leading_unit_does_not_create_empty_batch() {
        let u = units(&[500, 2, 2]);
        let b = pack_batches(&u, 10, 100);
        assert_eq!(b, vec![vec![0], vec![1, 2]]);
    }

    #[test]
    fn viewport_rotates_batch_order() {
        let u = units(&[1, 1, 1, 1]);
        let b = pack_batches(&u, 1, 100);
        let doc_pos: Vec<usize> = u.iter().map(|(d, _)| *d).collect();
        assert_eq!(order_batches(&b, &doc_pos, None), vec![0, 1, 2, 3]);
        assert_eq!(order_batches(&b, &doc_pos, Some(2)), vec![2, 3, 0, 1]);
        assert_eq!(order_batches(&b, &doc_pos, Some(99)), vec![0, 1, 2, 3]);
    }

    #[test]
    fn split_long_prefers_sentence_then_word_boundaries() {
        assert_eq!(split_long("abc", 10), vec!["abc"]);
        let text = "The quick brown fox jumps over the lazy dog. Another sentence here.";
        let parts = split_long(text, 25);
        assert!(parts.len() >= 2, "{parts:?}");
        assert!(parts.iter().all(|p| p.chars().count() <= 25), "{parts:?}");
        assert!(parts.join("").len() <= text.len());
        // A final short remainder is kept, not dropped.
        assert_eq!(parts.join(" "), text);
    }

    #[test]
    fn split_long_counts_characters_not_bytes() {
        // "中文" is 6 bytes but 2 chars: byte-based math would over-split.
        let text = "中".repeat(10);
        let parts = split_long(&text, 4);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert!(parts.iter().all(|p| p.chars().count() <= 4));
    }

    #[test]
    fn config_differs_between_llm_and_free_engines() {
        let llm = EngineConfig::for_provider("llm", 3000, 6);
        let free = EngineConfig::for_provider("transmart", 2000, 12);
        assert_eq!(llm.units_per_batch, 8);
        assert_eq!(llm.concurrency, 6);
        assert_eq!(free.units_per_batch, 4);
        assert_eq!(free.concurrency, 12);
    }
}
