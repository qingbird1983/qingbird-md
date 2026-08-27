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
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            provider: "auto".to_string(),
            providers: HashMap::new(),
            workspace: None,
            last_file: None,
            hotkeys: HashMap::new(),
            selection_translate: true,
            outline: "on".to_string(),
            nav: "on".to_string(),
            theme: String::new(),
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
    let p = settings_path();
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Settings>(&s) {
            return v;
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
}
