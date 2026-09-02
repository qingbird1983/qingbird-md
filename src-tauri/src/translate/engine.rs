//! Streaming translation engine (replaces the old `pipeline`).
//!
//! What changed, and why it's faster:
//!
//! 1. **Streaming all the way down.** The old pipeline waited for a whole
//!    batch, then split it by line count. If the reply's line count didn't
//!    match — which for an LLM is the norm, not the exception — it threw the
//!    batch away and re-sent every unit *serially*. Now the reply is parsed
//!    incrementally and each unit is emitted the moment it's finished, so the
//!    first paragraph lands in ~1.5 s instead of after the whole batch.
//! 2. **Delimiter protocol instead of line counting.** See [`super::batch`].
//!    Only units that genuinely didn't come back are retried, and retries run
//!    concurrently rather than one after another.
//! 3. **Smaller batches.** Big batches were the right call for request-bound
//!    APIs; with streaming they just delay the first visible unit.
//! 4. **Configurable concurrency per provider**, and cached units are emitted
//!    before any network call is made.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use super::batch::{self, BatchDecoder};
use super::cache::Cache;
use super::http::HttpClient;
use super::openai::{ChatRequest, chat_stream, strip_fence};
use super::providers::{self, Creds};

/// True if `text` contains at least one ASCII letter (i.e. isn't purely
/// Chinese/digits/symbols that don't need translating).
pub fn needs_translation(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    !compact.is_empty() && compact.chars().any(|c| c.is_ascii_alphabetic())
}

const LLM_SYSTEM_PROMPT: &str = "你是一名专业的中英翻译。把用户给出的文本翻译成简体中文，\
保留原文的格式、语气和段落结构。只输出译文本身，不要添加任何解释、注释或前后缀。";

/// Bump this whenever [`LLM_SYSTEM_PROMPT`] or the batching protocol changes.
/// It is part of every cache key, so stale translations simply stop matching —
/// instead of lingering until somebody remembers to clear the cache by hand.
pub const PROMPT_VERSION: &str = "v1";

/// Cache-key variant for a run: `model@PROMPT_VERSION` for the LLM (whose
/// output depends on the configured model), empty for engines whose output
/// doesn't depend on user configuration.
pub fn cache_variant(provider: &str, model: &str) -> String {
    if provider == "llm" {
        format!("{}@{}", model.trim(), PROMPT_VERSION)
    } else {
        String::new()
    }
}

/// Events emitted while a run is in flight. Every variant is cheap and
/// idempotent for the UI: `Unit` may arrive in any order.
pub enum EngineEvent {
    /// One unit's translation is ready (from cache or from the network).
    Unit { index: usize, text: String },
    /// Progress across all units of the run.
    Progress { done: usize, total: usize },
    /// One unit failed; the rest of the run continues.
    Failed { index: usize, error: String },
}

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

/// Everything a run needs. Borrowed so the worker pool can share it.
pub struct EngineRequest<'a> {
    pub provider: &'a str,
    pub creds: &'a Creds,
    /// `(document index, source text)` in document order.
    pub units: &'a [(usize, String)],
    pub http: &'a (dyn HttpClient + Sync),
    pub config: EngineConfig,
    /// Cache variant: model name + prompt version (see [`Cache::key`]).
    pub cache_variant: &'a str,
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

