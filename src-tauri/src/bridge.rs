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

fn cached_done_evt(
    provider: &str,
    variant: &str,
    snapshot: &Cache,
    indices: &[usize],
    texts: &[String],
    content: &str,
    bilingual_batch: bool,
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
    let (html_original, html_translation, html_bilingual, outline) =
        html_payload_parts(content, &map, bilingual_batch);
    Some(TranslationDoneEvt {
        r#gen: 0,
        ok: true,
        translations: Some(pairs),
        error: None,
        html_original: Some(html_original),
        html_translation,
        html_bilingual,
        outline: Some(outline),
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
    state: tauri::State<AppTxn>,
) -> Result<TranslateStart, String> {
    note_translate_activity();
    let meta = translate::providers_meta::get(&provider)
        .ok_or_else(|| format!("未知翻译源：{provider}"))?;
    let blocks = markdown::parse_blocks(&content);
    let units = match mode.as_str() {
        "translation" => markdown::units::collect_text_runs(&blocks),
        "bilingual" => markdown::units::collect_translatable(&blocks),
        other => return Err(format!("不支持的模式：{other}")),
    };
    let snapshot = state.cache.lock().expect("cache mutex poisoned").clone();
    let (indices, texts): (Vec<usize>, Vec<String>) = units.into_iter().unzip();
    let bilingual = mode == "bilingual";
    let variant = translate::engine::cache_variant(
        &provider,
        creds.get("model").map(|s| s.as_str()).unwrap_or_default(),
    );
    if let Some(done) = cached_done_evt(
        &provider,
        &variant,
        &snapshot,
        &indices,
        &texts,
        &content,
        bilingual,
    ) {
        return Ok(TranslateStart::Cached { done });
    }
    state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有翻译在进行".to_string())?;
    let r#gen = state.r#gen.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);

    let st = WorkerState {
        cache: Arc::clone(&state.cache),
        cancel: Arc::clone(&state.cancel),
        running: Arc::clone(&state.running),
    };
    spawn_translation(
        app,
        r#gen,
        texts,
        indices,
        provider,
        creds,
        meta,
        st,
        snapshot,
        content,
        bilingual,
    );
    Ok(TranslateStart::Started { r#gen })
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
            translate::engine::EngineEvent::Unit { index, text } => {
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text },
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
        let evt2 =
            cached_done_evt("p", "", &c, &[0], &["a".into()], "a", true).expect("全命中");
        assert!(evt2.html_bilingual.is_some() && evt2.html_translation.is_none());
        assert!(
            cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "x".into()], "# t", false)
                .is_none()
        );
        assert!(cached_done_evt("q", "", &c, &[0], &["a".into()], "# t", false).is_none());
        c.set(Cache::key("llm", "old-model@v1", "a"), "旧译文".into());
        assert!(cached_done_evt("llm", "old-model@v1", &c, &[0], &["a".into()], "# t", false)
            .is_some());
        assert!(
            cached_done_evt("llm", "new-model@v1", &c, &[0], &["a".into()], "# t", false)
                .is_none(),
            "换模型必须 miss"
        );
        assert!(cached_done_evt("p", "", &c, &[], &[].to_vec(), "# t", false).is_some());
    }

    #[test]
    fn translation_partial_evt_wire_shape() {
        let e = TranslationPartialEvt {
            r#gen: 4,
            index: 12,
            text: "译文".into(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 4);
        assert_eq!(v["index"], 12);
        assert_eq!(v["text"], "译文");
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
