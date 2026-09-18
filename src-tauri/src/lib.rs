//! Tauri entry point: managed app state (`AppTxn`) + the first IPC commands
//! (file read/write, settings read/write). Workspace/editor commands land in
//! Task 6, dialogs Task 9, translation Task 8 — appended to `generate_handler!`.

mod bridge;
mod capture;
mod dto;
mod editor;
mod fileopen;
mod hibernate;
mod hotkeys;
mod markdown;
mod single_instance;
mod storage;
mod tray;
mod translate;
mod trim;
mod workspace;

use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, FilePath};

use translate::cache::Cache;

/// Managed shared state, registered via `.manage(AppTxn::new(lock))`.
///
/// `lock_file` 仅做 RAII 持有：acquire_lock 返回的 File 留在字段里活到进程
/// 退出（释放即丢单实例锁），构造后无路径再读它。Mutex 是过度封装。
pub struct AppTxn {
    /// 翻译缓存共享。Arc 包一层：Task 8 后台 worker 克隆 Arc 出去，收尾时
    /// 短暂锁回写新键并落盘——绝不跨网络请求持锁。
    pub(crate) cache: Arc<Mutex<Cache>>,
    pub(crate) cancel: Arc<AtomicBool>, // 当前批次取消旗标
    pub(crate) running: Arc<AtomicBool>,
    /// 代次：新一轮翻译 +1；事件里带上，前端丢弃过期。
    /// Rust 2024 保留字，raw identifier（序列化不涉及，仅内部状态）。
    pub(crate) r#gen: AtomicU64,
    // 仅做 RAII 持有（单实例锁活到进程退出），构造后无路径再读它。
    #[allow(dead_code)]
    lock_file: Option<File>,
}

impl AppTxn {
    pub(crate) fn new(lock: Option<File>) -> Self {
        // 启动时接续上次落盘的翻译记忆（save 在 worker 收尾/clear_cache 时写回）。
        Self {
            cache: Arc::new(Mutex::new(Cache::load(&storage::cache_path()))),
            cancel: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            r#gen: AtomicU64::new(0),
            lock_file: lock,
        }
    }
}

// ---- 文件 ----

/// 解码文件字节：严格 UTF-8 优先，失败回退 GB18030（GBK 超集，中文场景兜底）。
/// 返回 (内容, 编码标注)。非中文二进制误判会得到 U+FFFD 替换字符，可接受。
pub fn decode_bytes(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), "UTF-8"),
        Err(_) => {
            let (text, _, _) = encoding_rs::GB18030.decode(bytes);
            (text.into_owned(), "GB18030")
        }
    }
}

/// 打开文档：读取 + doc_dto 内完成首次 markdown 渲染（parse 随文档一趟下发）。
/// async 命令：render_html 是 CPU 密集操作（大文档 release 下可达百 ms 级），
/// 必须离开主线程，否则解析期间整个窗口冻结（同 T9 pick_* 先例）。
///
/// `target_lang` 是当前翻译方向（`"zh"` / `"en"`，未知值回落 zh）：首渲的
/// `data-bi` 占号由它决定，必须与随后 `translate_document` 的入参一致。
#[tauri::command]
async fn open_file(path: String, target_lang: String) -> Result<dto::DocDTO, String> {
    let p = std::path::PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_bytes(&bytes);
    let target = translate::engine::TargetLang::from_tag(&target_lang);
    Ok(dto::doc_dto(&p, content, encoding, target))
}

/// 保存文档；返回写盘后的 mtime（毫秒），前端记为新的外部修改检测基线。
#[tauri::command]
fn save_file(path: String, content: String) -> Result<Option<i64>, String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(dto::file_mtime_millis(std::path::Path::new(&path)))
}

/// 查询当前磁盘 mtime（毫秒）：窗口聚焦时的外部修改检测、保存前的冲突检测。
/// 文件不存在/不可访问返回 None。
#[tauri::command]
fn file_mtime(path: String) -> Option<i64> {
    dto::file_mtime_millis(std::path::Path::new(&path))
}

// ---- 链接外部打开（T25：点 Markdown 链接整窗导航的修复）----

/// URL 是否可用系统默认方式打开。白名单 http/https/mailto/tel——一切其它
/// scheme（`javascript:`、`data:`、`vbscript:`、相对路径等）都返回 false：
/// WebView 永不执行或导航到它们。
pub(crate) fn is_openable_url(url: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel")
}

