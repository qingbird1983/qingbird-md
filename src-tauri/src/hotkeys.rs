//! Task 29 全局热键：settings.hotkeys 三项（original/translation/bilingual）
//! 注册为系统级快捷键——程序未聚焦也能切换阅读模式。回调统一 emit
//! `hotkey-mode`（payload = 模式字符串），前端 App.tsx 监听后 switchMode。
//!
//! 重注册时机：启动 setup 与每次 save_settings 落盘后（save_settings 本就持有
//! AppHandle，等价于 plan 所述「settings-updated 回调时重新计算 diff 注册」的
//! Rust 侧收口）。unregister_all + 全量重注册：项数恒 ≤3，做差分是过度设计。
//!
//! Meta(Win) 决议：录制器可产出 "Meta+X"，本层【显式拒绝】（见 [`registrable`]）。

use crate::storage;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const MODES: [&str; 3] = ["original", "translation", "bilingual"];

/// 注册白名单判定。Meta 显式拒绝：Win 键组合在 Windows 上被系统大量占用
/// （单按弹开始菜单、Win+E 被资源管理器截走），全局注册行为不稳定且不可测；
/// 前端应用内匹配（src/lib/hotkeys.ts parseCombo）同口径拒绝，保存时
/// SettingsModal toast 提示。支持面收窄到 Ctrl/Alt/Shift——与旧版 egui
/// 「须含 Ctrl/Alt/Shift」的可用集一致。空串同理拒绝（「未设置」项）。
fn registrable(combo: &str) -> bool {
    !combo.is_empty() && !combo.split('+').any(|p| p.eq_ignore_ascii_case("Meta"))
}

/// 按当前设置同步全局热键：先全量反注册，再按新值注册可注册项。
/// 单项失败（被其他应用占用/解析失败）只记日志不扩散，其余项照常。
/// 必须在主线程调用（setup / 同步命令天然满足，RegisterHotKey 的线程约束）。
pub fn sync(app: &tauri::AppHandle, settings: &storage::Settings) {
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        eprintln!("global hotkey unregister_all: {e}");
    }
    for mode in MODES {
        let Some(combo) = settings.hotkeys.get(mode) else {
            continue;
        };
        if !registrable(combo) {
            continue; // Meta/空值：录制层允许存在，运行层拒绝（见 registrable 注释）
        }
        let mode_str = mode.to_string(); // 闭包 'static 所需；错误日志借用原 mode
        if let Err(e) = gs.on_shortcut(combo.as_str(), move |app, _shortcut, event| {
            // 按下与松开都会回调，只在按下侧触发一次
            if event.state == ShortcutState::Pressed {
                let _ = app.emit("hotkey-mode", &mode_str);
            }
        }) {
            eprintln!("register global hotkey {combo} ({mode}): {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::registrable;
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    #[test]
    fn meta_and_empty_combos_are_rejected() {
        assert!(!registrable("Meta+X"));
        assert!(!registrable("meta+x")); // 大小写不敏感
        assert!(!registrable(""));
        // Ctrl/Alt/Shift 正常放行
        assert!(registrable("Ctrl+Alt+1"));
        assert!(registrable("Alt+1"));
        assert!(registrable("Ctrl+Shift+Space"));
    }

    #[test]
    fn recorded_combos_parse_to_expected_shortcuts() {
        // 录制器固定产出 Ctrl/Alt/Shift + [A-Z 0-9 Space]；用例锁住 global-hotkey
        // 解析行为，防止上游漂移静默破坏注册。
        let s: Shortcut = "Ctrl+Alt+1".parse().unwrap();
        assert_eq!(s.mods, Modifiers::CONTROL | Modifiers::ALT);
        assert_eq!(s.key, Code::Digit1);

        let s: Shortcut = "Alt+1".parse().unwrap();
        assert_eq!(s.mods, Modifiers::ALT);
        assert_eq!(s.key, Code::Digit1);

        let s: Shortcut = "Ctrl+Shift+A".parse().unwrap();
        assert_eq!(s.key, Code::KeyA);

        let s: Shortcut = "Alt+Space".parse().unwrap();
        assert_eq!(s.key, Code::Space);

        // 纯修饰无主键必须报错（0.5.5+ 行为），落到 eprintln 分支而非 panic
        assert!("Ctrl+Alt".parse::<Shortcut>().is_err());
    }
}