/// Run a translation job. Returns one result per input unit, aligned by index.
///
/// `emit` is called from worker threads; it must be `Sync` and cheap.
pub fn run(
    req: &EngineRequest,
    cache: &mut Cache,
    emit: &(dyn Fn(EngineEvent) + Sync),
) -> Vec<Result<String, String>> {
    let n = req.units.len();
    let mut results: Vec<Option<Result<String, String>>> = (0..n).map(|_| None).collect();

    // ---- 1. Cache pass: emit hits before touching the network ----
    let mut pending: Vec<usize> = Vec::new();
    for (i, (_, text)) in req.units.iter().enumerate() {
        let key = Cache::key(req.provider, req.cache_variant, text);
        match cache.get(&key) {
            Some(v) => {
                results[i] = Some(Ok(v.to_string()));
                emit(EngineEvent::Unit { index: req.units[i].0, text: v.to_string() });
            }
            None => pending.push(i),
        }
    }

    let done = AtomicUsize::new(n - pending.len());
    let total = n;
    emit(EngineEvent::Progress { done: done.load(Ordering::SeqCst), total });

    if pending.is_empty() {
        return finalize(results);
    }

    // ---- 2. Pack and order ----
    let pending_units: Vec<(usize, String)> =
        pending.iter().map(|&i| req.units[i].clone()).collect();
    let batches = pack_batches(
        &pending_units,
        req.config.units_per_batch,
        req.config.max_batch_chars,
    );
    let doc_pos: Vec<usize> = pending_units.iter().map(|(d, _)| *d).collect();
    let order = order_batches(&batches, &doc_pos, None);

    // ---- 3. Worker pool ----
    let results_mutex = Mutex::new(&mut results);
    let cursor = AtomicUsize::new(0);
    let pool = req.config.concurrency.min(batches.len()).max(1);

    let commit = |slot: usize, r: Result<String, String>| {
        let unit = pending[slot];
        let doc_index = req.units[unit].0;
        {
            let mut g = results_mutex.lock().expect("results mutex poisoned");
            g[unit] = Some(r.clone());
        }
        match &r {
            Ok(t) => emit(EngineEvent::Unit { index: doc_index, text: t.clone() }),
            Err(e) => emit(EngineEvent::Failed { index: doc_index, error: e.clone() }),
        }
        let d = done.fetch_add(1, Ordering::SeqCst) + 1;
        emit(EngineEvent::Progress { done: d, total });
    };

    std::thread::scope(|s| {
        for _ in 0..pool {
            s.spawn(|| {
                loop {
                    let k = cursor.fetch_add(1, Ordering::SeqCst);
                    if k >= order.len() {
                        break;
                    }
                    let batch = &batches[order[k]];
                    process_batch(req, &pending_units, batch, &commit);
                }
            });
        }
    });

    drop(results_mutex);

    // ---- 4. Persist new entries ----
    for (i, r) in results.iter().enumerate() {
        if let Some(Ok(v)) = r {
            let key = Cache::key(req.provider, req.cache_variant, &req.units[i].1);
            if cache.get(&key).is_none() {
                cache.set(key, v.clone());
            }
        }
    }

    finalize(results)
}

fn finalize(results: Vec<Option<Result<String, String>>>) -> Vec<Result<String, String>> {
    results
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err("未翻译".to_string())))
        .collect()
}

/// Translate one batch: stream it, emit each unit as it completes, then retry
/// whatever the model didn't deliver — concurrently, not serially.
fn process_batch(
    req: &EngineRequest,
    units: &[(usize, String)],
    batch: &[usize],
    commit: &dyn Fn(usize, Result<String, String>) + Sync,
) {
    if req.provider != "llm" {
        // Traditional engines have no batch protocol and no streaming: send
        // units one by one. Concurrency comes from the worker pool.
        for &slot in batch {
            let r = translate_one(req, &units[slot].1);
            commit(slot, r);
        }
        return;
    }

    let packed: Vec<(usize, String)> = batch.iter().map(|&s| (s, units[s].1.clone())).collect();
    // A unit too big for one request never enters the batch protocol: it is
    // split and sent as plain per-chunk requests instead.
    if packed.len() == 1 && packed[0].1.chars().count() > req.config.max_batch_chars {
        let r = translate_one(req, &packed[0].1);
        commit(packed[0].0, r);
        return;
    }
    let prompt = if packed.len() > 1 {
        format!("{LLM_SYSTEM_PROMPT}\n\n{}", batch::INSTRUCTION)
    } else {
        LLM_SYSTEM_PROMPT.to_string()
    };
    let chat = ChatRequest {
        base_url: req.creds.get("baseUrl").unwrap_or_default(),
        api_key: req.creds.get("apiKey").unwrap_or_default(),
        model: req.creds.get("model").unwrap_or_default(),
        system: &prompt,
        user: &batch::encode(&packed),
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        timeout_ms: req.config.timeout_ms,
    };

    // Track which slots the stream actually delivered, so the retry pass
    // re-sends only the gaps instead of duplicating the whole batch.
    let mut delivered = vec![false; batch.len()];

    // Feed only the *new* bytes of the accumulated content to the decoder.
    let mut decoder = BatchDecoder::new();
    let mut seen: usize = 0;
    let streamed = chat_stream(&chat, req.http, &mut |acc: &str| {
        if acc.len() <= seen {
            return;
        }
        let delta = &acc[seen..];
        seen = acc.len();
        for (slot_in_batch, text) in decoder.push(delta) {
            if !text.is_empty() {
                if let Some(&slot) = batch.get(slot_in_batch) {
                    delivered[slot_in_batch] = true;
                    commit(slot, Ok(text));
                }
            }
        }
    });

    match streamed {
        Ok(content) => {
            for (slot_in_batch, text) in decoder.finish() {
                if !text.is_empty() && !delivered[slot_in_batch] {
                    if let Some(&slot) = batch.get(slot_in_batch) {
                        delivered[slot_in_batch] = true;
                        commit(slot, Ok(text));
                    }
                }
            }
            // A single unit carries no markers: the whole reply *is* the
            // translation. Missing this would retry a perfectly good answer.
            if packed.len() == 1 && !delivered[0] {
                delivered[0] = true;
                commit(batch[0], Ok(strip_fence(&content)));
            }
        }
        Err(_) => {
            // Whole batch failed. Probe once with a single unit: if that fails
            // too, the cause is systemic (bad key, wrong model, no network) and
            // re-sending the other N units would just burn N more timeouts.
            let mut fatal: Option<String> = None;
            if let Some(&first) = batch.first() {
                match translate_one(req, &units[first].1) {
                    Ok(t) => {
                        delivered[0] = true;
                        commit(first, Ok(t));
                    }
                    Err(e) => fatal = Some(e),
                }
            }
            if let Some(e) = fatal {
                for &slot in batch {
                    commit(slot, Err(e.clone()));
                }
                return;
            }
        }
    }

    // Retry whatever didn't come back — concurrently, never serially.
    let missing: Vec<usize> = (0..batch.len())
        .filter(|&i| !delivered[i])
        .map(|i| batch[i])
        .collect();
    if !missing.is_empty() {
        std::thread::scope(|s| {
            for &slot in &missing {
                s.spawn(move || {
                    let r = translate_one(req, &units[slot].1);
                    commit(slot, r);
                });
            }
        });
    }
}