/// 用系统默认浏览器/程序打开外部链接。前端点击 Markdown 链接会走这里；
/// scheme 白名单在 Rust 侧再兜一道，防止 `javascript:` 之类经任何路径执行。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err(format!("blocked url: {url}"));
    }
    open::that_detached(&url).map_err(|e| e.to_string())
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

/// 数据目录的**显示**形态（`%APPDATA%\qingbird-md`）——给界面文案用。
/// 与 `get_user_data_dir` 分开是有意的：那个返回的是可执行的真路径
/// （`reveal_path` 直接吃它），这个只给人看。
#[tauri::command]
fn get_data_dir_label() -> String {
    storage::user_data_dir_label()
}

/// 清空翻译缓存并立即落盘（Task 26 设置弹窗「清除翻译缓存」）。
/// 单锁持有：clear 与 save 一起，绝不跨任何长操作持有。
/// save 失败向调用方报错——吞掉会让内存清空而磁盘残留，下次启动复活旧缓存。
#[tauri::command]
fn clear_cache(st: tauri::State<AppTxn>) -> Result<(), String> {
    let mut c = st.cache.lock().expect("cache mutex poisoned");
    c.clear();
    c.save(&storage::cache_path()).map_err(|e| e.to_string())
}

// ---- 休眠会话快照（docs/webview-hibernate-plan.md 步骤 5）----
// 只在休眠握手期间由前端调用。批次顺序：save_session → hibernate_ready。

/// 落草稿快照。内容是「脏 tab 的 content + 干净 tab 的 path」，见 hibernate 模块。
#[tauri::command]
fn save_session(snapshot: hibernate::SessionSnapshot) -> Result<(), String> {
    hibernate::save_snapshot(&snapshot)
}

/// 前端落完草稿的通知：唤醒 `do_hibernate` 的 recv_timeout，随即销毁 WebView。
#[tauri::command]
fn hibernate_ready() -> Result<(), String> {
    hibernate::mark_ready()
}

/// 冷启动 / 冷重建时读取上次休眠留下的快照；无快照或版本不符为 `None`。
#[tauri::command]
fn load_session() -> Result<Option<hibernate::SessionSnapshot>, String> {
    hibernate::load_snapshot()
}

/// 恢复成功后删除快照（一次性：不在下次冷启动冒出旧内容）。
#[tauri::command]
fn clear_session() -> Result<(), String> {
    hibernate::clear_snapshot()
}

/// 取走休眠期间积攒的待打开路径（单实例 handoff 在休眠态的补偿）。
///
/// 调用本身即「前端已就绪」的信号：此后 handoff 可以直接 emit，不必再缓冲。
#[tauri::command]
fn take_pending_open() -> Vec<String> {
    hibernate::mark_frontend_ready();
    hibernate::take_pending_open()
}

// ---- 工作区 ----

/// Walk a workspace folder into the frontend file tree (`.md`/`.markdown`
/// `.txt` only; dotfiles and vendored/build dirs skipped by `workspace::walk`).
#[tauri::command]
fn open_workspace(path: String) -> Vec<dto::TreeNodeDTO> {
    workspace::walk(std::path::Path::new(&path))
}

/// Filter a client-held tree by filename query.
#[tauri::command]
fn filter_workspace(tree: Vec<dto::TreeNodeDTO>, query: String) -> Vec<dto::TreeNodeDTO> {
    workspace::filter(&tree, &query)
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

/// 同目录重命名，返回新的完整路径（前端据此更新标签/树）。
#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let target = workspace::renamed_path(&path, &new_name)?;
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("原路径不存在".into());
    }
    if target != path && std::path::Path::new(&target).exists() {
        return Err("已存在同名文件或文件夹".into());
    }
    std::fs::rename(&path, &target).map_err(|e| format!("重命名失败 {path}: {e}"))?;
    Ok(target)
}

/// 删除文件/文件夹（Windows 走回收站，可撤销）。
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(windows)]
    {
        delete_to_trash(&path)
    }
    #[cfg(not(windows))]
    {
        Err("当前平台不支持删除到回收站".into())
    }
}

/// Windows：SHFileOperationW + FOF_ALLOWUNDO = 删除到回收站（无二次确认弹窗）。
#[cfg(windows)]
fn delete_to_trash(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        SHFileOperationW, SHFILEOPSTRUCTW,
    };

    // pFrom 是需要双 NUL 结尾的宽字符列表（支持一次多项）。
    let mut from: Vec<u16> = std::ffi::OsStr::new(path).encode_wide().collect();
    from.push(0);
    from.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE as u32,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("删除失败（系统错误 {rc}）"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("删除已取消".into());
    }
    Ok(())
}

