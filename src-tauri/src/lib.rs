//! Tauri entry point: managed app state (`AppTxn`) + the first IPC commands
//! (file read/write, settings read/write). Workspace/editor commands land in
//! Task 6, dialogs Task 9, translation Task 8 — appended to `generate_handler!`.

mod dto;
mod editor;
mod fileopen;
mod hotkeys;
mod markdown;
mod single_instance;
mod storage;
mod translate;
mod workspace;

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, FilePath};

use translate::cache::Cache;

/// Managed shared state, registered via `.manage(AppTxn::new(lock))`.
///
/// `ponytail:` lock_file 初始化后永不读（测试断言保留除外）——持有 File 本身
/// 就是让 OS 建议锁活到进程退出，不是脚手架。
#[allow(dead_code)]
struct AppTxn {
    /// 翻译缓存共享。Arc 包一层：Task 8 后台 worker 克隆 Arc 出去，收尾时
    /// 短暂锁回写新键并落盘——绝不跨网络请求持锁。
    cache: Arc<Mutex<Cache>>,
    cancel: Arc<AtomicBool>, // 当前批次取消旗标
    running: Arc<AtomicBool>,
    /// 代次：新一轮翻译 +1；事件里带上，前端丢弃过期。
    /// Rust 2024 保留字，raw identifier（序列化不涉及，仅内部状态）。
    r#gen: AtomicU64,
    lock_file: Mutex<Option<File>>, // 单实例锁持有物，保进程生命周期
}

impl Default for AppTxn {
    fn default() -> Self {
        Self {
            cache: Arc::new(Mutex::new(Cache::new())),
            cancel: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            r#gen: AtomicU64::new(0),
            lock_file: Mutex::new(None),
        }
    }
}

impl AppTxn {
    fn new(lock: Option<File>) -> Self {
        let s = Self::default();
        // 启动时接续上次落盘的翻译记忆（save 在 worker 收尾/clear_cache 时写回）。
        // Default 保持空缓存，测试不依赖真机磁盘状态。
        *s.cache.lock().expect("cache mutex poisoned") = Cache::load(&storage::cache_path());
        *s.lock_file.lock().expect("lock_file mutex poisoned") = lock;
        s
    }
}

// ---- 文件 ----

