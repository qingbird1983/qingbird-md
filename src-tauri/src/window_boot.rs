//! 窗口与启动装配（P2-7d 自 lib.rs 平移）：显示闩/静默/首开参数三标志、
//! boot 握手命令、关窗隐藏钩子、`document-changed` wire 载荷，以及
//! Builder 装配 `run()`——时序逐行保持。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::commands;
use crate::AppTxn;
use crate::{bridge, capture, fileopen, hibernate, hotkeys, single_instance, storage, tray};

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
pub(crate) fn reset_startup_flags() {
    *SHOWN.lock().unwrap_or_else(|e| e.into_inner()) = false;
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
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
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
pub(crate) fn hook_main_window_close(win: &tauri::WebviewWindow) {
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
            if let Some(p) = initial.lock().unwrap_or_else(|e| e.into_inner()).take() {
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
            commands::file::open_file,
            commands::file::save_file,
            commands::file::file_mtime,
            commands::settings::load_settings,
            commands::settings::save_settings,
            commands::settings::get_user_data_dir,
            commands::settings::get_data_dir_label,
            // Task 10: 设置面板「开机自启」开关（与托盘同名项同口径，见 commands/settings.rs）
            commands::settings::set_autostart,
            commands::workspace_ops::open_workspace,
            commands::workspace_ops::filter_workspace,
            commands::workspace_ops::create_file,
            commands::workspace_ops::create_folder,
            // 树右键菜单（2026-09-12）：重命名/删除(回收站)/定位/终端/移动/模板
            commands::workspace_ops::rename_path,
            commands::workspace_ops::delete_path,
            commands::workspace_ops::reveal_path,
            commands::workspace_ops::open_terminal,
            commands::workspace_ops::move_path,
            commands::workspace_ops::create_from_template,
            commands::file::apply_op,
            commands::file::parse_markdown,
            commands::file::resolve_image,
            // T25: 预览链接外部打开（系统浏览器）
            commands::dialogs::open_external,
            // Task 8: 翻译（编排与事件见 bridge.rs）
            bridge::get_providers,
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
            // S5 #17-20: AI 语义核查（锁 llm、不进 Cache，进度走 review-progress）。
            bridge::review_semantic,
            // Task 9: 对话框
            commands::dialogs::pick_file,
            commands::dialogs::pick_folder,
            commands::dialogs::pick_save_path,
            // Task 26: 设置弹窗
            commands::settings::clear_cache,
            // 休眠会话快照（Task: webview hibernate）
            commands::settings::save_session,
            commands::settings::hibernate_ready,
            commands::settings::load_session,
            commands::settings::clear_session,
            commands::settings::take_pending_open,
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