/// 在资源管理器中定位：文件选中该文件，目录直接打开。
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("路径不存在".into());
    }
    let mut cmd = std::process::Command::new("explorer");
    if p.is_dir() {
        cmd.arg(&path);
    } else {
        // explorer 需要 /select,"路径" 一整枚参数（路径含空格时手动补引号）
        cmd.arg(format!("/select,\"{path}\""));
    }
    cmd.spawn().map_err(|e| format!("打开资源管理器失败：{e}"))?;
    Ok(())
}

/// 在该路径所在目录打开系统终端（cmd，新窗口继承该工作目录）。
#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().map(|d| d.to_path_buf()).ok_or_else(|| "无法定位目录".to_string())? };
    if !dir.exists() {
        return Err("目录不存在".into());
    }
    std::process::Command::new("cmd")
        .current_dir(&dir)
        .args(["/c", "start", "", "cmd"])
        .spawn()
        .map_err(|e| format!("打开终端失败：{e}"))?;
    Ok(())
}

/// 移动文件/目录到目标目录（同名冲突拒绝覆盖），返回新路径。
#[tauri::command]
fn move_path(path: String, dest_dir: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("原路径不存在".into());
    }
    let dest = std::path::Path::new(&dest_dir);
    if !dest.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let target = workspace::moved_path(&path, &dest_dir)?;
    if std::path::Path::new(&target).exists() {
        return Err("目标目录已存在同名项".into());
    }
    match std::fs::rename(&path, &target) {
        Ok(()) => Ok(target),
        Err(e) => {
            // 跨卷 rename 失败：文件退化为复制 + 删除源
            if src.is_file() {
                std::fs::copy(src, &target).map_err(|e2| format!("移动失败：{e2}"))?;
                std::fs::remove_file(src).map_err(|e2| format!("移动失败：{e2}"))?;
                Ok(target)
            } else {
                Err(format!("移动失败：{e}"))
            }
        }
    }
}

/// 从模板新建文档（模板正文见 workspace::template_body），返回新文件路径。
#[tauri::command]
fn create_from_template(dir: String, name: String, kind: String) -> Result<String, String> {
    let clean = name.trim();
    workspace::validate_name(clean)?;
    let file_name = if clean.to_lowercase().ends_with(".md") { clean.to_string() } else { format!("{clean}.md") };
    let target = std::path::Path::new(&dir).join(&file_name);
    let body = workspace::template_body(&kind);
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(body.as_bytes()).map_err(|e| format!("写入模板失败：{e}"))?;
            Ok(target.to_string_lossy().into_owned())
        }
        Err(e) => Err(create_err("新建文件失败", &target.to_string_lossy(), e)),
    }
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

