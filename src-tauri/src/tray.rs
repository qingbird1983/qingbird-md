//! 系统托盘：常驻图标 + 菜单 + 关窗隐藏（spec §5）。
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt;

use crate::capture::orchestrate;
use crate::storage;

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let capture = MenuItemBuilder::with_id("capture", "截图翻译").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "开机自启")
        .checked(storage::load_settings().autostart)
        .build(app)?;
    // app.menu() 只返回应用级菜单（本应用从未设置），取不到托盘菜单——克隆
    // CheckMenuItem 句柄供事件闭包捕获，enable/disable 失败时直接在句柄上回滚。
    let autostart_item = autostart.clone();
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &capture, &autostart, &quit])
        .build()?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("青鸟 Markdown")
        .menu(&menu)
        // 左键=显示窗口，右键=菜单。若编译报该 API 不存在（tauri 2.2 及更早），
        // 改用已废弃等价物 `.menu_on_left_click(false)`
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => wake_main_window(app),
            "capture" => trigger_capture(app),
            "autostart" => toggle_autostart(app, &autostart_item),
            // 主动退出不保留休眠草稿：用户的意图是结束，不该在下次冷启动
            // 冒出旧内容（休眠中退出时磁盘上可能还留着一份）。
            "quit" => {
                let _ = crate::hibernate::clear_snapshot();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                wake_main_window(&tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 唤醒主窗口：走 hibernate 的唯一入口（休眠后能冷重建），失败只记日志——
/// 托盘点击不该因为窗口异常而弹错。
fn wake_main_window(app: &tauri::AppHandle) {
    if let Err(e) = crate::hibernate::ensure_main_window(app) {
        eprintln!("tray show main window: {e}");
    }
}

fn trigger_capture(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = orchestrate::begin(app) {
            eprintln!("tray capture: {e}");
        }
    });
}

/// 开关开机自启：插件注册表为即时权威，settings.autostart 为持久化权威。
/// 勾选框被 Tauri 自动翻转；enable/disable 失败时在捕获的菜单项上回滚勾选
/// 并保留旧设置。
fn toggle_autostart(app: &tauri::AppHandle, item: &tauri::menu::CheckMenuItem<tauri::Wry>) {
    let mut s = storage::load_settings();
    let new_val = !s.autostart;
    let result = if new_val {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match result {
        Ok(()) => {
            s.autostart = new_val;
            if let Err(e) = storage::save_settings(&s) {
                eprintln!("save autostart setting: {e}");
            }
        }
        Err(e) => {
            eprintln!("autostart toggle: {e}");
            let _ = item.set_checked(s.autostart);
        }
    }
}