#[tauri::command]
fn open_file(path: String) -> Result<dto::DocDTO, String> {
    let p = std::path::PathBuf::from(&path);
    let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(dto::doc_dto(&p, content))
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ---- 对话框（Task 9，tauri-plugin-dialog）----

/// Convert a dialog result into a path string: `FilePath::Path` -> string,
/// everything else (`Url`, `None`) -> None.
fn dialog_result_to_path(chosen: Option<FilePath>) -> Option<String> {
    match chosen {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// Native open-file dialog filtered to markdown-ish files.
///
/// blocking API 禁止主线程调用（会冻结事件循环），故命令为 async——
/// 跑在 tauri::async_runtime 的 worker 线程上。
#[tauri::command]
async fn pick_file(window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .set_parent(&window)
        .blocking_pick_file();
    dialog_result_to_path(chosen)
}

/// Native directory picker for a workspace folder.
#[tauri::command]
async fn pick_folder(window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder();
    dialog_result_to_path(chosen)
}

/// Native save dialog seeded with a default filename.
#[tauri::command]
async fn pick_save_path(default_name: String, window: tauri::Window) -> Option<String> {
    let chosen = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .blocking_save_file();
    dialog_result_to_path(chosen)
}

// ---- 设置 ----

#[tauri::command]
fn load_settings() -> storage::Settings {
    storage::load_settings()
}

/// 保存设置到用户数据目录，成功后向全部窗口广播 `settings-updated`
/// （payload 即新 Settings 对象——前端多窗口/刷新后感知，Task 14 监听）。
/// 先持久化、后广播：磁盘写入失败直接返回 Err 且不发事件。
#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: storage::Settings) -> Result<(), String> {
    storage::save_settings(&settings)?;
    // T29：设置落盘后同步全局热键（unregister_all + 按新值重注册）。
    // 同步命令跑在主线程，满足 RegisterHotKey 的线程约束。
    hotkeys::sync(&app, &settings);
    app.emit("settings-updated", &settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_user_data_dir() -> String {
    storage::user_data_dir().to_string_lossy().into_owned()
}

/// 清空翻译缓存并立即落盘（Task 26 设置弹窗「清除翻译缓存」）。
/// 两次短暂锁：clear 与 save 各自持锁，绝不跨任何长操作持有。
#[tauri::command]
fn clear_cache(st: tauri::State<AppTxn>) {
    st.cache.lock().expect("cache mutex poisoned").clear();
    let _ = st
        .cache
        .lock()
        .expect("cache mutex poisoned")
        .save(&storage::cache_path());
}

// ---- 工作区 ----

/// Walk a workspace folder into the frontend file tree (`.md`/`.markdown`
/// `.txt` only; dotfiles and vendored/build dirs skipped by `workspace::walk`).
#[tauri::command]
fn open_workspace(path: String) -> Vec<dto::TreeNodeDTO> {
    tree_out(&workspace::walk(std::path::Path::new(&path)))
}

/// Filter a client-held tree by filename query. Kernel filter operates on
/// [`workspace::TreeNode`], so this is the pure mechanical mapping
/// DTO→TreeNode→filter→DTO.
#[tauri::command]
fn filter_workspace(tree: Vec<dto::TreeNodeDTO>, query: String) -> Vec<dto::TreeNodeDTO> {
    tree_out(&workspace::filter(&tree_in(&tree), &query))
}

/// Create an empty file; refuses to overwrite (`create_new`).
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(_) => Ok(()),
        Err(e) => Err(create_err("创建文件失败", &path, e)),
    }
}

/// Create a single directory (no parents implied).
#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| create_err("创建文件夹失败", &path, e))
}

/// Wire-contract error text: "已存在" when the target exists (the frontend
/// may match on it), contextual message for any other IO failure.
fn create_err(what: &str, path: &str, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AlreadyExists {
        "已存在".into()
    } else {
        format!("{what} {path}: {e}")
    }
}

// ---- 预览（Task 7）----

/// Resolve a markdown image `src` to a local absolute path
/// （逻辑 = 旧 render.rs::resolve_src 平移）：
/// - http(s)/data: -> `None`（远程图交给前端按 alt 兜底）
/// - file:// -> 剥前缀原样使用
/// - 相对路径 -> 与文档目录（base_dir）拼接
///
/// ponytail: 不做 `..` 归一化——asset 协议 scope 显式放开为 `**`
/// （文档可能在任意盘符目录，功能性需求而非漏洞放宽），scope 见 tauri.conf.json 的 assetProtocol。
fn resolve(src: &str, base_dir: Option<&str>) -> Option<PathBuf> {
    let s = src.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(p) = s.strip_prefix("file://") {
        // 三斜杠 file:///C:/x.png 剥 `file://` 后余 `/C:/x.png`，前导斜杠在
        // Windows 上不是有效本地路径——剥净；双斜杠 file://C:/x.png 原样无影响
        // （旧 Electron 平移行为保持）。
        return Some(PathBuf::from(p.trim_start_matches('/')));
    }
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") {
        return None;
    }
    let p = PathBuf::from(base_dir?).join(s);
    // join 在 Windows 上插入反斜杠；统一为 '/' 保持路径字符串可预测
    // （前端展示、测试断言一致）。Win32 API 两种分隔符均接受。
    Some(PathBuf::from(p.to_string_lossy().replace('\\', "/")))
}