/// 编辑期重新渲染（open_file 已随文档首渲，此处只服务内容变化后的重解析）。
/// async：同 open_file，解析离开主线程。
///
/// `target_lang` 同 `open_file`：`data-bi` 占号随方向变，前端切方向后必须
/// 用新方向重解析，否则预览 DOM 的块编号与本轮翻译的索引空间对不上。
#[tauri::command]
async fn parse_markdown(content: String, target_lang: String) -> markdown::html::ParseResult {
    markdown::html::render_html(
        &content,
        &std::collections::HashMap::new(),
        false,
        translate::engine::TargetLang::from_tag(&target_lang),
    )
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

/// 首帧就绪后显示主窗口的一次性闩（`visible:false` 配置的补偿）。
///
/// 放在模块级而非 `run()` 局部变量：`spawn_main_window` 冷重建窗口时必须能复位
/// 它，否则第二个窗口永远不 show（坑 2）。
static SHOWN: Mutex<bool> = Mutex::new(false);

/// 静默启动（`--minimized`）标志。
///
/// 同样必须是模块级可复位的：它只该约束「开机自启时那个没人看过的窗口」，
/// 冷重建的窗口是用户主动唤醒的，必须显示。否则开机自启后从托盘唤醒，
/// 重建出来的窗口会被 on_page_load 继续当静默处理，永远不显示。
static SILENT: AtomicBool = AtomicBool::new(false);

/// 本次启动是否带首开文件参数（文件关联双击）。
///
/// 前端启动动画只在「最终落在欢迎页」时演；文件参数走的是页面加载后
/// 500ms 的 `document-changed` 发射（见 on_page_load），前端无法从
/// take_pending_open 得知它的存在，只能由本标志经 `boot_info` 查询。
/// 冷重建由 reset_startup_flags 复位（重建出来的会话不带首开参数）。
static INITIAL_FILE_PENDING: AtomicBool = AtomicBool::new(false);

/// 冷重建窗口前的标志复位（显示闩 + 静默标志 + 首开参数标志），见各处注释。
fn reset_startup_flags() {
    *SHOWN.lock().expect("shown mutex poisoned") = false;
    SILENT.store(false, Ordering::SeqCst);
    INITIAL_FILE_PENDING.store(false, Ordering::SeqCst);
}

/// 看门狗兜底时长：前端启动序列（快照恢复 + 多个文件 IO）正常 <1s，
/// 超时仍未调 boot_ready 就强制显示，宁可放弃动画也不能让窗口永不出现。
const BOOT_SHOW_WATCHDOG_MS: u64 = 3000;

/// 显示主窗口（一次性）：非静默且尚未显示时 show + focus，返回是否本次完成。
///
/// 两个调用方共用同一把闩：前端首帧摆好起始态后经 `boot_ready` 通知显示；
/// on_page_load 派生的看门狗超时后兜底显示（前端卡死/IPC 失败时不能永不出现）。
fn show_main_window(app: &tauri::AppHandle) -> bool {
    if SILENT.load(Ordering::SeqCst) {
        return false;
    }
    let mut shown = SHOWN.lock().expect("shown mutex poisoned");
    if *shown {
        return false;
    }
    *shown = true;
    if let Some(w) = app.get_webview_window(hibernate::MAIN_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    true
}

/// `boot_info` 命令的返回：前端据此决定启动动画该不该演。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootInfo {
    /// 静默启动（驻留托盘）：窗口本次根本不显示，动画无观众，不演。
    silent: bool,
    /// 本次带首开文件参数：500ms 后会有文档打开，欢迎页留不住，不演。
    has_file_arg: bool,
}

#[tauri::command]
fn boot_info() -> BootInfo {
    BootInfo {
        silent: SILENT.load(Ordering::SeqCst),
        has_file_arg: INITIAL_FILE_PENDING.load(Ordering::SeqCst),
    }
}

/// 前端首帧起始态已上屏：放行窗口显示。返回 false 表示窗口此前已显示
/// （看门狗抢先）或本次为静默启动——前端据此放弃启动动画、直接落终态，
/// 避免「用户先看到一帧中间态再缩回」的穿帮。
#[tauri::command]
fn boot_ready(app: tauri::AppHandle) -> bool {
    show_main_window(&app)
}

/// 挂主窗口的「关闭=隐藏 + 排定休眠」钩子。
///
/// 抽成函数是因为它有第二个调用点：休眠后冷重建的窗口是全新对象，`setup` 里
/// 挂的那份钩子不会跟着过去，必须重挂，否则第二次关窗会真的退出应用（坑 3）。
fn hook_main_window_close(win: &tauri::WebviewWindow) {
    let h = win.app_handle().clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // 关闭=隐藏到托盘（spec §5）；真退出走托盘菜单「退出」。
            // 排定 5 分钟后真正销毁 WebView（hibernate L1）。
            api.prevent_close();
            if let Some(w) = h.get_webview_window(hibernate::MAIN_LABEL) {
                let _ = w.hide();
            }
            eprintln!("[wb] 窗口关闭请求已拦下（隐藏 + 排定休眠）");
            hibernate::schedule(&h);
        }
    });
}

// ---- 单实例 handoff（Task 10）----

/// Wire payload of the `document-changed` event（Task 14 绑定字段名）——单一
/// 来源：pending 轮询与首开参数两条路径都经此构造，serde 形状仅由这里决定，
/// 恰为 `{"path": "<字符串>"}` 单键对象。
fn changed_payload(p: &std::path::Path) -> serde_json::Value {
    serde_json::json!({ "path": p.to_string_lossy() })
}

