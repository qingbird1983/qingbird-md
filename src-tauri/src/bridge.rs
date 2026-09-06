//! IPC bridge for translation: wire event types, cache-hit fast path, and the
//! background worker that turns a worker thread into the three translate
//! events the frontend subscribes to.
//!
//! Translation commands live here too: they're a single coherent surface
//! around the same `translate::engine` + cache pair.
//!
//! 拆自 lib.rs：god-file 阶段保留 lib.rs 给 AppTxn / run() / 通用浅壳命令。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::translate::cache::Cache;
use crate::{dto, markdown, storage, translate};

use super::AppTxn;

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
fn note_translate_activity() {
    *LAST_TRANSLATE_AT.lock().expect("translate-activity mutex poisoned") = Instant::now();
}

/// worker 收尾调用：若离上次翻译活动已超过 [`IDLE_SHRINK_AFTER`] 且当前
/// cache 大于 [`SHRINK_TO`]，裁到目标。返回是否实际裁剪（裁了 dirty=true，
/// 调用方负责 save 重写磁盘）。
fn shrink_if_idle(cache: &mut Cache) -> bool {
    let now = Instant::now();
    let last = *LAST_TRANSLATE_AT
        .lock()
        .expect("translate-activity mutex poisoned");
    if now.saturating_duration_since(last) >= IDLE_SHRINK_AFTER
        && cache.len_pub() > SHRINK_TO
    {
        cache.shrink_to(SHRINK_TO) > 0
    } else {
        false
    }
}

#[derive(Clone, serde::Serialize)]
pub struct TranslationProgressEvt {
    pub r#gen: u64,
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, serde::Serialize)]
pub struct TranslationDoneEvt {
    pub r#gen: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translations: Option<Vec<(usize, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_bilingual: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<Vec<markdown::html::OutlineItem>>,
}

