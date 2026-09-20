//! 后台翻译 worker：spawn_translation 把引擎事件流转成三个 wire 事件，收尾
//! 落盘并按需空闲收缩；翻译活动时间戳与 running 的 RAII 守卫也在这里。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::{storage, translate};
use crate::translate::cache::Cache;
use crate::translate::engine::TargetLang;

use super::events::{TranslationDoneEvt, TranslationPartialEvt, TranslationProgressEvt};
use super::payload::{done_payload_parts, html_payload_parts};

/// 进度事件最小间隔。
pub(super) const PROGRESS_MIN_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(80);

/// 翻译 worker 收尾时检查：若距上次翻译活动已超过此阈值，把内存里的 cache
/// 收缩到 [`SHRINK_TO`] 条。设计动机见 2026-09-05 内存诊断：cache 20000 条
/// 全量常驻是后台占用只涨不跌的主因之一，没有 LRU / 手动提示之外的回收路径。
/// 10 分钟阈值对应「用户离开一会儿」，不会误触翻译刚结束就要继续用的情况。
pub(crate) const IDLE_SHRINK_AFTER: Duration = Duration::from_secs(10 * 60);

/// 收缩目标：留热 1000 条，占 `cache::MAX`（5000）的 20%。中长文档的常用
/// 翻译结果基本还在；冷条目按需重新翻译——网络代价换内存。
pub(crate) const SHRINK_TO: usize = 1000;

/// 最近一次翻译相关入口（translate_text / lookup_word / translate_document）
/// 被调用的时间戳。进程级单例：不需要持久化，进程重启从零计。
/// Instant 非 const 不可直填 static，用 LazyLock 延后到首次访问再 now()。
static LAST_TRANSLATE_AT: LazyLock<Mutex<Instant>> =
    LazyLock::new(|| Mutex::new(Instant::now()));

/// 翻译相关 IPC 入口调一次：刷新「最近一次翻译活动」时间戳。
pub(super) fn note_translate_activity() {
    *LAST_TRANSLATE_AT.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
}

/// worker 收尾调用：若离上次翻译活动已超过 [`IDLE_SHRINK_AFTER`] 且当前
/// cache 大于 [`SHRINK_TO`]，裁到目标。返回是否实际裁剪（裁了 dirty=true，
/// 调用方负责 save 重写磁盘）。
fn shrink_if_idle(cache: &mut Cache) -> bool {
    let now = Instant::now();
    let last = *LAST_TRANSLATE_AT
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if now.saturating_duration_since(last) >= IDLE_SHRINK_AFTER
        && cache.len_pub() > SHRINK_TO
    {
        cache.shrink_to(SHRINK_TO) > 0
    } else {
        false
    }
}

pub(super) struct WorkerState {
    pub(super) cache: Arc<Mutex<Cache>>,
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) running: Arc<AtomicBool>,
}

