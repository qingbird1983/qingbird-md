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

// P0-1 拆分：方向策略已移到 `policy` 子模块，此处**保留旧路径**——其它文件的
// `translate::engine::TargetLang` 这类 use 一行都不用改。
// （`PROMPT_VERSION` 不在此转发：crate 内无人经 `engine::` 路径使用它，
//   转发会触发 unused_imports；要用请走 `translate::policy::PROMPT_VERSION`。）
pub use super::policy::{
    cache_variant, default_target, needs_translation, system_prompt, TargetLang,
};

// P0-1 拆分（第二步）：分批 / 分片也移到 `packing` 子模块，同样**保留旧路径**。
pub use super::packing::{order_batches, pack_batches, split_long, EngineConfig};


/// Events emitted while a run is in flight. Every variant is cheap and
/// idempotent for the UI: `Unit` may arrive in any order.
pub enum EngineEvent {
    /// One unit's translation is ready. `from_cache` = 缓存命中（前端据此
    /// 跳过打字动画直接上屏，qingniao round2 #5 语义）。
    Unit { index: usize, text: String, from_cache: bool },
    /// 单单元裸发路径的实时增量（累积文本，随 SSE delta 增长）。前端据此
    /// 直写 DOM（灰字+省略号，qingniao `TranslationState::Streaming` 语义），
    /// 找回"逐字吐出"；同一 index 的 `Unit` 到达后再定格。
    Streaming { index: usize, text: String },
    /// Progress across all units of the run.
    Progress { done: usize, total: usize },
    /// One unit failed; the rest of the run continues. 事件层刻意不消费
    /// 这两个字段（lib.rs 把单段失败当"结果缺席"处理，done 事件统一带
    /// 首个错误）——字段留给未来前端单段标红的扩展，先挂 allow 免噪音。
    #[allow(dead_code)]
    Failed { index: usize, error: String },
}