#[derive(Clone, serde::Serialize)]
pub struct TranslationPartialEvt {
    pub r#gen: u64,
    pub index: usize,
    pub text: String,
    pub from_cache: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct LookupDeltaEvt {
    pub text: String,
    pub content: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranslateStart {
    Started {
        r#gen: u64,
        /// 窗口化 run 的最小全局索引（全文=收集器首索引；空收集=0）。
        /// 兼容保留：前端打字机已改按下方 indices 序列放行（终审 C1）。
        first_index: usize,
        /// 本轮收集索引的完整文档序序列（= spawn_translation 收到的那份）。
        /// 窗口化按需/文献区段跳过使收集索引带缺口（如 [1,3,5]），打字机
        /// 按此序列放行，缺口不再被误判为"等连续前缀"而永久停摆（终审 C1）。
        indices: Vec<usize>,
    },
    Cached {
        done: TranslationDoneEvt,
    },
}

struct WorkerState {
    cache: Arc<Mutex<Cache>>,
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

pub(crate) fn done_payload_parts(
    indices: &[usize],
    results: &[Result<String, String>],
) -> (bool, Vec<(usize, String)>, Option<String>) {
    let mut pairs = Vec::new();
    let mut err = None;
    for (i, r) in results.iter().enumerate() {
        match r {
            Ok(v) => pairs.push((indices[i], v.clone())),
            Err(e) => {
                if err.is_none() {
                    err = Some(e.clone());
                }
            }
        }
    }
    pairs.sort_by_key(|p| p.0);
    (err.is_none(), pairs, err)
}

pub(crate) fn html_payload_parts(
    content: &str,
    trans: &HashMap<usize, String>,
    bilingual_batch: bool,
) -> (String, Option<String>, Option<String>, Vec<markdown::html::OutlineItem>) {
    let orig = markdown::html::render_html(content, &HashMap::new(), false);
    let (html_translation, html_bilingual) = if bilingual_batch {
        (None, Some(markdown::html::render_html(content, trans, true).html))
    } else {
        (Some(markdown::html::render_html(content, trans, false).html), None)
    };
    (orig.html, html_translation, html_bilingual, orig.outline)
}

/// 窗口化缓存全命中的整篇扫荡：与该 run 模式同一索引空间收集全文可译单元，
/// 逐单元查缓存，命中即带回。窗口化 precheck 只回窗口 pairs 时，文档其余
/// 部分的缓存命中要靠滚动逐窗补齐——第二击翻译（缓存全命中）只换视口那
/// 几行（用户实测 bug）；扫荡对让前端 merge+instant+canonical 重建一次
/// 整屏瞬时替换（验收点 5）。未命中块不带回，维持原文走视口运行补齐。
fn sweep_cached_pairs(
    snapshot: &Cache,
    provider: &str,
    variant: &str,
    blocks: &[markdown::model::Block],
    bilingual: bool,
) -> Vec<(usize, String)> {
    let units = if bilingual {
        markdown::units::collect_translatable(blocks)
    } else {
        markdown::units::collect_text_runs(blocks)
    };
    units
        .into_iter()
        .filter_map(|(i, t)| {
            snapshot
                .get(&Cache::key(provider, variant, &t))
                .map(|s| (i, s.to_string()))
        })
        .collect()
}

fn cached_done_evt(
    provider: &str,
    variant: &str,
    snapshot: &Cache,
    indices: &[usize],
    texts: &[String],
    content: &str,
    bilingual_batch: bool,
    windowed: bool,
) -> Option<TranslationDoneEvt> {
    let results: Vec<Result<String, String>> = texts
        .iter()
        .map(|t| {
            snapshot
                .get(&Cache::key(provider, variant, t))
                .map(|s| s.to_string())
                .ok_or_else(|| "缓存缺失".to_string())
        })
        .collect();
    let (ok, pairs, _) = done_payload_parts(indices, &results);
    if !ok {
        return None;
    }
    let map: HashMap<usize, String> = pairs.iter().cloned().collect();
    let (html_original, html_translation, html_bilingual, outline) = if windowed {
        // 窗口化载荷不携带整树 html：后端只有窗口 pairs，整树渲染会把
        // 窗口外已译块打回原文。显示由前端 patch 承担。
        (None, None, None, None)
    } else {
        let (html_original, html_translation, html_bilingual, outline) =
            html_payload_parts(content, &map, bilingual_batch);
        (Some(html_original), html_translation, html_bilingual, Some(outline))
    };
    Some(TranslationDoneEvt {
        r#gen: 0,
        ok: true,
        translations: Some(pairs),
        error: None,
        html_original,
        html_translation,
        html_bilingual,
        outline,
    })
}

#[tauri::command]
pub fn get_providers() -> Vec<dto::ProviderInfoDto> {
    translate::providers_meta::all_infos()
}

#[tauri::command]
pub fn get_provider_meta(key: String) -> Option<dto::ProviderInfoDto> {
    translate::providers_meta::info(&key)
}

#[tauri::command(async)]
pub fn translate_text(
    text: String,
    provider: String,
    creds: HashMap<String, String>,
) -> Result<String, String> {
    note_translate_activity();
    if translate::providers_meta::get(&provider).is_none() {
        return Err(format!("未知翻译源：{provider}"));
    }
    std::thread::spawn(move || {
        let http = translate::http::UreqClient::shared();
        translate::providers::provider(&provider, &text, &translate::providers::Creds(creds), http)
    })
    .join()
    .map_err(|_| "翻译线程崩溃".to_string())
    .and_then(|r| r)
}

#[tauri::command(async)]
pub fn lookup_word(
    text: String,
    creds: HashMap<String, String>,
    app: AppHandle,
    st: tauri::State<AppTxn>,
) -> Result<dto::WordLookupDTO, String> {
    note_translate_activity();
    let text = text.trim().to_string();
    let creds = translate::providers::Creds(creds);
    let variant = translate::lookup::cache_variant_for(&creds);
    {
        let c = st.cache.lock().expect("cache mutex poisoned");
        if let Some(dto) = translate::lookup::cache_get_lookup(&c, &text, &variant) {
            return Ok(dto);
        }
    }
    let dto = {
        let net_text = text.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let http = translate::http::UreqClient::shared();
            let mut emit = |acc: &str| {
                let _ = app.emit(
                    "lookup-delta",
                    LookupDeltaEvt {
                        text: net_text.clone(),
                        content: acc.to_string(),
                    },
                );
            };
            translate::lookup::lookup(&net_text, &creds, http, &mut emit)
        })
        .join()
        .map_err(|_| "查词线程崩溃".to_string())
        .and_then(|r| r)?
    };
    {
        let mut c = st.cache.lock().expect("cache mutex poisoned");
        translate::lookup::cache_put_lookup(&mut c, &text, &variant, &dto);
        let _ = c.save(&storage::cache_path());
    }
    Ok(dto)
}

#[tauri::command(async)]
pub fn llm_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    std::thread::spawn(move || {
        let http = translate::http::UreqClient::shared();
        translate::lookup::fetch_models(&base_url, &api_key, http)
    })
    .join()
    .map_err(|_| "模型列表线程崩溃".to_string())
    .and_then(|r| r)
}

