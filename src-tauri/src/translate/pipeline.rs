//! Translation pipeline: decide what needs translating, batch adjacent short
//! runs, split long runs, translate concurrently on worker threads, and cache
//! results. Ported from the Electron renderer's batching/chunking logic.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use super::cache::Cache;
use super::http::HttpClient;
use super::providers::{provider as run_provider, Creds};

/// True if `text` contains at least one ASCII letter (i.e. isn't purely
/// Chinese/digits/symbols that don't need translating).
pub fn needs_translation(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    !compact.is_empty() && compact.chars().any(|c| c.is_ascii_alphabetic())
}

/// Split `text` into chunks of at most `max_len`, preferring sentence *then*
/// word boundaries (mirrors the JS `splitLong`).
pub fn split_long(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut rest = text.trim().to_string();
    let min = max_len / 2;
    while rest.len() > max_len {
        let window: String = rest.chars().take(max_len).collect();
        let mut cut: isize = -1;

        // 1) sentence boundary: last 。！？!?. followed by whitespace in the window's latter half
        for p in sentence_boundaries(&window) {
            if p >= min {
                cut = p as isize;
            }
        }
        // 2) word boundary: last space in the latter half
        if cut < 0 {
            if let Some(w) = window.rfind(' ').filter(|&w| w >= min) {
                cut = w as isize;
            }
        }
        // 3) hard cut
        if cut < 0 {
            cut = max_len as isize;
        }
        let cut = cut as usize;
        chunks.push(rest[..cut].to_string());
        rest = rest[cut..].trim_start().to_string();
    }
    if !rest.is_empty() {
        chunks.push(rest);
    }
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

/// Byte indices just after a sentence-ending punctuation followed by whitespace.
fn sentence_boundaries(window: &str) -> Vec<usize> {
    let mut v = Vec::new();
    for (i, c) in window.char_indices() {
        if matches!(c, '。' | '！' | '？' | '!' | '?' | '.') {
            let after = window[i + c.len_utf8()..].chars().next();
            if after.map(|a| a.is_whitespace()).unwrap_or(true) {
                v.push(i + c.len_utf8());
            }
        }
    }
    v
}

/// Group unit indices into batches, merging adjacent short units up to
/// `merge_cap` (≈0.8·max_len); oversized units become single-element batches.
/// Test-only mirror of the batching loop inlined in [`translate_units`]
/// (production interleaves cache-hit filtering, so it cannot call this).
#[cfg(test)]
pub fn batch_units(texts: &[String], max_len: usize) -> Vec<Vec<usize>> {
    let merge_cap = ((max_len as f32) * 0.8) as usize;
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_len = 0;
    for (i, t) in texts.iter().enumerate() {
        let l = t.len();
        if l > merge_cap {
            if !cur.is_empty() {
                batches.push(std::mem::take(&mut cur));
                cur_len = 0;
            }
            batches.push(vec![i]);
        } else if !cur.is_empty() && cur_len + l > merge_cap {
            batches.push(std::mem::take(&mut cur));
            cur = vec![i];
            cur_len = l;
        } else {
            cur.push(i);
            cur_len += l;
        }
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// Translate a list of text units, with cache, batching, and concurrency.
/// Results are returned aligned to the input indices.
#[allow(clippy::too_many_arguments)]
pub fn translate_units(
    texts: &[String],
    provider: &str,
    creds: &Creds,
    max_len: usize,
    max_conc: usize,
    cache: &mut Cache,
    http: &(dyn HttpClient + Sync),
    progress: &(dyn Fn(usize, usize) + Sync),
) -> Vec<Result<String, String>> {
    let n = texts.len();
    let mut results: Vec<Option<Result<String, String>>> = (0..n).map(|_| None).collect();

    // First pass: cache hits + prepare batches for the rest.
    let mut batches: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_len = 0;
    let merge_cap = ((max_len as f32) * 0.8) as usize;
    let mut total_do = 0usize;
    for (i, t) in texts.iter().enumerate() {
        let key = Cache::key(provider, t);
        if let Some(v) = cache.get(&key) {
            results[i] = Some(Ok(v.to_string()));
            continue;
        }
        total_do += 1;
        let l = t.len();
        if l > merge_cap {
            if !cur.is_empty() {
                batches.push(std::mem::take(&mut cur));
                cur_len = 0;
            }
            batches.push(vec![i]);
        } else if !cur.is_empty() && cur_len + l > merge_cap {
            batches.push(std::mem::take(&mut cur));
            cur = vec![i];
            cur_len = l;
        } else {
            cur.push(i);
            cur_len += l;
        }
    }
    if !cur.is_empty() {
        batches.push(cur);
    }

    if batches.is_empty() {
        progress(total_do, total_do);
        return results.into_iter().map(|r| r.unwrap_or_else(|| Err("未翻译".to_string()))).collect();
    }

    let next_batch = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results_mutex = Mutex::new(results);
    let pool = max_conc.max(1).min(batches.len());

    std::thread::scope(|s| {
        for _ in 0..pool {
            s.spawn(|| {
                loop {
                    let b = next_batch.fetch_add(1, Ordering::SeqCst);
                    if b >= batches.len() {
                        break;
                    }
                    let idxs: Vec<usize> = batches[b].clone();
                    let vals = translate_batch(&idxs, texts, provider, creds, max_len, http);
                    let mut g = results_mutex.lock().unwrap();
                    for (i, v) in vals.into_iter() {
                        g[i] = Some(v);
                    }
                    drop(g);
                    done.fetch_add(idxs.len(), Ordering::SeqCst);
                    progress(done.load(Ordering::SeqCst), total_do);
                }
            });
        }
    });

    let results = results_mutex.into_inner().unwrap();
    let mut out = Vec::with_capacity(n);
    for (i, r) in results.into_iter().enumerate() {
        match r {
            Some(Ok(v)) => {
                cache.set(Cache::key(provider, &texts[i]), v.clone());
                out.push(Ok(v));
            }
            Some(Err(e)) => out.push(Err(e)),
            None => out.push(Err("翻译被取消".to_string())),
        }
    }
    progress(total_do, total_do);
    out
}

/// Translate a batch. When the batch merges several units and the provider
/// returns one line per unit, they are split back by line; otherwise each unit
/// is translated individually.
fn translate_batch(
    idxs: &[usize],
    texts: &[String],
    provider: &str,
    creds: &Creds,
    max_len: usize,
    http: &(dyn HttpClient + Sync),
) -> Vec<(usize, Result<String, String>)> {
    let unit = |i: usize| translate_one(&texts[i], provider, creds, max_len, http);
    if idxs.len() == 1 {
        return vec![(idxs[0], unit(idxs[0]))];
    }
    let combined: Vec<String> = idxs.iter().map(|&i| texts[i].clone()).collect();
    let joined = combined.join("\n");
    if joined.len() <= max_len {
        if let Ok(r) = run_provider(provider, &joined, creds, http) {
            let parts: Vec<&str> = r.split('\n').collect();
            if parts.len() == idxs.len() {
                return idxs.iter().zip(parts).map(|(&i, p)| (i, Ok(p.trim().to_string()))).collect();
            }
        }
    }
    idxs.iter().map(|&i| (i, unit(i))).collect()
}

fn translate_one(
    text: &str,
    provider: &str,
    creds: &Creds,
    max_len: usize,
    http: &(dyn HttpClient + Sync),
) -> Result<String, String> {
    if text.len() <= max_len {
        run_provider(provider, text, creds, http)
    } else {
        let chunks = split_long(text, max_len);
        let mut out = String::new();
        for c in chunks.iter() {
            out.push_str(&run_provider(provider, c, creds, http)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_translation_skips_chinese_and_symbols() {
        assert!(needs_translation("Hello world"));
        assert!(needs_translation("mixed 中文 here"));
        assert!(!needs_translation("这是纯中文"));
        assert!(!needs_translation("12345"));
        assert!(!needs_translation("   "));
    }

    #[test]
    fn split_long_honors_boundaries() {
        assert_eq!(split_long("abc", 10), vec!["abc"]);
        let text = "The quick brown fox jumps over the lazy dog. Another sentence here.";
        let parts = split_long(text, 25);
        assert!(parts.len() >= 2);
        assert!(parts.iter().all(|p| p.chars().count() <= 30));
        let joined: String = parts.join("");
        assert!(joined.len() <= text.len());
    }

    #[test]
    fn batch_groups_into_caps() {
        let texts: Vec<String> = vec!["aa".into(), "bb".into(), "cc".into()];
        assert_eq!(batch_units(&texts, 100).len(), 1);

        let big = "x".repeat(500);
        let texts2: Vec<String> = vec!["aa".into(), big.clone(), "bb".into()];
        let b2 = batch_units(&texts2, 100);
        assert_eq!(b2.len(), 3);
        assert_eq!(b2[1], vec![1]);
    }
}