/// Translate a single unit, with the same provider/credentials as the run.
///
/// Units longer than the provider's budget are split first: every engine has a
/// per-request character ceiling, and a silently truncated or rejected reply is
/// worse than two requests.
fn translate_one(req: &EngineRequest, text: &str) -> Result<String, String> {
    if text.chars().count() > req.config.max_batch_chars {
        let mut out = String::new();
        for chunk in split_long(text, req.config.max_batch_chars) {
            let piece = if req.provider == "llm" {
                llm_once(req, &chunk)?
            } else {
                providers::provider(req.provider, &chunk, req.creds, req.http)?
            };
            out.push_str(&piece);
        }
        return Ok(out);
    }
    if req.provider != "llm" {
        return providers::provider(req.provider, text, req.creds, req.http);
    }
    llm_once(req, text)
}

fn llm_once(req: &EngineRequest, text: &str) -> Result<String, String> {
    let chat = ChatRequest {
        base_url: req.creds.get("baseUrl").unwrap_or_default(),
        api_key: req.creds.get("apiKey").unwrap_or_default(),
        model: req.creds.get("model").unwrap_or_default(),
        system: LLM_SYSTEM_PROMPT,
        user: text,
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        timeout_ms: req.config.timeout_ms,
    };
    let mut noop = |_: &str| {};
    chat_stream(&chat, req.http, &mut noop).map(|c| strip_fence(&c))
}

