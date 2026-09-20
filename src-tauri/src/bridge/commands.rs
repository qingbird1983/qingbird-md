//! 翻译相关 IPC 命令外壳：9 个 `#[tauri::command]`，围绕 `translate::engine`
//! + cache 的同一连贯入口面。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter};

use crate::AppTxn;
use crate::{dto, markdown, storage, translate};

use super::events::{LookupDeltaEvt, TranslateStart};
use super::payload::{cached_done_evt, sweep_cached_pairs};
use super::worker::{WorkerState, note_translate_activity, spawn_translation};

#[tauri::command]
pub fn get_providers() -> Vec<dto::ProviderInfoDto> {
    translate::providers_meta::all_infos()
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
        // 划词/单串路径**没有方向入口**（选区只有"查一下"这一个动作，没有语言选择
        // UI）→ 取默认方向。这是 `default_target()` 存在的正当理由；有方向入参的
        // 路径（translate_document 等）必须用入参，不许走这里。
        translate::providers::provider(
            &provider,
            &text,
            &translate::providers::Creds(creds),
            http,
            translate::engine::default_target(),
        )
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
        let c = st.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dto) = translate::lookup::cache_get_lookup(&c, &text, &variant) {
            return Ok(dto);
        }
    }
    let dto = {
        let net_text = text.clone();
        let app = app.clone();
        let cancel = Arc::clone(&st.cancel);
        // REL-7：查词与整篇翻译共用同一取消旗标（请求前 + 流式行边界都快速
        // 失败）。翻译空闲时顺手清掉上一次 stop_translation 留下的陈旧旗标，
        // 否则「停止翻译后划词永远已取消」；翻译进行中则不动它——那一刻的
        // stop 语义属于翻译（停止翻译顺带掐断在途查词，正是期望行为）。
        if !st.running.load(Ordering::SeqCst) {
            st.cancel.store(false, Ordering::SeqCst);
        }
        std::thread::spawn(move || {
            let http = translate::cancel::CancelableClient {
                inner: translate::http::UreqClient::shared(),
                cancel: &cancel,
            };
            let mut emit = |acc: &str| {
                let _ = app.emit(
                    "lookup-delta",
                    LookupDeltaEvt {
                        text: net_text.clone(),
                        content: acc.to_string(),
                    },
                );
            };
            translate::lookup::lookup(&net_text, &creds, &http, &mut emit)
        })
        .join()
        .map_err(|_| "查词线程崩溃".to_string())
        .and_then(|r| r)?
    };
    {
        let mut c = st.cache.lock().unwrap_or_else(|e| e.into_inner());
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

// async（PERF-2）：本命令里有 parse_blocks + 整缓存快照 clone + 收口时的
// 最多 3 次整树渲染，同步命令在主线程执行会冻结窗口——与 open_file /
// parse_markdown 刻意 async 的口径一致。
#[tauri::command(async)]
pub fn translate_document(
    app: AppHandle,
    content: String,
    mode: String,
    provider: String,
    creds: HashMap<String, String>,
    window: Option<[usize; 2]>,
    target_lang: String,
    state: tauri::State<AppTxn>,
) -> Result<TranslateStart, String> {
    note_translate_activity();
    let meta = translate::providers_meta::get(&provider)
        .ok_or_else(|| format!("未知翻译源：{provider}"))?;
    let blocks = markdown::parse_blocks(&content);
    let win_range = window.map(|[top, end]| (top, end));
    // ★ 本轮的翻译方向。**本函数内所有下游调用必须用同一个 target 值**——
    // 收集、缓存 key、html 渲染三处的方向只要有一个不一致，`data-bi` 编号空间
    // 就会错位 → 译文贴错块（且不报错）。前端也必须把同一个方向传给
    // `parse_markdown` / `open_file` / `render_translated`，那边产出的
    // html 正是这些编号的落点。
    let target = translate::engine::TargetLang::from_tag(&target_lang);
    let (units, indices_blocks) = match mode.as_str() {
        "translation" => markdown::units::collect_text_runs_windowed_blocks(&blocks, win_range, target),
        "bilingual" => {
            let units = markdown::units::collect_translatable_windowed(&blocks, win_range, target);
            let blocks_of = units.iter().map(|&(i, _)| i).collect::<Vec<_>>();
            (units, blocks_of)
        }
        other => return Err(format!("不支持的模式：{other}")),
    };
    let snapshot = state.cache.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (indices, texts): (Vec<usize>, Vec<String>) = units.into_iter().unzip();
    let bilingual = mode == "bilingual";
    let variant = translate::engine::cache_variant(
        &provider,
        creds.get("model").map(|s| s.as_str()).unwrap_or_default(),
        target,
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
        target,
    ) {
        // 窗口化缓存全命中：窗口 pairs 之外，把整篇缓存命中单元一并扫荡
        // 回带（见 sweep_cached_pairs 注释）——前端凭完整表整屏瞬时替换，
        // 不必滚到哪补到哪。全文（window=None）路径本就带全部 pairs，不扫。
        if window.is_some() {
            done.translations =
                Some(sweep_cached_pairs(&snapshot, &provider, &variant, &blocks, bilingual, target));
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
        target,
    );
    Ok(TranslateStart::Started { r#gen, first_index, indices, indices_blocks })
}

/// 会话收口重建：用前端累积的完整 translations 表渲染整树 canonical html。
/// 与 parse_markdown 同返回形态（ParseResult）；mode 决定替换形态。
#[tauri::command(async)]
pub fn render_translated(
    content: String,
    mode: String,
    translations: Vec<(usize, String)>,
    target_lang: String,
) -> Result<markdown::html::ParseResult, String> {
    let bilingual = match mode.as_str() {
        "translation" => false,
        "bilingual" => true,
        other => return Err(format!("不支持的模式：{other}")),
    };
    let map: HashMap<usize, String> = translations.into_iter().collect();
    // 收口渲染与起跑用**同一个方向**：这里算出的 `data-bi` 编号必须和
    // `translate_document` 收集时逐位一致，否则整表译文会错位到别的块。
    Ok(markdown::html::render_html(
        &content,
        &map,
        bilingual,
        translate::engine::TargetLang::from_tag(&target_lang),
    ))
}

/// 译文另存为（Step 2）：把当前译文表落成 Markdown 文本。
///
/// **不写盘**——落盘走前端 `pick_save_path` + `save_file`，与「导出 HTML」
/// 同一套路，本命令只负责「translations → md 字符串」这一件事。
///
/// `mode ∈ {"translation", "bilingual"}`：
/// - **translation**（默认、单语）：`translations` 的 key 是 `data-ri` run
///   空间，与 `translate_document` 的收集、`render_translated` 的收口**共用
///   同一索引空间**；序列化侧的遍历顺序与计数规则由 `markdown::cmark` 保证
///   与 `units::collect_text_runs` 逐位一致（见该文件模块注释与
///   `export_run_space_*` 守卫测试）。**不需要 target_lang**——
///   `data-ri` 是方向无关的（`Inline::Text` 恒占号）。
/// - **bilingual**（对照）：`translations` 的 key 是 `data-bi` 块空间，
///   **方向相关**——哪些块"可译"取决于翻译方向。所以 `target_lang` 必须传，
///   导出侧用它来判定"这一块是不是该出译文、出译文时用哪个块号"。
///
/// `target_lang` 在 `mode == "translation"` 时忽略（避免冗余参数成为第三个
/// 可能漂的判据）；`mode == "bilingual"` 时**强制要求**——前端调用前已断言
/// `mode === lastRunMode`，这里再校验一次避免前端漏传。
#[tauri::command(async)]
pub fn export_translation(
    content: String,
    translations: Vec<(usize, String)>,
    mode: String,
    target_lang: String,
) -> String {
    let map: HashMap<usize, String> = translations.into_iter().collect();
    match mode.as_str() {
        "bilingual" => {
            let target = translate::engine::TargetLang::from_tag(&target_lang);
            translate::export::export_bilingual(&content, &map, target)
        }
        // 默认（含 `"translation"` 与未知值）走单语路径——前端调用前已用
        // `exportGate` 卡住，这里兜底"单语"避免误传让用户拿到空文件
        // （参 §五 第 2 步 #8 的判据：导出必走收集侧的索引空间）。
        _ => markdown::cmark::export_translation(&content, &map),
    }
}

#[tauri::command]
pub fn check_translation(
    content: String,
    translations: Vec<(usize, String)>,
    mode: String,
    target_lang: String,
) -> Vec<translate::check::Issue> {
    let map: HashMap<usize, String> = translations.into_iter().collect();
    // mode/target_lang 决定在哪套索引空间（translation = data-ri run 空间，
    // bilingual = data-bi 块空间）收集单元再对号——必须与产出 translations
    // 的那轮翻译同模式、同方向（P0-2 / BUG-2）。
    translate::check::check_translation(&content, &map, &mode, &target_lang)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_translated_builds_canonical_html() {
        let r = render_translated(
            "# Ti\n\nHello world".into(),
            "bilingual".into(),
            vec![(0usize, "中文标题".into()), (1usize, "你好世界".into())],
            "zh".into(),
        )
        .unwrap();
        assert!(r.html.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(r.html.contains(r#"<div class="tr-box">你好世界</div>"#));
        let r2 = render_translated("Hi".into(), "original".into(), vec![], "zh".into()).unwrap_err();
        assert!(r2.contains("不支持的模式"));
    }

    /// 收口渲染的方向必须真的落到 `data-bi` 编号上——这是「译文贴错块」那条
    /// 红线的渲染侧哨兵。纯中文文档在 zh 下**整篇不可译**（没有块占号），
    /// 在 en 下**每个块都可译**（块 0/1 各占一号）。
    #[test]
    fn render_translated_numbering_follows_the_direction() {
        let content = "# 标题\n\n正文段落";
        let zh = render_translated(content.into(), "translation".into(), vec![], "zh".into()).unwrap();
        let en = render_translated(content.into(), "translation".into(), vec![], "en".into()).unwrap();
        assert!(!zh.html.contains("data-bi="), "zh 下纯中文文档无可译块：{}", zh.html);
        assert!(en.html.contains(r#"data-bi="0""#) && en.html.contains(r#"data-bi="1""#), "{}", en.html);
        // 未知 tag 回落 zh（老配置/手改入参不得让渲染崩掉）
        let junk = render_translated(content.into(), "translation".into(), vec![], "klingon".into()).unwrap();
        assert_eq!(junk.html, zh.html);
    }
}