#[tauri::command]
fn resolve_image(src: String, base_dir: Option<String>) -> Option<String> {
    resolve(&src, base_dir.as_deref()).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn parse_markdown(content: String) -> markdown::html::ParseResult {
    markdown::html::render_html(&content, &std::collections::HashMap::new(), false)
}

// ---- 编辑器纯逻辑外壳 ----

#[tauri::command]
fn apply_op(op: dto::EditOp) -> dto::EditResult {
    apply_op_map(op)
}

/// Type-mapping shell around [`editor::apply_op`] ([usize;2] ↔ byte pair).
/// Snaps the selection onto UTF-8 char boundaries first so malformed IPC
/// payloads cannot panic mid-character — the frontend normally converts
/// CodeMirror code-point offsets to byte offsets before calling (plan Task 14).
pub(crate) fn apply_op_map(op: dto::EditOp) -> dto::EditResult {
    let c = &op.content;
    let s = snap_down(c, op.sel[0]);
    let e = snap_down(c, op.sel[1]).max(s);
    let (content, sel) = editor::apply_op(c, (s, e), &op.op);
    dto::EditResult { content, sel: [sel.0, sel.1] }
}

/// Clamp to string length and floor to the nearest preceding char boundary.
/// `is_char_boundary(0)` is always true, so this terminates.
fn snap_down(c: &str, mut i: usize) -> usize {
    i = i.min(c.len());
    while !c.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// ---- 翻译（Task 8）----

/// Wire contract for the `translation-progress` event (Task 14 binds these
/// exact field names). Serialized as `{gen, done, total}`.
#[derive(Clone, serde::Serialize)]
struct TranslationProgressEvt {
    /// Rust 2024 保留字 raw identifier；serde 序列化仍输出 `"gen"`。
    r#gen: u64,
    done: usize,
    total: usize,
}

/// Wire contract for the `translation-done` event:
/// `{gen, ok, translations?: [[usize, String]], error?,
///   html_original?, html_translation?, html_bilingual?, outline?}`.
/// `translations` 是按下标升序的 pair 数组（HashMap 无序，保证前端确定性渲染）；
/// None 字段在 JSON 中整体缺席。
///
/// Task 8 扩展：完成路径随事件附带三种渲染形态 + 原文结构 outline，前端切
/// 模式零延迟。译文形态只出与批次索引空间匹配的一种（见
/// [`html_payload_parts`]），另一种缺席——错配空间会把译文放错位置。
#[derive(Clone, serde::Serialize)]
struct TranslationDoneEvt {
    r#gen: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    translations: Option<Vec<(usize, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html_original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html_translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    html_bilingual: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outline: Option<Vec<markdown::html::OutlineItem>>,
}

/// Pure core of the done-payload assembly (unit-testable without threads):
/// successes become `[index, text]` pairs sorted ascending; the first error wins.
fn done_payload_parts(
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

/// 完成路径的 html/outline 组装（纯函数，worker 收尾调用）：
/// - 原文形态恒出：空 map = 纯原文渲染，outline 为原文结构（只此一份）。
/// - 译文形态按批次索引空间二选一：translation 批次的 map 是
///   `units::collect_text_runs` 空间 → substituted 形式（trans 非空即替换）；
///   bilingual 批次的 map 是 `units::collect_translatable` 空间 → bilingual
///   形式。另一形式缺席：两个收集器的索引空间互不兼容，错配会把译文放在
///   错误位置，宁缺勿错（前端可自行回退渲染）。
/// - render_html 内部自行 parse_blocks：brief 裁定先对齐行为，不重构共享解析。
fn html_payload_parts(
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

/// State pieces cloned out of [`AppTxn`] once at start so the worker thread
/// never touches managed-state borrows.
struct WorkerState {
    cache: Arc<Mutex<Cache>>, // 回写目标（worker 收尾时短暂锁回写 + 落盘）
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[tauri::command]
fn get_providers() -> Vec<dto::ProviderInfoDto> {
    translate::providers_meta::all_infos()
}

#[tauri::command]
fn get_provider_meta(key: String) -> Option<dto::ProviderInfoDto> {
    translate::providers_meta::info(&key)
}

/// 划词翻译：文本天然短，单发直调 provider（超长选区由前端限制）。
/// 起线程 join 后返回——阻塞网络调用不占用 IPC 线程，划词场景等待可接受。
#[tauri::command]
fn translate_text(
    text: String,
    provider: String,
    creds: HashMap<String, String>,
) -> Result<String, String> {
    if translate::providers_meta::get(&provider).is_none() {
        return Err(format!("未知翻译源：{provider}"));
    }
    std::thread::spawn(move || {
        let http = translate::http::UreqClient;
        translate::providers::provider(&provider, &text, &translate::providers::Creds(creds), &http)
    })
    .join()
    .map_err(|_| "翻译线程崩溃".to_string())
    .and_then(|r| r)
}

/// 停止当前后台批次：worker 里每个 HTTP 请求出发前经 CancelableClient 检查旗标，
/// 置位后未发请求全部 fail-fast、已排队批次在边界处排空。
#[tauri::command]
fn stop_translation(state: tauri::State<AppTxn>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// 整篇文档翻译：即刻返回 gen 号，真正翻译在后台线程；进度/完成经 Event 推送
/// （`translation-progress` / `translation-done`）。忙碌时返回错误。
#[tauri::command]
fn translate_document(
    app: tauri::AppHandle,
    content: String,
    mode: String,
    provider: String,
    creds: HashMap<String, String>,
    state: tauri::State<AppTxn>,
) -> Result<u64, String> {
    let meta = translate::providers_meta::get(&provider)
        .ok_or_else(|| format!("未知翻译源：{provider}"))?;
    let blocks = markdown::parse_blocks(&content);
    let units = match mode.as_str() {
        "translation" => markdown::units::collect_text_runs(&blocks),
        "bilingual" => markdown::units::collect_translatable(&blocks),
        other => return Err(format!("不支持的模式：{other}")),
    };
    // 忙碌检查：CAS false→true 成功才开工；失败即拒绝并保留原任务。
    state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有翻译在进行".to_string())?;
    let r#gen = state.r#gen.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);

    // 缓存只锁拷贝瞬间：快照传给 worker 全程局部使用，结束后 merge 回写。
    let snapshot = state.cache.lock().expect("cache mutex poisoned").clone();
    let st = WorkerState {
        cache: Arc::clone(&state.cache),
        cancel: Arc::clone(&state.cancel),
        running: Arc::clone(&state.running),
    };
    let (indices, texts): (Vec<usize>, Vec<String>) = units.into_iter().unzip();
    let bilingual = mode == "bilingual";
    spawn_translation(app, r#gen, texts, indices, provider, creds, meta, st, snapshot, content, bilingual);
    Ok(r#gen)
}

/// 后台 worker 编排：UreqClient 包 CancelableClient 走 pipeline，progress 闭包
/// emit 进度事件；收尾时 merge 回写缓存并落盘，再 emit 完成事件、释放 running。
/// 事件只在 worker 线程经 AppHandle clone 发出；前端按 gen 丢弃过期事件。
fn spawn_translation(
    app: tauri::AppHandle,
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
        let http0 = translate::http::UreqClient;
        let http = translate::cancel::CancelableClient { inner: &http0, cancel: &st.cancel };

        // 开跑前已在快照中的键无需回写（translate_units 只新增缺失键）
        let preknown: HashSet<String> = texts
            .iter()
            .map(|t| Cache::key(&provider, t))
            .filter(|k| work_cache.get(k).is_some())
            .collect();

        let progress = |done: usize, total: usize| {
            let _ = app.emit("translation-progress", TranslationProgressEvt { r#gen, done, total });
        };
        let results = translate::pipeline::translate_units(
            &texts,
            &provider,
            &translate::providers::Creds(creds),
            meta.max_len,
            meta.max_concurrency,
            &mut work_cache,
            &http,
            &progress,
        );

        // merge 回写：锁内只做内存 set + 快照 JSON，落盘紧随其后（单一写者，
        // 由 running 单飞保护，锁不跨网络请求）。
        {
            let mut shared = st.cache.lock().expect("cache mutex poisoned");
            for (i, r) in results.iter().enumerate() {
                if let Ok(v) = r {
                    let k = Cache::key(&provider, &texts[i]);
                    if !preknown.contains(&k) {
                        shared.set(k, v.clone());
                    }
                }
            }
            let _ = shared.save(&storage::cache_path());
        }

        let (ok, pairs, err) = done_payload_parts(&indices, &results);
        let payload = if ok {
            // 完成（含缓存全命中零网络）：组装三形态 + outline 随事件一并发出。
            // pairs 已按 index 升序，collect 回 HashMap 供 render_html 查表。
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
            // 取消/失败：维持现状（translations 缺席），html/outline 同样缺席，
            // 不阻塞 done 事件本身。
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
        let _ = app.emit("translation-done", payload);
        st.running.store(false, Ordering::SeqCst);
    });
}

fn tree_out(nodes: &[workspace::TreeNode]) -> Vec<dto::TreeNodeDTO> {
    nodes
        .iter()
        .map(|n| dto::TreeNodeDTO {
            name: n.name.clone(),
            path: n.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            is_dir: n.is_dir,
            children: tree_out(&n.children),
        })
        .collect()
}

fn tree_in(nodes: &[dto::TreeNodeDTO]) -> Vec<workspace::TreeNode> {
    nodes
        .iter()
        .map(|n| workspace::TreeNode {
            name: n.name.clone(),
            path: n.path.as_ref().map(std::path::PathBuf::from),
            is_dir: n.is_dir,
            children: tree_in(&n.children),
        })
        .collect()
}

// ---- 单实例 handoff（Task 10）----

/// Wire payload of the `document-changed` event（Task 14 绑定字段名）——单一
/// 来源：pending 轮询与首开参数两条路径都经此构造，serde 形状仅由这里决定，
/// 恰为 `{"path": "<字符串>"}` 单键对象。
fn changed_payload(p: &std::path::Path) -> serde_json::Value {
    serde_json::json!({ "path": p.to_string_lossy() })
}

pub fn run() {
    // CLI 文件参数一次解析两处共用：第二实例转交 / 首开直接加载。
    let file_arg = fileopen::file_arg_from_args(std::env::args().skip(1));
    let lock = single_instance::acquire_lock();
    if lock.is_none() {
        // Second launch: hand a file-association path to the running instance.
        if let Some(p) = file_arg {
            single_instance::write_pending(&p);
        }
        return;
    }
    // 首开带文件参数（文件关联双击）：与 handoff 共用同一事件统一路径加载
    // （替代旧 state.open(args)）。事件无缓冲/重放，且前端监听要等 React 挂载
    // 才注册——若在 setup 直接 emit 必丢。Builder 级 on_page_load 先于任何
    // 窗口注册、必能捕获首次加载完成；Mutex+take 闩保证全程只发一次，延迟
    // 500ms 给前端留出挂监听的时间（Task 15 启动时只挂一次）。
    let initial = Mutex::new(file_arg);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_page_load(move |wv, ev| {
            if !matches!(ev.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            if let Some(p) = initial.lock().expect("initial file mutex poisoned").take() {
                // 延迟发射；detached 线程不阻塞事件循环
                let wv = wv.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = wv.emit("document-changed", changed_payload(&p));
                });
            }
        })
        .manage(AppTxn::new(lock))
        .invoke_handler(tauri::generate_handler![
            open_file,
            save_file,
            load_settings,
            save_settings,
            get_user_data_dir,
            open_workspace,
            filter_workspace,
            create_file,
            create_folder,
            apply_op,
            parse_markdown,
            resolve_image,
            // Task 8: 翻译
            get_providers,
            get_provider_meta,
            translate_text,
            translate_document,
            stop_translation,
            // Task 9: 对话框
            pick_file,
            pick_folder,
            pick_save_path,
            // Task 26: 设置弹窗
            clear_cache,
            // Task 10-11 追加于此
        ])
        .setup(|app| {
            // Task 10: 单实例 handoff——轮询第二实例写入的 pending 文件并转成
            // document-changed 事件推给前端；纯本地小文件 IO，独立线程不占主循环。
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Some(p) = single_instance::take_pending() {
                    let _ = h.emit("document-changed", changed_payload(&p));
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            });
            // Task 29: 启动时按已持久化设置注册全局热键（未聚焦也能换阅读模式）
            hotkeys::sync(app.handle(), &storage::load_settings());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    #[test]
    fn txn_defaults_are_quiescent() {
        let t = AppTxn::default();
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        assert!(!t.cancel.load(Ordering::Relaxed));
        assert!(!t.running.load(Ordering::Relaxed));
        assert!(t.cache.lock().unwrap().is_empty());
        assert!(t.lock_file.lock().unwrap().is_none());
    }

    #[test]
    fn txn_holds_the_single_instance_lock() {
        let dir = std::env::temp_dir().join(format!("qingbird-txn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(dir.join("lock"))
            .unwrap();
        let t = AppTxn::new(Some(f));
        assert!(t.lock_file.lock().unwrap().is_some());
        // generation starts fresh even when a lock is held
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
    }

    // ---- Task 6: 工作区 / 编辑器命令外壳 ----

    // ---- Task 7: 图片解析 / Markdown 解析命令 ----

    #[test]
    fn resolve_skips_remote_and_resolves_relative() {
        assert_eq!(resolve("https://a/b.png", Some("D:/w")), None);
        assert_eq!(resolve("data:image/png;base64,x", None), None);
        assert_eq!(
            resolve("img/logo.png", Some("D:/w")).unwrap().to_string_lossy(),
            "D:/w/img/logo.png"
        );
        assert_eq!(resolve("file://C:/x.png", None).unwrap().to_string_lossy(), "C:/x.png");
        // 平移自旧逻辑的边界：空 src 与纯空白拒绝
        assert_eq!(resolve("", Some("D:/w")), None);
        assert_eq!(resolve("   ", Some("D:/w")), None);
    }

    #[test]
    fn resolve_triple_slash_file_url_is_normalized_to_drive_path() {
        // file:///C:/x.png 三斜杠形式：剥净前导斜杠（否则 /C:/x.png 不是有效本地路径）
        assert_eq!(
            resolve("file:///C:/x.png", None).unwrap().to_string_lossy(),
            "C:/x.png"
        );
        // 四斜杠同样剥净到净路径
        assert_eq!(
            resolve("file:////C:/x.png", None).unwrap().to_string_lossy(),
            "C:/x.png"
        );
    }

    #[test]
    fn apply_op_maps_types() {
        let op = dto::EditOp { content: "hi".into(), sel: [0, 2], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**hi**");
        // 内核契约（editor::wrap）：包裹后选区落在标记内的原文字上
        assert_eq!(r.sel, [2, 4]);
    }

    #[test]
    fn apply_op_cjk_selection_is_snapped_to_char_boundaries() {
        // 每个汉字 3 字节：1/7/99 都不在字符边界上，必须收敛而非 panic
        let op = dto::EditOp { content: "你好".into(), sel: [1, 4], op: "bold".into() };
        let r = apply_op_map(op);
        assert_eq!(r.content, "**你**好");
        assert_eq!(r.sel, [2, 5]);

        // 越界选择 → 钳到末尾空选区，插入占位符并选中它
        let beyond = dto::EditOp { content: "你好".into(), sel: [7, 99], op: "italic".into() };
        let r2 = apply_op_map(beyond);
        assert_eq!(r2.content, "你好*斜体*");
        assert_eq!(r2.sel, [7, 13]);
    }

    #[test]
    fn tree_out_and_back_preserve_structure() {
        let inner = workspace::TreeNode {
            name: "g.md".into(),
            path: Some(PathBuf::from("w/docs/g.md")),
            is_dir: false,
            children: vec![],
        };
        let tree = vec![workspace::TreeNode {
            name: "docs".into(),
            path: Some(PathBuf::from("w/docs")),
            is_dir: true,
            children: vec![inner],
        }];
        let out = tree_out(&tree);
        assert_eq!(out[0].name, "docs");
        assert!(out[0].is_dir);
        assert_eq!(out[0].children[0].name, "g.md");
        assert!(!out[0].children[0].is_dir);
        assert_eq!(out[0].children[0].path.as_deref(), Some("w/docs/g.md"));

        let back = tree_in(&out);
        assert_eq!(back[0].is_dir, true);
        assert_eq!(
            back[0].children[0].path.clone().unwrap(),
            PathBuf::from("w/docs/g.md")
        );
    }

    #[test]
    fn filter_workspace_dto_command_matches_and_keeps_ancestors() {
        let mk_file = |n: &str| dto::TreeNodeDTO {
            name: n.into(),
            path: Some(format!("docs/{n}")),
            is_dir: false,
            children: vec![],
        };
        let tree = vec![dto::TreeNodeDTO {
            name: "docs".into(),
            path: Some("docs".into()),
            is_dir: true,
            children: vec![mk_file("readme.md"), mk_file("api.md")],
        }];

        let hit = filter_workspace(tree.clone(), "api".into());
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].children.len(), 1);
        assert_eq!(hit[0].children[0].name, "api.md");

        let miss = filter_workspace(tree.clone(), "zzz".into());
        assert!(miss.is_empty());

        let all = filter_workspace(tree.clone(), "   ".into()); // 空查询原样返回
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].children.len(), 2);
    }

    // ---- Task 8: 翻译命令 ----

    #[test]
    fn done_payload_parts_sorts_pairs_and_picks_first_error() {
        // 混合成败：只收集成功对，错误取首个；输出按 index 升序
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

        let (_, pairs2, _) = done_payload_parts(&[3usize, 1], &[Ok("乙".into()), Ok("甲".into())]);
        assert_eq!(pairs2, vec![(1usize, "甲".into()), (3usize, "乙".into())]);
    }

    #[test]
    fn translation_done_evt_wire_shape() {
        // Wire contract（Task 14 绑定字段名）：{gen, ok, translations?: [[i, text]], error?}
        // Task 8 扩展：完成路径附带 html 形态 + outline；缺席字段在 JSON 无键。
        // 索引空间现实（task-8ext-report）：translation 批次 map 是
        // collect_text_runs 空间 → 只出 html_translation；bilingual 批次反之
        // → 只出 html_bilingual。原文形态 + outline 恒在。
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
        // run 空间事实（units::collect_runs_inline）：每个 Inline::Text 计一 run，
        // 空格含在 run 内——"Hello " 是完整 run，只有 **/链接 等才切分。
        // "# Ti\n\nHello **world** more" → run0=Ti, run1="Hello ", run2=world,
        // run3=" more"（与 html.rs substituted_keeps_bold_wrapper 测试同构）。
        // translation 批次：substituted 形式可出、bilingual 形式缺席（错配空间
        // 会把 tr-box 放错位）。
        let mut m = HashMap::new();
        m.insert(0usize, "标题".into());
        m.insert(1usize, "你好".into());
        m.insert(2usize, "世界".into());
        m.insert(3usize, "更多".into());
        let (html_original, tr, bi, outline) =
            html_payload_parts("# Ti\n\nHello **world** more", &m, false);
        assert!(html_original.contains(r#"<h1 id="h-1">Ti</h1>"#));
        assert!(html_original.contains("<p>Hello <strong>world</strong> more</p>"));
        let tr = tr.expect("translation batch must carry substituted form");
        assert!(tr.contains(r#"<h1 id="h-1">标题</h1>"#));
        assert!(tr.contains("<p>你好<strong>世界</strong>更多</p>"));
        assert!(bi.is_none());
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].text, "Ti");
        assert_eq!(outline[0].id, "h-1");

        // bilingual 批次：map 是 translatable 块空间（块0=标题、块1=段落），
        // bilingual 形式可出、substituted 缺席；原文形式不受批次模式影响。
        let mut b = HashMap::new();
        b.insert(0usize, "中文标题".into());
        b.insert(1usize, "中文正文".into());
        let (orig2, tr2, bi2, _) = html_payload_parts("# Ti\n\nHello **world** more", &b, true);
        assert!(tr2.is_none());
        let bi2 = bi2.expect("bilingual batch must carry bilingual form");
        assert!(bi2.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(bi2.contains(r#"<div class="tr-box">中文正文</div>"#));
        assert!(orig2.contains("<p>Hello <strong>world</strong> more</p>"));
    }

    #[test]
    fn translation_progress_evt_wire_shape() {
        let e = TranslationProgressEvt { r#gen: 3, done: 2, total: 5 };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 3);
        assert_eq!(v["done"], 2);
        assert_eq!(v["total"], 5);
    }

    // ---- Task 10: 单实例 handoff / 文件关联首开 ----

    #[test]
    fn document_changed_evt_wire_shape() {
        // Wire contract（Task 14 绑定字段名）：listen 后取 e.payload.path，
        // payload 恰为 {"path": "<字符串>"} 单键对象。
        let v = changed_payload(std::path::Path::new(r"D:\docs\hello.md"));
        assert_eq!(v["path"], r"D:\docs\hello.md");
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 1);

        // 非 ASCII 路径原样保留（Windows 双击文件关联常见中文名）
        let cjk = changed_payload(std::path::Path::new(r"C:\笔记\中文.md"));
        assert_eq!(cjk["path"], r"C:\笔记\中文.md");
    }
}