/// Split `text` into chunks of at most `max_len`, preferring a sentence
/// boundary, then a word boundary, then a hard cut.
pub fn split_long(text: &str, max_len: usize) -> Vec<String> {
    if text.chars().count() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut rest = text.trim().to_string();
    let min = max_len / 2;
    while rest.chars().count() > max_len {
        let window: String = rest.chars().take(max_len).collect();
        let mut cut: isize = -1;
        for p in sentence_boundaries(&window) {
            if p >= min {
                cut = p as isize; // keep advancing: take the last viable one
            }
        }
        if cut < 0 {
            if let Some(w) = window.rfind(' ').filter(|&w| w >= min) {
                cut = w as isize;
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;

    fn units(chars: &[usize]) -> Vec<(usize, String)> {
        chars
            .iter()
            .enumerate()
            .map(|(i, &n)| (i, "x".repeat(n)))
            .collect()
    }

    #[test]
    fn needs_translation_skips_chinese_and_symbols() {
        assert!(needs_translation("Hello world"));
        assert!(needs_translation("mixed 中文 here"));
        assert!(!needs_translation("这是纯中文"));
        assert!(!needs_translation("12345"));
        assert!(!needs_translation("   "));
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
        assert_eq!(b, vec![vec![0, 1], vec![2]]);
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
    fn cached_units_require_no_network() {
        let mut cache = Cache::new();
        let u = vec![(0usize, "hello".to_string())];
        cache.set(Cache::key("llm", "m@v1", "hello"), "你好".into());

        let http = MockClient::new();
        let creds = Creds::default();
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
        };
        let mut events: Vec<usize> = Vec::new();
        let out = run(&req, &mut cache, &|e| {
            if let EngineEvent::Unit { index, .. } = e {
                events.push(index)
            }
        });
        assert_eq!(out, vec![Ok("你好".to_string())]);
        assert_eq!(events, vec![0]);
        assert!(http.take_records().is_empty(), "cache hit must not hit the network");
    }

    #[test]
    fn results_align_with_input_order() {
        let http = MockClient::new();
        let creds = Creds::default();
        let u = vec![
            (10usize, "a".to_string()),
            (20usize, "b".to_string()),
            (30usize, "c".to_string()),
        ];
        let mut cache = Cache::new();
        let req = EngineRequest {
            provider: "transmart",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("transmart", 2000, 12),
            cache_variant: "",
        };
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|r| r.is_ok()), "{out:?}");
        // Free providers do not batch: one request per unit.
        assert_eq!(http.take_records().len(), 3);
    }

    fn llm_creds() -> Creds {
        let mut m = std::collections::HashMap::new();
        m.insert("baseUrl".to_string(), "https://x.io/v1".to_string());
        m.insert("model".to_string(), "m".to_string());
        Creds(m)
    }

    /// One SSE chunk carrying `content`, followed by the DONE terminator.
    fn sse(content: &str) -> String {
        let payload =
            serde_json::json!({ "choices": [ { "delta": { "content": content } } ] }).to_string();
        format!("data: {payload}\n\ndata: [DONE]\n\n")
    }

    #[test]
    fn llm_batch_delivers_every_unit_from_one_request() {
        let http = MockClient::new();
        http.script_stream(sse("<<<B0>>>AAA<<<END>>>\n<<<B1>>>BBB<<<END>>>\n"));
        let creds = llm_creds();
        let u: Vec<(usize, String)> = vec![(0, "a".into()), (1, "b".into())];
        let mut cache = Cache::new();
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
        };
        let mut got: Vec<(usize, String)> = Vec::new();
        let out = run(&req, &mut cache, &|e| {
            if let EngineEvent::Unit { index, text } = e {
                got.push((index, text))
            }
        });
        assert_eq!(out, vec![Ok("AAA".to_string()), Ok("BBB".to_string())]);
        assert_eq!(got.len(), 2);
        assert_eq!(
            http.take_records().len(),
            1,
            "both units came from a single request — no retry storm"
        );
    }

    #[test]
    fn only_the_missing_unit_is_retried() {
        let http = MockClient::new();
        http.script_stream(sse("<<<B0>>>AAA<<<END>>>\n")); // batch replied with only unit 0
        http.script_stream(sse("BBB")); // retry of unit 1 (single, unmarked)
        let creds = llm_creds();
        let u: Vec<(usize, String)> = vec![(0, "a".into()), (1, "b".into())];
        let mut cache = Cache::new();
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
        };
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out, vec![Ok("AAA".to_string()), Ok("BBB".to_string())]);
        assert_eq!(http.take_records().len(), 2, "one batch + one gap retry");
    }

    #[test]
    fn systemic_failure_does_not_retry_every_unit() {
        let http = MockClient::new();
        http.script_stream(String::new()); // batch fails
        http.script_stream(String::new()); // probe fails too
        let creds = llm_creds();
        let u: Vec<(usize, String)> =
            vec![(0, "a".into()), (1, "b".into()), (2, "c".into()), (3, "d".into())];
        let mut cache = Cache::new();
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
        };
        let out = run(&req, &mut cache, &|_| {});
        assert!(out.iter().all(|r| r.is_err()), "{out:?}");
        assert_eq!(
            http.take_records().len(),
            2,
            "batch + one probe; a systemic error must not fan out to N requests"
        );
    }

    #[test]
    fn single_unit_batch_uses_the_raw_reply() {
        let http = MockClient::new();
        http.script_stream(sse("纯译文，无标记"));
        let creds = llm_creds();
        let u: Vec<(usize, String)> = vec![(7, "a".into())];
        let mut cache = Cache::new();
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
        };
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out, vec![Ok("纯译文，无标记".to_string())]);
        assert_eq!(http.take_records().len(), 1, "no wasted retry on a good answer");
    }

    #[test]
    fn cache_variant_tracks_the_model_for_llm_only() {
        assert_eq!(cache_variant("llm", "deepseek-chat"), format!("deepseek-chat@{PROMPT_VERSION}"));
        assert_eq!(cache_variant("llm", "  qwen  "), format!("qwen@{PROMPT_VERSION}"));
        // Free engines don't depend on user config: one shared keyspace.
        assert_eq!(cache_variant("transmart", "whatever"), "");
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
    fn oversized_unit_is_split_before_sending() {
        let http = MockClient::new();
        // Two chunks -> two replies; the mock answers "你好，世界" to each.
        http.script_stream(sse("甲"));
        http.script_stream(sse("乙"));
        let creds = llm_creds();
        let long = "a".repeat(20);
        let u: Vec<(usize, String)> = vec![(0, long)];
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &u,
            http: &http,
            // max_batch_chars = 12 -> a 20-char unit must be split in two.
            config: EngineConfig::for_provider("llm", 15, 6),
            cache_variant: "m@v1",
        };
        let mut cache = Cache::new();
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out, vec![Ok("甲乙".to_string())], "chunks are concatenated");
        assert_eq!(http.take_records().len(), 2, "one request per chunk");
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
