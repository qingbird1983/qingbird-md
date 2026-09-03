//! 主窗口 WebView 按需休眠（hibernate）。
//!
//! 关窗只 `hide()`（秒回），空闲 [`HIBERNATE_DELAY`] 后与前端握手落草稿，再
//! `destroy()` 把 WebView2 的内存还给系统；任意唤醒路径经 [`ensure_main_window`]
//! 原地复活或冷重建。
//!
//! **前提**：后台能力（托盘 / 全局热键 / 截图 winit 窗口 / 翻译缓存）无一依赖
//! 主窗口 WebView，销毁对它们零影响。改动时别破坏这个性质，否则整套方案失效。
//!
//! 设计要点见 `docs/webview-hibernate-plan.md`。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// 主窗口 label（`tauri.conf.json` 未显式写 label，取 Tauri 默认值 "main"）。
pub const MAIN_LABEL: &str = "main";

/// 关窗后到真正销毁的空闲时长。体感不可接受时单点调大（15–30 分钟）。
pub const HIBERNATE_DELAY: Duration = Duration::from_secs(5 * 60);

/// 实测用的延迟覆盖键：设 `QINGBIRD_HIBERNATE_DELAY_SECS=20` 就能在 20 秒内
/// 走完一遍休眠→唤醒，不必干等 5 分钟。不设或解析失败即回默认。
const DELAY_OVERRIDE_ENV: &str = "QINGBIRD_HIBERNATE_DELAY_SECS";

fn hibernate_delay() -> Duration {
    std::env::var(DELAY_OVERRIDE_ENV)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(HIBERNATE_DELAY)
}

/// 前端握手超时：到点后等这么久没收到 `hibernate_ready` 就强行销毁。
/// 内存释放优先于草稿完整性——绝不因为前端不配合就永远不释放内存。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

/// 计时线程轮询间隔。用轮询而非 `sleep(5min)`：唤醒时必须能立刻取消。
const TICK: Duration = Duration::from_secs(1);

/// 计划休眠时刻；`None` = 无计划。
static HIBERNATE_AT: Mutex<Option<Instant>> = Mutex::new(None);
/// 计时线程存活标记（进程级单例，防重复 spawn）。
static WATCHING: AtomicBool = AtomicBool::new(false);
/// 休眠握手信道：`send(())` == 前端已落完草稿，可以销毁。
static READY_TX: Mutex<Option<Sender<()>>> = Mutex::new(None);
/// 握手窗口内被 [`cancel`] 叫停（用户抢在销毁前唤醒了窗口）。
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// 休眠期间到达的待打开文件（单实例 handoff）。
///
/// `emit` 无缓冲也无重放：窗口不存在时发出去就等于丢。休眠态收到 handoff
/// 文件路径时先存在这里，冷重建后的前端启动阶段用 `take_pending_open` 取走。
static PENDING_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 存入一个待打开路径（休眠态 handoff 用）。
pub fn push_pending_open(path: String) {
    PENDING_OPEN
        .lock()
        .expect("hibernate mutex poisoned")
        .push(path);
}

/// 取走全部待打开路径（前端启动阶段调用；取走即清空，不重复打开）。
pub fn take_pending_open() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPEN.lock().expect("hibernate mutex poisoned"))
}

// ---- 休眠状态机 ----

/// 关窗时调用：从现在起 [`HIBERNATE_DELAY`] 后销毁主窗口。
pub fn schedule(app: &tauri::AppHandle) {
    eprintln!(
        "[hibernate] 关窗：排定 {:.0}s 后销毁 WebView",
        hibernate_delay().as_secs_f64()
    );
    *HIBERNATE_AT.lock().expect("hibernate mutex poisoned") =
        Some(Instant::now() + hibernate_delay());
    CANCELLED.store(false, Ordering::SeqCst);
    start_watcher(app.clone());
}

/// 任一唤醒路径（托盘 / 热键 / 单实例 handoff）调用：取消待卸载计时。
pub fn cancel() {
    let had_pending = HIBERNATE_AT.lock().expect("hibernate mutex poisoned").take().is_some();
    if had_pending {
        eprintln!("[hibernate] 唤醒：取消待卸载计时");
    }
    // 销毁倒计时已启动、前端正在落草稿时用户抢先唤醒 → 让 do_hibernate 放弃销毁。
    CANCELLED.store(true, Ordering::SeqCst);
}