#[tauri::command]
pub fn stop_translation(state: tauri::State<AppTxn>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn translate_document(
    app: AppHandle,
    content: String,
    mode: String,
    provider: String,
    creds: HashMap<String, String>,
    window: Option<[usize; 2]>,
    state: tauri::State<AppTxn>,
) -> Result<TranslateStart, String> {
    note_translate_activity();
    let meta = translate::providers_meta::get(&provider)
        .ok_or_else(|| format!("未知翻译源：{provider}"))?;
    let blocks = markdown::parse_blocks(&content);
    let win_range = window.map(|[top, end]| (top, end));
    let units = match mode.as_str() {
        "translation" => markdown::units::collect_text_runs_windowed(&blocks, win_range),
        "bilingual" => markdown::units::collect_translatable_windowed(&blocks, win_range),
        other => return Err(format!("不支持的模式：{other}")),
    };
    let snapshot = state.cache.lock().expect("cache mutex poisoned").clone();
    let (indices, texts): (Vec<usize>, Vec<String>) = units.into_iter().unzip();
    let bilingual = mode == "bilingual";
    let variant = translate::engine::cache_variant(
        &provider,
        creds.get("model").map(|s| s.as_str()).unwrap_or_default(),
    );
    if let Some(mut done) = cached_done_evt(
        &provider,
        &variant,
        &snapshot,
        &indices,
        &texts,
        &content,
        bilingual,
        window.is_some(),
    ) {
        // 窗口化缓存全命中：窗口 pairs 之外，把整篇缓存命中单元一并扫荡
        // 回带（见 sweep_cached_pairs 注释）——前端凭完整表整屏瞬时替换，
        // 不必滚到哪补到哪。全文（window=None）路径本就带全部 pairs，不扫。
        if window.is_some() {
            done.translations =
                Some(sweep_cached_pairs(&snapshot, &provider, &variant, &blocks, bilingual));
        }
        return Ok(TranslateStart::Cached { done });
    }
    state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有翻译在进行".to_string())?;
    let r#gen = state.r#gen.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);
    let first_index = indices.first().copied().unwrap_or(0);

    let st = WorkerState {
        cache: Arc::clone(&state.cache),
        cancel: Arc::clone(&state.cancel),
        running: Arc::clone(&state.running),
    };
    spawn_translation(
        app,
        r#gen,
        texts,
        indices.clone(), // Started 回传前端打字机放行序列（终审 C1）
        provider,
        creds,
        meta,
        st,
        snapshot,
        content,
        bilingual,
        window.is_some(),
    );
    Ok(TranslateStart::Started { r#gen, first_index, indices })
}

/// 会话收口重建：用前端累积的完整 translations 表渲染整树 canonical html。
/// 与 parse_markdown 同返回形态（ParseResult）；mode 决定替换形态。
#[tauri::command(async)]
pub fn render_translated(
    content: String,
    mode: String,
    translations: Vec<(usize, String)>,
) -> Result<markdown::html::ParseResult, String> {
    let bilingual = match mode.as_str() {
        "translation" => false,
        "bilingual" => true,
        other => return Err(format!("不支持的模式：{other}")),
    };
    let map: HashMap<usize, String> = translations.into_iter().collect();
    Ok(markdown::html::render_html(&content, &map, bilingual))
}

fn spawn_translation(
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
) {
    std::thread::spawn(move || {
        let http0 = translate::http::UreqClient::shared();
        let http = translate::cancel::CancelableClient {
            inner: http0,
            cancel: &st.cancel,
        };
        let creds = translate::providers::Creds(creds);
        let variant = translate::engine::cache_variant(
            &provider,
            creds.get("model").unwrap_or_default(),
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
        };

        let app_evt = app.clone();
        let last_progress: Mutex<Option<std::time::Instant>> = Mutex::new(None);
        let emit = |ev: translate::engine::EngineEvent| match ev {
            translate::engine::EngineEvent::Unit { index, text, from_cache } => {
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text, from_cache },
                );
            }
            translate::engine::EngineEvent::Progress { done, total } => {
                let mut last = last_progress.lock().expect("progress mutex poisoned");
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
            translate::engine::EngineEvent::Failed { .. } => {}
        };

        let results = translate::engine::run(&req, &mut work_cache, &emit);

        {
            let mut shared = st.cache.lock().expect("cache mutex poisoned");
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
                    html_payload_parts(&content, &map, bilingual);
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
        st.running.store(false, Ordering::SeqCst);
        let _ = app.emit("translation-done", payload);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_payload_parts_sorts_pairs_and_picks_first_error() {
        let indices = [5usize, 2, 9];
        let results = vec![
            Ok("五".to_string()),
            Err("已取消".to_string()),
            Ok("九".to_string()),
        ];
        let (ok, pairs, err) = done_payload_parts(&indices, &results);
        assert!(!ok);
        assert_eq!(err.as_deref(), Some("已取消"));
        assert_eq!(pairs, vec![(5usize, "五".into()), (9usize, "九".into())]);

        let (_, pairs2, _) =
            done_payload_parts(&[3usize, 1], &[Ok("乙".into()), Ok("甲".into())]);
        assert_eq!(pairs2, vec![(1usize, "甲".into()), (3usize, "乙".into())]);
    }

    #[test]
    fn cached_precheck_returns_payload_only_on_full_hit() {
        let mut c = Cache::new();
        c.set(Cache::key("p", "", "a"), "甲".into());
        c.set(Cache::key("p", "", "b"), "乙".into());
        let evt = cached_done_evt(
            "p",
            "",
            &c,
            &[0, 1],
            &["a".into(), "b".into()],
            "# t\n\na b",
            false,
            false,
        )
        .expect("全命中应返回同步产物");
        assert!(evt.ok);
        assert_eq!(
            evt.translations,
            Some(vec![(0usize, "甲".into()), (1usize, "乙".into())])
        );
        assert!(evt.html_translation.is_some());
        assert!(evt.html_bilingual.is_none());
        assert!(evt.html_original.is_some());
        assert!(evt.outline.is_some());
        let evt2 = cached_done_evt("p", "", &c, &[0], &["a".into()], "a", true, false)
            .expect("全命中");
        assert!(evt2.html_bilingual.is_some() && evt2.html_translation.is_none());
        assert!(
            cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "x".into()], "# t", false, false)
                .is_none()
        );
        assert!(
            cached_done_evt("q", "", &c, &[0], &["a".into()], "# t", false, false).is_none()
        );
        c.set(Cache::key("llm", "old-model@v1", "a"), "旧译文".into());
        assert!(
            cached_done_evt("llm", "old-model@v1", &c, &[0], &["a".into()], "# t", false, false)
                .is_some()
        );
        assert!(
            cached_done_evt("llm", "new-model@v1", &c, &[0], &["a".into()], "# t", false, false)
                .is_none(),
            "换模型必须 miss"
        );
        assert!(cached_done_evt("p", "", &c, &[], &[].to_vec(), "# t", false, false).is_some());
        let evt_w = cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "b".into()], "# t\n\na b", false, true)
            .expect("窗口化全命中");
        assert!(evt_w.html_original.is_none());
        assert!(evt_w.html_translation.is_none());
        assert!(evt_w.html_bilingual.is_none());
        assert!(evt_w.outline.is_none());
        assert_eq!(evt_w.translations, Some(vec![(0usize, "甲".into()), (1usize, "乙".into())]));
    }

    #[test]
    fn sweep_cached_pairs_returns_whole_document_hits() {
        // 窗口化缓存全命中的扫荡：整篇收集（与窗口同一模式索引空间）逐单元查
        // 缓存，命中即带回——第二击翻译时前端凭完整 pairs 整屏瞬时替换
        //（验收点 5），而非只补视口窗口那几行。
        let blocks = markdown::parse_blocks("One\n\nTwo\n\nThree");
        let mut c = Cache::new();
        c.set(Cache::key("p", "", "One"), "甲".into());
        c.set(Cache::key("p", "", "Two"), "乙".into());
        c.set(Cache::key("p", "", "Three"), "丙".into());
        assert_eq!(
            sweep_cached_pairs(&c, "p", "", &blocks, false),
            vec![(0usize, "甲".into()), (1usize, "乙".into()), (2usize, "丙".into())]
        );
        // 部分命中：只带回缓存过的单元，未命中块留给滚动触发的视口运行
        let mut c2 = Cache::new();
        c2.set(Cache::key("p", "", "Two"), "乙".into());
        assert_eq!(sweep_cached_pairs(&c2, "p", "", &blocks, false), vec![(1usize, "乙".into())]);
        // bilingual：块空间（data-bi）索引；跳过区段/纯中文块不出现
        let blocks_b = markdown::parse_blocks("# Eng\n\nAnother one\n\n## References\n\n**X** 2020.");
        let mut c3 = Cache::new();
        c3.set(Cache::key("p", "", "Eng"), "标题".into());
        c3.set(Cache::key("p", "", "Another one"), "另一段".into());
        assert_eq!(
            sweep_cached_pairs(&c3, "p", "", &blocks_b, true),
            vec![(0usize, "标题".into()), (1usize, "另一段".into())]
        );
        // 换模型 variant：缓存键不匹配 → 空
        assert!(sweep_cached_pairs(&c3, "p", "other@v1", &blocks_b, true).is_empty());
    }

    #[test]
    fn translation_partial_evt_wire_shape() {
        let e = TranslationPartialEvt {
            r#gen: 4,
            index: 12,
            text: "译文".into(),
            from_cache: true,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 4);
        assert_eq!(v["index"], 12);
        assert_eq!(v["text"], "译文");
        assert_eq!(v["from_cache"], true);
    }

    #[test]
    fn translate_start_started_carries_indices() {
        // 终审 C1 回归锚点：Started 必须携带本轮收集索引序列（文档序，可带
        // 缺口）——前端打字机按此序列放行，而非"连续 +1"游标；first_index
        // 为兼容保留（= 序列首元素；空收集为 0）。
        let e = TranslateStart::Started {
            r#gen: 6,
            first_index: 1,
            indices: vec![1, 3, 5],
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "started");
        assert_eq!(v["gen"], 6);
        assert_eq!(v["first_index"], 1);
        assert_eq!(v["indices"], serde_json::json!([1, 3, 5]));
        // 全文 run：索引连续且从收集器首索引起（此处 0 起）
        let full = TranslateStart::Started {
            r#gen: 7,
            first_index: 0,
            indices: vec![0, 1, 2],
        };
        let v2 = serde_json::to_value(&full).unwrap();
        assert_eq!(v2["indices"], serde_json::json!([0, 1, 2]));
    }

    #[test]
    fn translation_done_evt_wire_shape() {
        let e = TranslationDoneEvt {
            r#gen: 7,
            ok: true,
            translations: Some(vec![(0, "甲".into()), (1, "乙".into())]),
            error: None,
            html_original: Some(r#"<h1 id="h-1">T</h1>"#.into()),
            html_translation: Some("<p>译</p>".into()),
            html_bilingual: None,
            outline: Some(vec![markdown::html::OutlineItem {
                level: 1,
                text: "T".into(),
                id: "h-1".into(),
            }]),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 7);
        assert_eq!(v["ok"], true);
        assert_eq!(v["translations"], serde_json::json!([[0, "甲"], [1, "乙"]]));
        assert!(v.get("error").is_none());
        assert_eq!(v["html_original"], r#"<h1 id="h-1">T</h1>"#);
        assert_eq!(v["html_translation"], "<p>译</p>");
        assert!(v.get("html_bilingual").is_none());
        assert_eq!(
            v["outline"],
            serde_json::json!([{ "level": 1, "text": "T", "id": "h-1" }])
        );

        let e2 = TranslationDoneEvt {
            r#gen: 7,
            ok: false,
            translations: None,
            error: Some("已取消".into()),
            html_original: None,
            html_translation: None,
            html_bilingual: None,
            outline: None,
        };
        let v2 = serde_json::to_value(&e2).unwrap();
        assert_eq!(v2["error"], "已取消");
        assert!(v2.get("translations").is_none());
        assert!(v2.get("html_original").is_none());
        assert!(v2.get("html_bilingual").is_none());
        assert!(v2.get("outline").is_none());
    }

    #[test]
    fn windowed_done_evt_omits_html_fields() {
        let e = TranslationDoneEvt {
            r#gen: 9,
            ok: true,
            translations: Some(vec![(3, "窗".into())]),
            error: None,
            html_original: None,
            html_translation: None,
            html_bilingual: None,
            outline: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("html_original").is_none());
        assert!(v.get("html_translation").is_none());
        assert!(v.get("html_bilingual").is_none());
        assert!(v.get("outline").is_none());
        assert_eq!(v["translations"], serde_json::json!([[3, "窗"]]));
    }

    #[test]
    fn render_translated_builds_canonical_html() {
        let r = render_translated(
            "# Ti\n\nHello world".into(),
            "bilingual".into(),
            vec![(0usize, "中文标题".into()), (1usize, "你好世界".into())],
        )
        .unwrap();
        assert!(r.html.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(r.html.contains(r#"<div class="tr-box">你好世界</div>"#));
        let r2 = render_translated("Hi".into(), "original".into(), vec![]).unwrap_err();
        assert!(r2.contains("不支持的模式"));
    }

    #[test]
    fn html_payload_parts_follow_batch_index_space() {
        let mut m = HashMap::new();
        m.insert(0usize, "标题".into());
        m.insert(1usize, "你好".into());
        m.insert(2usize, "世界".into());
        m.insert(3usize, "更多".into());
        let (html_original, tr, bi, outline) =
            html_payload_parts("# Ti\n\nHello **world** more", &m, false);
        assert!(html_original
            .contains(r#"<h1 id="h-1" data-bi="0"><span data-ri="0">Ti</span></h1>"#));
        assert!(html_original.contains(
            r#"<p data-bi="1"><span data-ri="1">Hello </span><strong><span data-ri="2">world</span></strong><span data-ri="3"> more</span></p>"#
        ));
        let tr = tr.expect("translation batch must carry substituted form");
        assert!(tr.contains(r#"<h1 id="h-1" data-bi="0"><span data-ri="0">标题</span></h1>"#));
        assert!(tr.contains(
            r#"<p data-bi="1"><span data-ri="1">你好</span><strong><span data-ri="2">世界</span></strong><span data-ri="3">更多</span></p>"#
        ));
        assert!(bi.is_none());
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].text, "Ti");
        assert_eq!(outline[0].id, "h-1");

        let mut b = HashMap::new();
        b.insert(0usize, "中文标题".into());
        b.insert(1usize, "中文正文".into());
        let (orig2, tr2, bi2, _) =
            html_payload_parts("# Ti\n\nHello **world** more", &b, true);
        assert!(tr2.is_none());
        let bi2 = bi2.expect("bilingual batch must carry bilingual form");
        assert!(bi2.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(bi2.contains(r#"<div class="tr-box">中文正文</div>"#));
        assert!(orig2.contains(
            r#"<p data-bi="1"><span data-ri="1">Hello </span><strong><span data-ri="2">world</span></strong><span data-ri="3"> more</span></p>"#
        ));
    }

    #[test]
    fn translation_progress_evt_wire_shape() {
        let e = TranslationProgressEvt {
            r#gen: 3,
            done: 2,
            total: 5,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 3);
        assert_eq!(v["done"], 2);
        assert_eq!(v["total"], 5);
    }
}
