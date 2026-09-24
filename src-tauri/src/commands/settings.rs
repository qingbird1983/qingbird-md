//! 设置 / 缓存 / 会话转发布：设置读写（落盘后广播脱敏摘要 + 同步热键）、
//! 数据目录查询、翻译缓存清空、休眠会话快照握手与待打开路径取走。

use tauri::{AppHandle, Emitter};

use crate::AppTxn;
use crate::{hibernate, hotkeys, storage};

// ---- 设置 ----

#[tauri::command]
pub fn load_settings() -> storage::Settings {
    storage::load_settings()
}

/// 保存设置到用户数据目录，成功后向全部窗口广播 `settings-updated`。
/// payload 是**脱敏摘要**（只含 theme/palette，见 storage::settings_broadcast_payload）
/// ——SEC-3：整份 Settings 带明文 api_key，不再整包广播；前端唯一消费方
/// useSettingsStore.applyRemote 只读这两项（已逐一核对），需要全量设置走
/// load_settings IPC 按需拉取。
/// 先持久化、后广播：磁盘写入失败直接返回 Err 且不发事件。
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: storage::Settings) -> Result<(), String> {
    storage::save_settings(&settings)?;
    // T29：设置落盘后同步全局热键（unregister_all + 按新值重注册）。
    // 同步命令跑在主线程，满足 RegisterHotKey 的线程约束。
    hotkeys::sync(&app, &settings);
    app.emit("settings-updated", storage::settings_broadcast_payload(&settings))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_user_data_dir() -> String {
    storage::user_data_dir().to_string_lossy().into_owned()
}

/// 设置面板「开机自启」开关：apply 到 autostart 插件 + 落盘（插件为即时权威，
/// settings.autostart 为持久化权威——与 tray.rs::toggle_autostart 同口径，
/// 只是触发方从托盘菜单换成前端）。
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enabled {
        al.enable()
    } else {
        al.disable()
    }
    .map_err(|e| e.to_string())?;
    let mut s = storage::load_settings();
    s.autostart = enabled;
    storage::save_settings(&s)
}

/// 数据目录的**显示**形态（`%APPDATA%\qingbird-md`）——给界面文案用。
/// 与 `get_user_data_dir` 分开是有意的：那个返回的是可执行的真路径
/// （`reveal_path` 直接吃它），这个只给人看。
#[tauri::command]
pub fn get_data_dir_label() -> String {
    storage::user_data_dir_label()
}

/// 清空翻译缓存（Task 26 设置弹窗「清除翻译缓存」）。
/// SqliteCache 的 clear 直接 `DELETE FROM translation_cache` 落盘，无二次 save。
/// 失败向调用方报错——吞掉会让内存清空而磁盘残留，下次启动复活旧缓存。
#[tauri::command]
pub fn clear_cache(st: tauri::State<AppTxn>) -> Result<(), String> {
    let mut c = st.cache.lock().unwrap_or_else(|e| e.into_inner());
    c.clear().map_err(|e| e.to_string())
}

// ---- 休眠会话快照（docs/webview-hibernate-plan.md 步骤 5）----
// 只在休眠握手期间由前端调用。批次顺序：save_session → hibernate_ready。

/// 落草稿快照。内容是「脏 tab 的 content + 干净 tab 的 path」，见 hibernate 模块。
#[tauri::command]
pub fn save_session(snapshot: hibernate::SessionSnapshot) -> Result<(), String> {
    hibernate::save_snapshot(&snapshot)
}

/// 前端落完草稿的通知：唤醒 `do_hibernate` 的 recv_timeout，随即销毁 WebView。
#[tauri::command]
pub fn hibernate_ready() -> Result<(), String> {
    hibernate::mark_ready()
}

/// 冷启动 / 冷重建时读取上次休眠留下的快照；无快照或版本不符为 `None`。
#[tauri::command]
pub fn load_session() -> Result<Option<hibernate::SessionSnapshot>, String> {
    hibernate::load_snapshot()
}

/// 恢复成功后删除快照（一次性：不在下次冷启动冒出旧内容）。
#[tauri::command]
pub fn clear_session() -> Result<(), String> {
    hibernate::clear_snapshot()
}

/// 取走休眠期间积攒的待打开路径（单实例 handoff 在休眠态的补偿）。
///
/// 调用本身即「前端已就绪」的信号：此后 handoff 可以直接 emit，不必再缓冲。
#[tauri::command]
pub fn take_pending_open() -> Vec<String> {
    hibernate::mark_frontend_ready();
    hibernate::take_pending_open()
}