/// 纯函数：给定当前时刻与计划时刻，判断是否到点。
/// 抽成纯函数以便离线断言（`Instant` 本身无法在单测里构造出可比对的未来值）。
pub fn should_hibernate(now: Instant, scheduled_at: Option<Instant>) -> bool {
    matches!(scheduled_at, Some(at) if now >= at)
}

fn start_watcher(app: tauri::AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return; // 已在跑：它每秒重查 HIBERNATE_AT，无需第二个线程
    }
    let spawned = std::thread::Builder::new()
        .name("hibernate-watch".into())
        .spawn(move || loop {
            let due = {
                let at = HIBERNATE_AT.lock().expect("hibernate mutex poisoned");
                should_hibernate(Instant::now(), *at)
            };
            if due {
                *HIBERNATE_AT.lock().expect("hibernate mutex poisoned") = None;
                do_hibernate(&app);
            }
            std::thread::sleep(TICK);
        });
    if let Err(e) = spawned {
        // spawn 失败必须复位标记，否则后续 schedule 再也不会重试
        WATCHING.store(false, Ordering::SeqCst);
        eprintln!("[hibernate] watcher spawn failed: {e}");
    }
}

/// 到点：与前端握手落草稿 → 销毁。
fn do_hibernate(app: &tauri::AppHandle) {
    eprintln!("[hibernate] 到点：发起休眠握手（等前端落草稿 {HANDSHAKE_TIMEOUT:?}）");
    let (tx, rx) = mpsc::channel();
    *READY_TX.lock().expect("hibernate mutex poisoned") = Some(tx);

    // 前端收此事件 → save_session → hibernate_ready（src/lib/session.ts）
    if let Err(e) = app.emit("session-hibernate", ()) {
        eprintln!("[hibernate] emit session-hibernate 失败: {e}");
    }
    match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(()) => {}
        Err(_) => eprintln!("[hibernate] 前端握手超时，强制销毁（草稿可能不完整）"),
    }
    *READY_TX.lock().expect("hibernate mutex poisoned") = None;

    if CANCELLED.load(Ordering::SeqCst) {
        eprintln!("[hibernate] 销毁前检测到唤醒，放弃本次休眠");
        // 前端已经落了草稿，但这次休眠作废了：必须删掉它。否则文件会一直
        // 躺在磁盘上，等下次真正的冷启动时冒出用户早就不用的旧内容。
        if let Err(e) = clear_snapshot() {
            eprintln!("[hibernate] 清理已取消的草稿失败: {e}");
        }
        return;
    }
    match app.get_webview_window(MAIN_LABEL) {
        Some(w) => {
            if let Err(e) = w.destroy() {
                eprintln!("[hibernate] destroy 失败: {e}");
            } else {
                eprintln!("[hibernate] 主窗口已销毁（WebView 内存归还）");
            }
        }
        None => eprintln!("[hibernate] 主窗口已不存在，跳过销毁"),
    }
}

/// 前端落完草稿后调用（唤醒 [`do_hibernate`] 的等待）。
pub fn mark_ready() -> Result<(), String> {
    match READY_TX
        .lock()
        .expect("hibernate mutex poisoned")
        .take()
    {
        Some(tx) => tx.send(()).map_err(|e| format!("休眠握手信道已关闭: {e}")),
        None => Err("当前没有待处理的休眠握手".into()),
    }
}

// ---- 唤醒入口 ----

/// 取主窗口的**唯一入口**：活着就唤醒并取消待卸载计时；已休眠则冷重建。
///
/// 坑 4：所有「把主窗口拉回前台」的调用点都必须收敛到这里，否则休眠后
/// `get_webview_window` 返回 None，唤醒路径静默失效。
///
/// **必须在主线程调用**（托盘菜单/左键事件天然满足；后台线程请用
/// `AppHandle::run_on_main_thread` 包一层）。原因见 `spawn_main_window`。
pub fn ensure_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        cancel(); // 待卸载计时作废：5 分钟内是秒回
        eprintln!("[hibernate] 唤醒：窗口存活，直接显示");
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(w);
    }
    spawn_main_window(app)
}

