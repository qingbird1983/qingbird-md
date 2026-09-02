//! Settings + paths in the platform user-data dir (like the Electron app's
//! `qingbird-settings.json`). Credentials never leave this process.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    String::new()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub providers: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub last_file: Option<String>,
    #[serde(default)]
    pub hotkeys: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub selection_translate: bool,
    #[serde(default = "default_on")]
    pub outline: String,
    #[serde(default = "default_on")]
    pub nav: String,
    /// "" = follow system on first run; otherwise "light"/"dark".
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 开机自启（托盘菜单开关；持久化权威，启动时 apply 到 autostart 插件）。
    #[serde(default)]
    pub autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "auto".to_string(),
            providers: HashMap::new(),
            workspace: None,
            last_file: None,
            hotkeys: HashMap::from([("capture".to_string(), "Ctrl+Shift+X".to_string())]),
            selection_translate: true,
            outline: "on".to_string(),
            nav: "on".to_string(),
            theme: String::new(),
            autostart: false,
        }
    }
}

fn default_provider() -> String {
    "auto".to_string()
}
fn default_on() -> String {
    "on".to_string()
}

pub fn user_data_dir() -> PathBuf {
    if let Some(d) = dirs::data_dir() {
        d.join("qingbird-md")
    } else {
        std::env::temp_dir()
    }
}

pub fn settings_path() -> PathBuf {
    user_data_dir().join("qingbird-settings.json")
}

pub fn cache_path() -> PathBuf {
    user_data_dir().join("qingbird-cache.json")
}

pub fn load_settings() -> Settings {
    load_settings_from(&settings_path())
}

/// [`load_settings`] 的可注入路径版本（测试与复用入口；对应 save_settings_to）。
pub fn load_settings_from(path: &std::path::Path) -> Settings {
    if let Ok(s) = std::fs::read_to_string(path) {
        match serde_json::from_str::<Settings>(&s) {
            Ok(mut v) => {
                // capture 热键补缺：老设置文件升级后开箱即用；显式空串=禁用不补
                v.hotkeys
                    .entry("capture".to_string())
                    .or_insert_with(|| "Ctrl+Shift+X".to_string());
                return v;
            }
            Err(_) => {
                // 加固（审查遗留）：解析失败的坏文件重命名为 <name>.bak-<timestamp>
                // 再回退默认值——坏内容仍在磁盘上，绝不静默丢弃用户数据。
                // rename 失败（权限/占用）不阻塞默认值回退。
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                if let Some(name) = path.file_name() {
                    let bak = path.with_file_name(format!("{}.bak-{ts}", name.to_string_lossy()));
                    let _ = std::fs::rename(path, bak);
                }
            }
        }
    }
    Settings::default()
}

/// Persist `s` to `path`, creating parent dirs as needed; error string on any
/// failure（成功与否可判定，是命令层“先落盘、后广播”的前提）。
pub fn save_settings_to(path: &std::path::Path, s: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    save_settings_to(&settings_path(), s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_settings_file_is_backed_up_and_defaults_loaded() {
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(format!("qingbird-corrupt-{unique}"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("qingbird-settings.json");
        std::fs::write(&p, "{corrupt json").unwrap();

        // 加固契约：解析失败 → 坏文件保留为 <name>.bak-<timestamp>，load 返回默认值，
        // 绝不静默丢弃用户数据。
        let s = load_settings_from(&p);
        assert_eq!(s.provider, "auto");
        assert!(s.workspace.is_none());

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names.len(), 1, "exactly one file should remain, got {names:?}");
        assert!(
            names[0].starts_with("qingbird-settings.json.bak-"),
            "backup must be <name>.bak-<timestamp>, got {names:?}"
        );
    }

    #[test]
    fn settings_defaults() {
        let s = Settings::default();
        assert_eq!(s.provider, "auto");
        assert!(s.selection_translate);
        assert_eq!(s.outline, "on");
    }

    #[test]
    fn save_writes_reloadable_json_and_creates_parents() {
        // Wire contract（Task 14）：settings-updated 的 payload 就是这个 JSON 对象
        let unique = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let target = std::env::temp_dir()
            .join(format!("qingbird-save-{unique}"))
            .join("deep")
            .join("qingbird-settings.json");
        let mut s = Settings::default();
        s.provider = "youdao".into();
        s.theme = "dark".into();
        save_settings_to(&target, &s).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(v["provider"], "youdao");
        assert_eq!(v["theme"], "dark");
    }

    #[test]
    fn save_reports_write_failure_as_err() {
        // 目标即已存在的目录：fs::write 必败 → Err。
        // Err 上抛是“先持久化、后广播”前提——失败路径绝不 emit。
        let dir = std::env::temp_dir().join(format!("qingbird-save-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(save_settings_to(&dir, &Settings::default()).is_err());
    }

    #[test]
    fn settings_json_roundtrip() {
        let mut s = Settings::default();
        s.provider = "youdao".into();
        s.hotkeys.insert("original".into(), "Alt+1".into());
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.provider, "youdao");
        assert_eq!(s2.hotkeys.get("original").map(|x| x.as_str()), Some("Alt+1"));
    }

    #[test]
    fn capture_hotkey_defaults_added_when_missing() {
        // 老用户设置文件无 capture 键 → 加载后补默认值（spec §8）
        let dir = std::env::temp_dir().join(format!("qingbird-hk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("qingbird-settings.json");
        std::fs::write(&p, r#"{"provider":"auto"}"#).unwrap();
        let s = load_settings_from(&p);
        assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
        // 显式空串 = 用户禁用，不得覆盖
        std::fs::write(&p, r#"{"hotkeys":{"capture":""}}"#).unwrap();
        let s2 = load_settings_from(&p);
        assert_eq!(s2.hotkeys.get("capture").map(String::as_str), Some(""));
        // autostart 缺字段 → false
        assert!(!s2.autostart);
    }

    #[test]
    fn default_settings_carry_capture_hotkey() {
        let s = Settings::default();
        assert_eq!(s.hotkeys.get("capture").map(String::as_str), Some("Ctrl+Shift+X"));
        assert!(!s.autostart);
    }
}