pub fn run() {
    // 页面还在加载：这条进程生命周期里的第一批 handoff 先缓冲，等前端
    // take_pending_open 时再放行（10s 兜底见 hibernate::reset_frontend_ready）。
    hibernate::reset_frontend_ready();
    // 静默启动判定（--minimized，开机自启驻留托盘）：true 则 on_page_load 永不 show。
    let silent = capture::startup_arg::is_silent_launch(std::env::args());
    SILENT.store(silent, Ordering::SeqCst);
    // CLI 文件参数一次解析两处共用：第二实例转交 / 首开直接加载。
    let file_arg = fileopen::file_arg_from_args(std::env::args().skip(1));
    // 供前端 boot_info 查询：带文件参数启动时欢迎页留不住，不演启动动画。
    INITIAL_FILE_PENDING.store(file_arg.is_some(), Ordering::SeqCst);
    let lock = single_instance::acquire_lock();
    if lock.is_none() {
        // Second launch: hand a file-association path to the running instance.
        if let Some(p) = file_arg {
            single_instance::write_pending(&p);
        } else {
            // 无文件参数：仅唤醒驻留托盘的首实例主窗口
            single_instance::write_show_wake();
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![capture::startup_arg::SILENT_START_ARG]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_page_load(move |wv, ev| {
            if !matches!(ev.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            // 窗口显示改由前端握手指令驱动（boot_ready）：前端要先把
            // 启动动画起始态（两栏展开到最宽）画上屏再放行 show，否则用户会
            // 先看到默认态再跳到起始态。这里只留看门狗兜底：前端卡死/IPC
            // 失败时超时强制显示，窗口不能永不出现。冷重建后 on_page_load
            // 会再触发一次，SHOWN 闩保证看门狗与握手两条路径只 show 一次。
            {
                let h = wv.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(
                        BOOT_SHOW_WATCHDOG_MS,
                    ));
                    show_main_window(&h);
                });
            }
            if let Some(p) = initial.lock().expect("initial file mutex poisoned").take() {
                // 延迟发射；detached 线程不阻塞事件循环（现有逻辑原样）
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
            file_mtime,
            load_settings,
            save_settings,
            get_user_data_dir,
            get_data_dir_label,
            open_workspace,
            filter_workspace,
            create_file,
            create_folder,
            // 树右键菜单（2026-09-12）：重命名/删除(回收站)/定位/终端/移动/模板
            rename_path,
            delete_path,
            reveal_path,
            open_terminal,
            move_path,
            create_from_template,
            apply_op,
            parse_markdown,
            resolve_image,
            // T25: 预览链接外部打开（系统浏览器）
            open_external,
            // Task 8: 翻译（编排与事件见 bridge.rs）
            bridge::get_providers,
            bridge::get_provider_meta,
            bridge::translate_text,
            // 选区查词（2026-08-29 spec）
            bridge::lookup_word,
            bridge::llm_list_models,
            bridge::translate_document,
            bridge::stop_translation,
            // Task 5: 会话收口重建（用前端累积 translations 渲染整树 canonical html）
            bridge::render_translated,
            // Step 2: 译文另存为（translations → Markdown 文本；落盘走
            // pick_save_path + save_file，与「导出 HTML」同一套路，零新 IO 命令）
            bridge::export_translation,
            // Step 3 #15: 确定性检查（漏译 / 标记丢失 / 结构不对等 / 代码被侵入）。
            bridge::check_translation,
            // Task 9: 对话框
            pick_file,
            pick_folder,
            pick_save_path,
            // Task 26: 设置弹窗
            clear_cache,
            // 休眠会话快照（Task: webview hibernate）
            save_session,
            hibernate_ready,
            load_session,
            clear_session,
            take_pending_open,
            // 启动动画握手（前端摆好首帧起始态后通知显示窗口）
            boot_info,
            boot_ready,
            // Task 10-11 追加于此
        ])
        .setup(move |app| {
            // L0 静默启动（开机自启 `--minimized`）：不在内存里养一个从没显示过
            // 的 WebView。setup 运行在窗口创建之后，此处同步 destroy 是安全的；
            // destroy 会触发 ExitRequested(code=None)，由 run() 回调 prevent_exit 兜住。
            if silent {
                if let Some(w) = app.get_webview_window(hibernate::MAIN_LABEL) {
                    let _ = w.destroy();
                }
            }
            // Task 10: 单实例 handoff——轮询第二实例写入的 pending 文件并转成
            // document-changed 事件推给前端；纯本地小文件 IO，独立线程不占主循环。
            let h = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Some(p) = single_instance::take_pending() {
                    // 单实例 handoff："show" 哨兵=仅唤醒窗口（不发事件）；文件
                    // 路径=先派发 document-changed，再把主窗口从最小化/后台拉回
                    // 前台（静默驻留被第二实例唤醒时窗口弹出）。
                    if !single_instance::is_show_wake(&p) {
                        if hibernate::can_emit_document(&h) {
                            let _ = h.emit("document-changed", changed_payload(&p));
                        } else {
                            // 两类「发出去就等于丢」的窗口期，一律缓冲：
                            // 1. 已休眠——根本没有 WebView 能接收（无缓冲/重放）；
                            // 2. 刚冷重建——窗口对象已有，但页面在加载、前端的
                            //    document-changed 监听还没挂上。
                            // 存下来等前端启动阶段用 take_pending_open 取走。
                            hibernate::push_pending_open(p.to_string_lossy().into_owned());
                        }
                    }
                    // 唤醒唯一入口：活着就拉回前台，已休眠就冷重建（坑 4）。
                    // 必须回主线程：本循环跑在后台线程，而冷重建是
                    // create_window（后台线程下只异步派发到事件循环）+ 紧随其
                    // 后的 create_webview（同步查窗口表）两步，后台线程下第二步
                    // 会查不到刚派发的窗口而报 WindowNotFound。
                    let h2 = h.clone();
                    if let Err(e) = h.run_on_main_thread(move || {
                        if let Err(e) = hibernate::ensure_main_window(&h2) {
                            eprintln!("wake main window: {e}");
                        }
                    }) {
                        eprintln!("run_on_main_thread: {e}");
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            });
            // Task 29: 启动时按已持久化设置注册全局热键（未聚焦也能换阅读模式）
            hotkeys::sync(app.handle(), &storage::load_settings());
            // 托盘 + 自启状态同步 + 关窗隐藏
            tray::setup(app)?;
            let s = storage::load_settings();
            if s.autostart {
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("apply autostart: {e}");
                }
            }
            if let Some(main) = app.get_webview_window(hibernate::MAIN_LABEL) {
                hook_main_window_close(&main);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // code = None  → 最后一个窗口被销毁（关窗隐藏 / hibernate 销毁），
                //                我们要继续驻留托盘，必须拦下；
                // code = Some  → 程序调用 app.exit()（托盘「退出」，必须放行）。
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn txn_new_is_quiescent_when_no_lock() {
        let t = AppTxn::new(None);
        assert_eq!(t.r#gen.load(Ordering::Relaxed), 0);
        assert!(!t.cancel.load(Ordering::Relaxed));
        assert!(!t.running.load(Ordering::Relaxed));
        assert!(t.lock_file.is_none());
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
        assert!(t.lock_file.is_some());
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

    // ---- T7: 编码兜底 / T6+T8: mtime 基线 ----

    #[test]
    fn decode_utf8_is_passthrough() {
        let (text, enc) = decode_bytes("中文\n# ok".as_bytes());
        assert_eq!(text, "中文\n# ok");
        assert_eq!(enc, "UTF-8");
    }

    #[test]
    fn decode_gbk_falls_back_to_gb18030() {
        // "中文ab" 的 GBK 编码字节（D6 D0 CE C4 61 62）不是合法 UTF-8
        let bytes: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4, b'a', b'b'];
        let (text, enc) = decode_bytes(bytes);
        assert_eq!(text, "中文ab");
        assert_eq!(enc, "GB18030");
    }

    #[test]
    fn decode_garbage_still_labels_gb18030_with_replacement() {
        let (text, enc) = decode_bytes(&[0xFF, 0xFE, 0x61]);
        assert_eq!(enc, "GB18030");
        assert!(text.contains('\u{FFFD}')); // 替换字符而非 panic/丢内容
    }

    #[test]
    fn file_mtime_millis_tracks_write() {
        let dir = std::env::temp_dir().join(format!("qingbird-mtime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.md");
        assert_eq!(dto::file_mtime_millis(&p), None); // 不存在 → None
        std::fs::write(&p, "x").unwrap();
        let m = dto::file_mtime_millis(&p).unwrap();
        assert!(m > 0);
        std::fs::remove_file(&p).ok();
    }

    // ---- T25: 预览链接外部打开（点链接不得整窗导航）----

    #[test]
    fn openable_url_whitelists_http_mailto_tel() {
        assert!(is_openable_url("https://gitee.com/muyan1983/qingbird-md"));
        assert!(is_openable_url("http://a.b/c?x=1#y"));
        assert!(is_openable_url("mailto:a@b.c"));
        assert!(is_openable_url("tel:+8613800000000"));
    }

    #[test]
    fn openable_url_rejects_dangerous_or_relative() {
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("data:text/html,<b>x</b>"));
        assert!(!is_openable_url("vbscript:msgbox(1)"));
        assert!(!is_openable_url("docs/a.md")); // 相对路径：无 base 无法 parse
        assert!(!is_openable_url(""));
        assert!(!is_openable_url("   "));
    }
}