/// 从 `tauri.conf.json` 的窗口配置冷重建主窗口。
///
/// **必须在主线程调用**：`create_window` 在后台线程下只是把建窗任务异步派发
/// 到事件循环，而紧随其后的 `create_webview` 是同步查窗口表的——此时窗口还没
/// 建出来，直接 `WindowNotFound`。主线程下 `send_user_message` 会同步执行，两步
/// 顺序才有保证。
pub fn spawn_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    cancel();
    // 坑 2：启动标志必须复位。SHOWN 是一次性闩，不清则首帧不 show；SILENT 不清
    //        则重建出来的窗口仍被当作开机自启的静默窗口，同样永远不显示。
    //        症状：进程活着、托盘活着、就是看不到窗。
    crate::reset_startup_flags();

    let conf = app
        .config()
        .app
        .windows
        .iter()
        .find(|c| c.label == MAIN_LABEL)
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;

    let win = tauri::WebviewWindowBuilder::from_config(app, &conf)?.build()?;

    // 坑 3：新窗口是全新对象，CloseRequested 钩子必须重挂，否则第二次关窗
    //       会真的把应用关掉（关窗隐藏行为丢失）。
    crate::hook_main_window_close(&win);
    eprintln!("[hibernate] 主窗口冷重建完成");
    Ok(win)
}

// ---- session 快照（仅休眠时落草稿，恢复成功后即删）----

