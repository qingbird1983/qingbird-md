//! Run 执行器：请求描述、缓存 pass、分批与单单元裸发。`EngineEvent` 定义在
//! [`super::events`]，经 engine.rs 再导出对前端 wire 不变。

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::cache::{Cache, CacheBackend};
use super::events::EngineEvent;
use super::http::HttpClient;
use super::packing::{EngineConfig, order_batches, pack_batches, split_long};
use super::policy::TargetLang;
use super::providers::{self, Creds};

/// Everything a run needs. Borrowed so the worker pool can share it.
pub struct EngineRequest<'a> {
    pub provider: &'a str,
    pub creds: &'a Creds,
    /// `(document index, source text)` in document order.
    pub units: &'a [(usize, String)],
    pub http: &'a (dyn HttpClient + Sync),
    pub config: EngineConfig,
    /// Cache variant: direction tag (see [`Cache::key`]).
    /// 由 [`cache_variant`](super::policy::cache_variant) 生成——**不要在这里手拼**。
    pub cache_variant: &'a str,
    /// 本次翻译的目标语言。决定可译判定与语言码方向。
    pub target: TargetLang,
}

/// Run a translation job. Returns one result per input unit, aligned by index.
///
/// `emit` is called from worker threads; it must be `Sync` and cheap.
pub fn run(
    req: &EngineRequest,
    cache: &mut dyn CacheBackend,
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
                emit(EngineEvent::Unit {
                    index: req.units[i].0,
                    text: v.clone(),
                    from_cache: true,
                });
                results[i] = Some(Ok(v));
            }
            None => pending.push(i),
        }
    }

    let done = AtomicUsize::new(n - pending.len());
    let total = n;
    emit(EngineEvent::Progress {
        done: done.load(Ordering::SeqCst),
        total,
    });

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
            let mut g = results_mutex.lock().unwrap_or_else(|e| e.into_inner());
            g[unit] = Some(r.clone());
        }
        match &r {
            Ok(t) => emit(EngineEvent::Unit {
                index: doc_index,
                text: t.clone(),
                from_cache: false,
            }),
            Err(e) => emit(EngineEvent::Failed {
                index: doc_index,
                error: e.clone(),
            }),
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

/// Translate one batch: every source uses the same plain per-unit path —
/// concurrency comes from the worker pool.
fn process_batch(
    req: &EngineRequest,
    units: &[(usize, String)],
    batch: &[usize],
    commit: &(dyn Fn(usize, Result<String, String>) + Sync),
) {
    for &slot in batch {
        let r = translate_one(req, &units[slot].1);
        commit(slot, r);
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
            let piece = providers::provider(req.provider, &chunk, req.creds, req.http, req.target)?;
            out.push_str(&piece);
        }
        return Ok(out);
    }
    providers::provider(req.provider, text, req.creds, req.http, req.target)
}
