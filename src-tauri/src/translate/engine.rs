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
//!
//! P2-7j 拆分布局：events = wire 事件类型；runner = run 执行器与批量/单串
//! 路径（process_batch/translate_one/llm_once）；本文件只留转发与 re-export
//! （`translate::engine::X` 旧路径逐字不变）。

// P0-1 拆分：方向策略已移到 `policy` 子模块，此处**保留旧路径**——其它文件的
// `translate::engine::TargetLang` 这类 use 一行都不用改。
// （`PROMPT_VERSION` 不在此转发：crate 内无人经 `engine::` 路径使用它，
//   转发会触发 unused_imports；要用请走 `translate::policy::PROMPT_VERSION`。）
// （P2-7j：`system_prompt` 的消费者 process_batch/llm_once 随 runner 迁出，
//   engine::system_prompt 无人经旧路径使用，转发同步撤除——要用请走
//   `translate::policy::system_prompt`。）
pub use super::policy::{cache_variant, default_target, needs_translation, TargetLang};

// P0-1 拆分（第二步）：分批 / 分片也移到 `packing` 子模块，同样**保留旧路径**。
// （P2-7j：order_batches/pack_batches/split_long 的消费者随 runner 迁出，
//   engine:: 下无人再经旧路径使用，转发同步撤除；EngineConfig 仍被
//   bridge/worker 经 engine:: 使用，保留。）
pub use super::packing::EngineConfig;

pub use super::events::EngineEvent;
pub use super::runner::{run, EngineRequest};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::cache::Cache;
    use crate::translate::providers::Creds;
    use crate::translate::http::test_mock::MockClient;
    use std::sync::Mutex;

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
}