/// 快照格式版本。结构变更时递增，旧文件直接丢弃走冷启动路径。
pub const SESSION_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionTab {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: String,
    /// `Some` = 未保存内容（草稿）；`None` = 干净，重建时从 path 重读。
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub mtime: Option<i64>,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub view: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub cursor_sel: [u32; 2],
    #[serde(default)]
    pub scroll_top: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionUi {
    #[serde(default)]
    pub show_nav: bool,
    #[serde(default)]
    pub show_outline: bool,
    #[serde(default)]
    pub sidebar_width: f64,
    #[serde(default)]
    pub outline_width: f64,
    #[serde(default)]
    pub split_ratio: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct SessionSnapshot {
    /// 恒为 [`SESSION_VERSION`]；不符即丢弃（不阻塞启动）。
    pub version: u32,
    #[serde(default)]
    pub saved_at: i64,
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub ui: Option<SessionUi>,
}

/// 草稿 tab 数；>0 表示恢复后要提示「已恢复上次未保存的内容」。
///
/// 预留：前端在 JS 侧自行统计（快照已在内存，无需再走 IPC），此处保留为
/// 「脏 tab == content.is_some()」这一契约的 Rust 侧定义与回归断言。
#[allow(dead_code)]
pub fn snapshot_dirty_count(snap: &SessionSnapshot) -> usize {
    snap.tabs.iter().filter(|t| t.content.is_some()).count()
}

pub fn session_path() -> std::path::PathBuf {
    crate::storage::user_data_dir().join("qingbird-session.json")
}

pub fn save_snapshot_to(
    path: &std::path::Path,
    snap: &SessionSnapshot,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(snap).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_snapshot(snap: &SessionSnapshot) -> Result<(), String> {
    save_snapshot_to(&session_path(), snap)
}

/// 读快照：文件不存在 → `Ok(None)`；版本不符 → `Ok(None)`（旧文件作废，不阻塞启动）。
pub fn load_snapshot_from(
    path: &std::path::Path,
) -> Result<Option<SessionSnapshot>, String> {
    let s = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let snap: SessionSnapshot = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if snap.version != SESSION_VERSION {
        eprintln!(
            "[hibernate] 快照版本 {} != {SESSION_VERSION}，丢弃",
            snap.version
        );
        return Ok(None);
    }
    Ok(Some(snap))
}

pub fn load_snapshot() -> Result<Option<SessionSnapshot>, String> {
    load_snapshot_from(&session_path())
}

/// 恢复成功后删除（一次性快照：不在下次冷启动冒出旧内容）。
pub fn clear_snapshot_from(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn clear_snapshot() -> Result<(), String> {
    clear_snapshot_from(&session_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap_with(dirty: bool) -> SessionSnapshot {
        SessionSnapshot {
            version: SESSION_VERSION,
            saved_at: 1,
            tabs: vec![
                SessionTab {
                    id: "a".into(),
                    path: Some("C:/x/a.md".into()),
                    name: "a.md".into(),
                    content: if dirty { Some("# draft".into()) } else { None },
                    mtime: Some(123),
                    encoding: Some("UTF-8".into()),
                    view: "source".into(),
                    mode: "original".into(),
                    cursor_sel: [1, 2],
                    scroll_top: 12.5,
                },
                SessionTab {
                    id: "b".into(),
                    path: None,
                    name: "未命名".into(),
                    content: None,
                    mtime: None,
                    encoding: None,
                    view: "preview".into(),
                    mode: "original".into(),
                    cursor_sel: [0, 0],
                    scroll_top: 0.0,
                },
            ],
            active_id: Some("a".into()),
            workspace_root: None,
            ui: Some(SessionUi {
                show_nav: true,
                show_outline: false,
                sidebar_width: 240.0,
                outline_width: 200.0,
                split_ratio: 0.5,
            }),
        }
    }

    // ---- should_hibernate（纯逻辑，Instant 由调用方给出）----

    #[test]
    fn no_schedule_means_never_hibernate() {
        assert!(!should_hibernate(Instant::now(), None));
    }

    #[test]
    fn past_schedule_hibernates() {
        let at = Instant::now() - Duration::from_secs(1);
        assert!(should_hibernate(Instant::now(), Some(at)));
    }

    #[test]
    fn future_schedule_waits() {
        let at = Instant::now() + Duration::from_secs(3600);
        assert!(!should_hibernate(Instant::now(), Some(at)));
    }

    #[test]
    fn exactly_due_is_due() {
        // 到点即触发（>=）：轮询精度 1s，边界取闭区间避免多等一轮
        let now = Instant::now();
        assert!(should_hibernate(now, Some(now)));
    }

    // ---- 快照 serde 往返 ----

    #[test]
    fn snapshot_roundtrips_with_dirty_and_clean_tabs() {
        let snap = snap_with(true);
        let json = serde_json::to_string(&snap).unwrap();
        let back: SessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, snap);
        assert_eq!(back.tabs[0].content.as_deref(), Some("# draft"));
        assert!(back.tabs[1].content.is_none());
    }

    #[test]
    fn dirty_count_counts_only_draft_tabs() {
        assert_eq!(snapshot_dirty_count(&snap_with(false)), 0);
        assert_eq!(snapshot_dirty_count(&snap_with(true)), 1);
    }

    #[test]
    fn snapshot_json_uses_snake_case_wire_names() {
        // 前端 collectSnapshot 产出同名键；字段名一旦改名，这里先炸
        let v: serde_json::Value = serde_json::to_value(snap_with(true)).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v["tabs"][0].get("cursor_sel").is_some());
        assert!(v["tabs"][0].get("scroll_top").is_some());
        assert!(v["ui"].get("sidebar_width").is_some());
        assert!(v.get("workspace_root").is_some());
    }

    #[test]
    fn snapshot_tolerates_missing_optional_fields() {
        // 老/残缺快照：缺字段走 default，不得整体解析失败
        let v: SessionSnapshot =
            serde_json::from_str(r#"{"version":1,"tabs":[{"id":"a"}]}"#).unwrap();
        assert_eq!(v.tabs.len(), 1);
        assert!(v.tabs[0].path.is_none());
        assert!(v.tabs[0].content.is_none());
        assert_eq!(v.tabs[0].cursor_sel, [0, 0]);
        assert!(v.ui.is_none());
    }

    // ---- 草稿文件 IO ----

    #[test]
    fn save_and_load_roundtrip_via_disk() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let p = std::env::temp_dir()
            .join(format!("qingbird-session-{unique}"))
            .join("qingbird-session.json");
        save_snapshot_to(&p, &snap_with(true)).unwrap();
        let got = load_snapshot_from(&p).unwrap().expect("应能读回快照");
        assert_eq!(got, snap_with(true));
        clear_snapshot_from(&p).unwrap();
        assert!(!p.exists());
        // 删除后再读：文件不存在 = 没有快照，不是错误
        assert!(load_snapshot_from(&p).unwrap().is_none());
    }

    #[test]
    fn stale_version_snapshot_is_discarded() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let p = std::env::temp_dir().join(format!("qingbird-session-old-{unique}.json"));
        let mut snap = snap_with(true);
        snap.version = 99;
        save_snapshot_to(&p, &snap).unwrap();
        assert!(
            load_snapshot_from(&p).unwrap().is_none(),
            "版本不符必须丢弃，绝不阻塞启动"
        );
    }

    #[test]
    fn missing_file_is_none_not_error() {
        let p = std::env::temp_dir().join(format!(
            "qingbird-session-absent-{}.json",
            std::process::id()
        ));
        assert!(!p.exists());
        assert!(load_snapshot_from(&p).unwrap().is_none());
    }

    #[test]
    fn session_path_sits_next_to_settings() {
        // 与 settings/cache 同目录，路径构造口径必须一致（user_data_dir）
        let s = session_path();
        assert_eq!(s.file_name().unwrap(), "qingbird-session.json");
        assert_eq!(s.parent(), crate::storage::settings_path().parent());
    }
}