/// REL-1：worker 线程的 running 标志 RAII 守卫。无论正常收尾还是 panic
/// 展开，Drop 都把 running 打回 false——否则一次 panic 跳过手工复位，
/// 此后所有翻译报「已有翻译在进行」，只能重启应用。
struct RunningGuard(Arc<AtomicBool>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub(super) fn spawn_translation(
    app: AppHandle,
    r#gen: u64,
    texts: Vec<String>,
    indices: Vec<usize>,
    provider: String,
    creds: HashMap<String, String>,
    meta: &'static translate::providers_meta::ProviderMeta,
    st: WorkerState,
    mut work_cache: Cache,
    content: String,
    bilingual: bool,
    windowed: bool,
    target: TargetLang,
) {
    std::thread::spawn(move || {
        // RAII 复位（REL-1）：本闭包任何一步 panic，守卫在展开时把 running
        // 打回 false；正常路径里它代替原来的手工 store(false) 收尾。
        let _running = RunningGuard(Arc::clone(&st.running));
        let http0 = translate::http::UreqClient::shared();
        let http = translate::cancel::CancelableClient {
            inner: http0,
            cancel: &st.cancel,
        };
        let creds = translate::providers::Creds(creds);
        let variant = translate::engine::cache_variant(
            &provider,
            creds.get("model").unwrap_or_default(),
            target,
        );

        let units: Vec<(usize, String)> =
            indices.iter().copied().zip(texts.iter().cloned()).collect();
        let config = translate::engine::EngineConfig::for_provider(
            &provider,
            meta.max_len,
            meta.max_concurrency,
        );
        let req = translate::engine::EngineRequest {
            provider: &provider,
            creds: &creds,
            units: &units,
            http: &http,
            config,
            cache_variant: &variant,
            target,
        };

        let app_evt = app.clone();
        let last_progress: Mutex<Option<std::time::Instant>> = Mutex::new(None);
        let emit = |ev: translate::engine::EngineEvent| match ev {
            translate::engine::EngineEvent::Unit { index, text, from_cache } => {
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text, from_cache, streaming: false, failed: false },
                );
            }
            translate::engine::EngineEvent::Streaming { index, text } => {
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text, from_cache: false, streaming: true, failed: false },
                );
            }
            translate::engine::EngineEvent::Progress { done, total } => {
                let mut last = last_progress.lock().unwrap_or_else(|e| e.into_inner());
                let due = last
                    .map(|t| t.elapsed() >= PROGRESS_MIN_INTERVAL)
                    .unwrap_or(true);
                if due || done >= total {
                    *last = Some(std::time::Instant::now());
                    drop(last);
                    let _ = app_evt.emit(
                        "translation-progress",
                        TranslationProgressEvt { r#gen, done, total },
                    );
                }
            }
            translate::engine::EngineEvent::Failed { index, .. } => {
                // 失败单元照常转发（携带原文）：前端回退原文显示并跳过打字，
                // 但必须推进打字机放行——否则该 run 缺失会让其后所有块
                // 永久等位，出现"前几行打字→停住→done 一次性回填"。
                let text = units
                    .iter()
                    .find(|(i, _)| *i == index)
                    .map(|(_, t)| t.clone())
                    .unwrap_or_default();
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text, from_cache: false, streaming: false, failed: true },
                );
            }
        };

        let results = translate::engine::run(&req, &mut work_cache, &emit);

        {
            let mut shared = st.cache.lock().unwrap_or_else(|e| e.into_inner());
            for (i, r) in results.iter().enumerate() {
                if let Ok(v) = r {
                    shared.set(Cache::key(&provider, &variant, &texts[i]), v.clone());
                }
            }
            // 空闲收缩：worker 收尾时若距上次翻译活动已超过 IDLE_SHRINK_AFTER，
            // 把内存 cache 砍到 SHRINK_TO 条并标记 dirty（save 一次性写回磁盘）。
            // 收益：cache 上限 20000 条常驻 → 主动收紧后 ~2-3MB 起步。
            let shrunk = shrink_if_idle(&mut shared);
            if shared.is_dirty() {
                if let Err(e) = shared.save(&storage::cache_path()) {
                    eprintln!("[cache] save after shrink failed: {e}");
                }
                if shrunk {
                    crate::trim::trim_working_set();
                }
            }
        }

        let (ok, pairs, err) = done_payload_parts(&indices, &results);
        let payload = if ok {
            let map: HashMap<usize, String> = pairs.iter().cloned().collect();
            if windowed {
                TranslationDoneEvt {
                    r#gen,
                    ok: true,
                    translations: Some(pairs),
                    error: None,
                    html_original: None,
                    html_translation: None,
                    html_bilingual: None,
                    outline: None,
                }
            } else {
                let (html_original, html_translation, html_bilingual, outline) =
                    html_payload_parts(&content, &map, bilingual, target);
                TranslationDoneEvt {
                    r#gen,
                    ok: true,
                    translations: Some(pairs),
                    error: None,
                    html_original: Some(html_original),
                    html_translation,
                    html_bilingual,
                    outline: Some(outline),
                }
            }
        } else {
            TranslationDoneEvt {
                r#gen,
                ok: false,
                translations: None,
                error: err,
                html_original: None,
                html_translation: None,
                html_bilingual: None,
                outline: None,
            }
        };
        // running 的复位由 _running 守卫的 Drop 负责（panic 也覆盖）。
        let _ = app.emit("translation-done", payload);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- REL-1 / REL-2：panic 后功能可继续 ----

    /// REL-2 守卫：持锁线程 panic 把互斥量中毒后，翻译活动入口必须仍可用。
    /// 锁访问统一 `unwrap_or_else(|e| e.into_inner())`——中毒只是"带着中毒前
    /// 的数据继续"，不能级联 panic 把翻译入口全部堵死。修复前这里是
    /// `.expect(...poisoned)`，本测试必红（panic 逃出 note_translate_activity）。
    #[test]
    fn poisoned_translate_activity_mutex_still_functions() {
        // 故意投毒：持锁 panic（静音钩子，别让预期内的 panic 刷屏）。
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = LAST_TRANSLATE_AT.lock().unwrap();
            panic!("intentional poison (REL-2 guard)");
        }));
        std::panic::set_hook(prev);

        // 中毒后两个入口都必须照常工作：读（shrink_if_idle）与写（note_*）
        let mut scratch = Cache::new();
        assert!(
            !shrink_if_idle(&mut scratch),
            "中毒后 shrink_if_idle 不得 panic，返回 false"
        );
        note_translate_activity();
    }

    /// REL-1 守卫：RunningGuard 在正常 Drop 与 panic 展开两条路都必须把
    /// running 复位——worker 线程任一处 panic 不能把「已有翻译在进行」留成
    /// 永久态（修复前手工 `store(false)` 在 panic 时被跳过）。
    /// 注：spawn_translation 本体要 AppHandle，单测环境无法整体驱动；这里
    /// 直接钉住守卫原语的两条 Drop 路径。
    #[test]
    fn running_guard_resets_on_drop_and_panic() {
        let running = Arc::new(AtomicBool::new(true));

        // 正常收尾：离开作用域 Drop → 复位
        {
            let _g = RunningGuard(Arc::clone(&running));
        }
        assert!(!running.load(Ordering::SeqCst), "正常收尾必须复位");

        // worker 中途 panic：展开时 Drop → 复位
        running.store(true, Ordering::SeqCst);
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = RunningGuard(Arc::clone(&running));
            panic!("worker panic (REL-1 guard)");
        }));
        std::panic::set_hook(prev);
        assert!(result.is_err(), "应捕获到 worker panic");
        assert!(!running.load(Ordering::SeqCst), "panic 展开必须复位 running");
    }
}
