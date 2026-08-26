//! Settings + paths in the platform user-data dir (like the Electron app's
//! `qingbird-settings.json`). Credentials never leave this process.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
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

pub fn save_settings(s: &Settings) {
    let p = settings_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(&p, json);
    }
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