/// Everything a run needs. Borrowed so the worker pool can share it.
pub struct EngineRequest<'a> {
    pub provider: &'a str,
    pub creds: &'a Creds,
    /// `(document index, source text)` in document order.
    pub units: &'a [(usize, String)],
    pub http: &'a (dyn HttpClient + Sync),
    pub config: EngineConfig,
    /// Cache variant: model + prompt version + direction (see [`Cache::key`]).
    /// 由 [`cache_variant`] 生成——**不要在这里手拼**，否则容易漏掉方向。
    pub cache_variant: &'a str,
    /// 本次翻译的目标语言。决定 prompt 模板文案。
    pub target: TargetLang,
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
                emit(EngineEvent::Unit { index: req.units[i].0, text: v.to_string(), from_cache: true });
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
            let mut g = results_mutex
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            g[unit] = Some(r.clone());
        }
        match &r {
            Ok(t) => emit(EngineEvent::Unit { index: doc_index, text: t.clone(), from_cache: false }),
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
                    process_batch(req, &pending_units, batch, &commit, emit);
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
    commit: &(dyn Fn(usize, Result<String, String>) + Sync),
    emit: &(dyn Fn(EngineEvent) + Sync),
) {
    if req.provider != "llm" {
        // Traditional engines have no batch protocol and no streaming: send
        // units one by one. Concurrency comes from the worker pool.
        for &slot in batch {
            let r = translate_one(req, &units[slot].1, &mut |_| {});
            commit(slot, r);
        }
        return;
    }

    let packed: Vec<(usize, String)> = batch.iter().map(|&s| (s, units[s].1.clone())).collect();
    // 单单元批 = 裸发路径：累积内容转发 Streaming（qingniao 同款"渐进上屏"）。
    // 批量批按分隔符增量解码，单元闭合才提交，不转发 Streaming。
    let single_doc_index = if packed.len() == 1 { Some(units[packed[0].0].0) } else { None };
    // A unit too big for one request never enters the batch protocol: it is
    // split and sent as plain per-chunk requests instead.
    if packed.len() == 1 && packed[0].1.chars().count() > req.config.max_batch_chars {
        let (slot, text) = &packed[0];
        let doc_index = single_doc_index.expect("single batch has doc index");
        let mut out = String::new();
        for chunk in split_long(text, req.config.max_batch_chars) {
            let piece = translate_one(req, &chunk, &mut |acc: &str| {
                emit(EngineEvent::Streaming { index: doc_index, text: acc.to_string() });
            });
            match piece {
                Ok(p) => out.push_str(&p),
                Err(e) => {
                    commit(*slot, Err(e));
                    return;
                }
            }
        }
        commit(*slot, Ok(out));
        return;
    }
    // 每次请求换一个随机 nonce（BUG-4）：正文里的标记字面量猜不到它，
    // 既截不断单元，也占不了别的槽。单单元裸发路径不进协议，但仍走同一个
    // prompt 构造（不带批量段）。
    let nonce = batch::new_nonce();
    let prompt = system_prompt(req.target, (packed.len() > 1).then(|| nonce.as_str()));
    let chat = ChatRequest {
        base_url: req.creds.get("baseUrl").unwrap_or_default(),
        api_key: req.creds.get("apiKey").unwrap_or_default(),
        model: req.creds.get("model").unwrap_or_default(),
        system: &prompt,
        user: &batch::encode(&packed, &nonce),
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        thinking_off: true,
        timeout_ms: req.config.timeout_ms,
    };

    // Track which slots the stream actually delivered, so the retry pass
    // re-sends only the gaps instead of duplicating the whole batch.
    let mut delivered = vec![false; batch.len()];

    // Feed only the *new* bytes of the accumulated content to the decoder.
    // 解码只认本批 nonce 的标记——与 encode / prompt 用同一个值。
    let mut decoder = BatchDecoder::new(&nonce);
    let mut seen: usize = 0;
    let streamed = chat_stream(&chat, req.http, &mut |acc: &str| {
        if acc.len() <= seen {
            return;
        }
        let delta = &acc[seen..];
        seen = acc.len();
        if let Some(idx) = single_doc_index {
            emit(EngineEvent::Streaming { index: idx, text: acc.to_string() });
        }
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
                match translate_one(req, &units[first].1, &mut |_| {}) {
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
                    let mut noop = |_: &str| {};
                    let r = translate_one(req, &units[slot].1, &mut noop);
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
fn translate_one(
    req: &EngineRequest,
    text: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<String, String> {
    if text.chars().count() > req.config.max_batch_chars {
        let mut out = String::new();
        for chunk in split_long(text, req.config.max_batch_chars) {
            let piece = if req.provider == "llm" {
                llm_once(req, &chunk, on_delta)?
            } else {
                providers::provider(req.provider, &chunk, req.creds, req.http, req.target)?
            };
            out.push_str(&piece);
        }
        return Ok(out);
    }
    if req.provider != "llm" {
        return providers::provider(req.provider, text, req.creds, req.http, req.target);
    }
    llm_once(req, text, on_delta)
}

fn llm_once(
    req: &EngineRequest,
    text: &str,
    on_delta: &mut dyn FnMut(&str),
) -> Result<String, String> {
    // 单串裸发路径（划词 / 拆分子块）：不带批量协议，但**同样要带方向指令与
    // 不可信上下文声明**——这条路径此前用的是同一个常量，别让它掉队。
    let prompt = system_prompt(req.target, None);
    let chat = ChatRequest {
        base_url: req.creds.get("baseUrl").unwrap_or_default(),
        api_key: req.creds.get("apiKey").unwrap_or_default(),
        model: req.creds.get("model").unwrap_or_default(),
        system: &prompt,
        user: text,
        temperature: 0.1,
        max_tokens: None,
        json_mode: false,
        thinking_off: true,
        timeout_ms: req.config.timeout_ms,
    };
    chat_stream(&chat, req.http, on_delta).map(|c| strip_fence(&c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::test_mock::MockClient;

    /// 测试默认方向 = 译成中文（= Step 0 的生产行为）。
    const ZH: TargetLang = TargetLang::Zh;

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
            target: ZH,
        };
        let events = Mutex::new(Vec::new());
        let out = run(&req, &mut cache, &|e| {
            if let EngineEvent::Unit { index, .. } = e {
                events.lock().unwrap().push(index)
            }
        });
        assert_eq!(out, vec![Ok("你好".to_string())]);
        assert_eq!(events.into_inner().unwrap(), vec![0]);
        assert!(http.take_records().is_empty(), "cache hit must not hit the network");
    }

    #[test]
    fn unit_events_carry_from_cache_flag() {
        // 预置缓存 → 命中单元 from_cache=true；网络单元 false。
        // 脚本回复故意用无标记的普通文本：本测试只看 from_cache 旗标，不断言
        // 网络单元恢复出的译文；旧式 <<<B0>>>/<<<END>>> 字面量（无 nonce）会被
        // 解码器拒识，留在这里只会与现协议混淆（P0-4/P2-5）。
        let http = MockClient::new();
        http.script_stream(sse("好的，这是普通文本回复。"));
        let mut cache = Cache::new();
        cache.set(Cache::key("llm", "m@v1", "Hello"), "你好缓存".into());
        let creds = llm_creds();
        let units = vec![(0usize, "Hello".to_string()), (1usize, "World".to_string())];
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &units,
            http: &http,
            config: EngineConfig::for_provider("llm", 3000, 6),
            cache_variant: "m@v1",
            target: ZH,
        };
        let flags = Mutex::new(Vec::new());
        let _ = run(&req, &mut cache, &|ev| {
            if let EngineEvent::Unit { index, from_cache, .. } = ev {
                flags.lock().unwrap().push((index, from_cache))
            }
        });
        assert_eq!(
            flags.into_inner().unwrap(),
            vec![(0usize, true), (1usize, false)],
            "缓存命中=true，网络=false"
        );
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
            target: ZH,
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

    /// 从批量请求负载里抠出本批 nonce（`batch::encode` 的标记形如
    /// `<<<B0-<nonce>>>>`）。批量协议的标记带每次请求的随机 nonce，忠实的
    /// 模型回复必须原样回显它——动态 mock 据此构造回复。
    fn batch_nonce_of(req_body: &str) -> String {
        let tag = "<<<B0-";
        let start = req_body.find(tag).expect("request carries batch markers") + tag.len();
        let end = req_body[start..].find(">>>").expect("open marker closed") + start;
        req_body[start..end].to_string()
    }

    #[test]
    fn llm_batch_delivers_every_unit_from_one_request() {
        let http = MockClient::new();
        http.script_stream_fn(|req_body| {
            let n = batch_nonce_of(req_body);
            sse(&format!(
                "<<<B0-{n}>>>AAA<<<END-{n}>>>\n<<<B1-{n}>>>BBB<<<END-{n}>>>\n"
            ))
        });
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
            target: ZH,
        };
        let got = Mutex::new(Vec::<(usize, String)>::new());
        let out = run(&req, &mut cache, &|e| {
            if let EngineEvent::Unit { index, text, .. } = e {
                got.lock().unwrap().push((index, text))
            }
        });
        assert_eq!(out, vec![Ok("AAA".to_string()), Ok("BBB".to_string())]);
        assert_eq!(got.into_inner().unwrap().len(), 2);
        assert_eq!(
            http.take_records().len(),
            1,
            "both units came from a single request — no retry storm"
        );
    }

    #[test]
    fn only_the_missing_unit_is_retried() {
        let http = MockClient::new();
        // batch replied with only unit 0 (markers echo the request's nonce)
        http.script_stream_fn(|req_body| {
            let n = batch_nonce_of(req_body);
            sse(&format!("<<<B0-{n}>>>AAA<<<END-{n}>>>\n"))
        });
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
            target: ZH,
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
            target: ZH,
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
            target: ZH,
        };
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out, vec![Ok("纯译文，无标记".to_string())]);
        assert_eq!(http.take_records().len(), 1, "no wasted retry on a good answer");
    }

    #[test]
    fn single_unit_batch_streams_increments() {
        // 单单元裸发路径：每个 delta 以累积文本转发 Streaming（qingniao
        // TranslationState::Streaming 语义），流结束后 Unit 定格。
        let mut raw = String::new();
        for d in ["你", "好", "，", "世界"] {
            let payload =
                serde_json::json!({ "choices": [ { "delta": { "content": d } } ] }).to_string();
            raw.push_str(&format!("data: {payload}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let http = MockClient::new();
        http.script_stream(raw);
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
            target: ZH,
        };
        let events = Mutex::new(Vec::new());
        let out = run(&req, &mut cache, &|e| events.lock().unwrap().push(e));
        assert_eq!(out, vec![Ok("你好，世界".to_string())]);
        let evs = events.into_inner().unwrap();
        let streams: Vec<&str> = evs
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Streaming { index, text } => {
                    assert_eq!(*index, 7);
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(streams, vec!["你", "你好", "你好，", "你好，世界"]);
        let units: Vec<usize> = evs
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Unit { index, .. } => Some(*index),
                _ => None,
            })
            .collect();
        assert_eq!(units, vec![7]);
        assert_eq!(http.take_records().len(), 1, "no wasted retry on a good answer");
    }

    #[test]
    fn multi_unit_batch_does_not_stream() {
        // 批量批按分隔符增量解码：单元闭合才提交，不转发 Streaming
        let http = MockClient::new();
        http.script_stream_fn(|req_body| {
            let n = batch_nonce_of(req_body);
            sse(&format!(
                "<<<B0-{n}>>>AAA<<<END-{n}>>>\n<<<B1-{n}>>>BBB<<<END-{n}>>>\n"
            ))
        });
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
            target: ZH,
        };
        let events = Mutex::new(Vec::new());
        let out = run(&req, &mut cache, &|e| events.lock().unwrap().push(e));
        assert_eq!(out, vec![Ok("AAA".to_string()), Ok("BBB".to_string())]);
        let evs = events.into_inner().unwrap();
        assert!(
            evs.iter().all(|e| !matches!(e, EngineEvent::Streaming { .. })),
            "batch protocol must not emit Streaming"
        );
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
            target: ZH,
        };
        let mut cache = Cache::new();
        let out = run(&req, &mut cache, &|_| {});
        assert_eq!(out, vec![Ok("甲乙".to_string())], "chunks are concatenated");
        assert_eq!(http.take_records().len(), 2, "one request per chunk");
    }

}
