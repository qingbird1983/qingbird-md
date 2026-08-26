//! Translation memory cache: in-memory HashMap + JSON disk persistence.
//! Key = `provider\x00text`, value = translation. Borrows the Electron logic
//! (20k cap, drop 25% oldest when over, debounced save done by the UI layer).

use std::collections::HashMap;
use std::path::Path;

#[derive(Clone)]
pub struct Cache {
    map: HashMap<String, String>,
    dirty: bool,
}

const MAX: usize = 20_000;

impl Cache {
    pub fn new() -> Self {
        Cache { map: HashMap::new(), dirty: false }
    }

    pub fn key(provider: &str, text: &str) -> String {
        format!("{provider}\u{0}{text}")
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }

    /// Insert a result. Returns `true` if the key was newly added (cache miss).
    pub fn set(&mut self, key: String, value: String) -> bool {
        self.dirty = true;
        if self.map.contains_key(&key) {
            self.map.insert(key, value);
            return false;
        }
        self.map.insert(key, value);
        if self.map.len() > MAX {
            self.prune();
        }
        true
    }

    fn prune(&mut self) {
        let drop = MAX / 4;
        let keys: Vec<String> = self.map.keys().take(drop).cloned().collect();
        for k in keys {
            self.map.remove(&k);
        }
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.dirty = true;
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_saved(&mut self) {
        self.dirty = false;
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.map).unwrap_or_default()
    }

    pub fn from_json(&mut self, s: &str) {
        if let Ok(m) = serde_json::from_str::<HashMap<String, String>>(s) {
            self.map = m;
        }
    }

    /// Load the cache from a JSON file (creating an empty cache if missing).
    pub fn load(path: &Path) -> Cache {
        let mut c = Cache::new();
        if let Ok(s) = std::fs::read_to_string(path) {
            c.from_json(&s);
        }
        c
    }

    /// Persist the cache to a JSON file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, self.to_json())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_provider_separator_text() {
        assert_eq!(Cache::key("auto", "hi"), "auto\u{0}hi");
    }

    #[test]
    fn get_set_roundtrip() {
        let mut c = Cache::new();
        let key = Cache::key("auto", "hello");
        assert!(c.set(key.clone(), "你好".into()));
        assert_eq!(c.get(&key), Some("你好"));
        // same key again is a hit (returns false = not newly added)
        assert!(!c.set(key.clone(), "你好".into()));
    }

    #[test]
    fn prunes_to_cap() {
        let mut c = Cache::new();
        for i in 0..(MAX + 1000) {
            c.set(format!("auto\u{0}{i}"), "x".into());
        }
        assert!(c.len() <= MAX);
    }

    #[test]
    fn json_roundtrip() {
        let mut c = Cache::new();
        c.set(Cache::key("a", "x"), "y".into());
        let json = c.to_json();
        let mut d = Cache::new();
        d.from_json(&json);
        assert_eq!(d.get(&Cache::key("a", "x")), Some("y"));
    }
}
