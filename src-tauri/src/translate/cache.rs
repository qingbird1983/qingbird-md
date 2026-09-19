//! Translation memory: in-memory map + JSON disk persistence.
//!
//! Cache keys are *versioned*: they carry the provider, the model name and a
//! prompt version. Change the model or rework a prompt and stale translations
//! stop matching on their own — no more asking the user to clear the cache by
//! hand (the old note in the provider metadata said exactly that, and relying
//! on users to do it is how you get reports of "the translation got worse").

use std::collections::{HashMap, VecDeque};
use std::path::Path;

const MAX: usize = 5_000;

#[derive(Clone)]
pub struct Cache {
    map: HashMap<String, String>,
    /// Insertion order, so eviction is FIFO-predictable instead of depending
    /// on `HashMap` iteration order (which would drop random entries,
    /// including freshly cached ones).
    order: VecDeque<String>,
    /// Set when a *new* key lands; the caller uses it to skip redundant
    /// full-file writes.
    dirty: bool,
}

impl Cache {
    pub fn new() -> Self {
        Cache { map: HashMap::new(), order: VecDeque::new(), dirty: false }
    }

    /// Build a versioned key.
    ///
    /// * `provider` — registry key, e.g. `llm`, `transmart`, `llm-lookup`
    /// * `variant`  — model + prompt version, e.g. `deepseek-chat@v3`; empty
    ///   for providers whose output doesn't depend on user configuration
    /// * `text`     — the source text
    pub fn key(provider: &str, variant: &str, text: &str) -> String {
        format!("{provider}\u{0}{variant}\u{0}{text}")
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }

    /// Insert a result. Returns `true` if the key was newly added.
    pub fn set(&mut self, key: String, value: String) -> bool {
        if let Some(slot) = self.map.get_mut(&key) {
            *slot = value;
            return false;
        }
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        self.dirty = true;
        if self.map.len() > MAX {
            self.prune();
        }
        true
    }

    fn prune(&mut self) {
        let drop = MAX / 4;
        for _ in 0..drop {
            match self.order.pop_front() {
                Some(k) => {
                    self.map.remove(&k);
                }
                None => break,
            }
        }
    }

    /// Drop oldest entries (front of FIFO) until `map.len() <= target`.
    ///
    /// Returns the number of entries actually removed. No-op when
    /// `target >= len()`. Sets `dirty` iff anything was dropped, so the
    /// next [`Self::save`] persists the trimmed set.
    ///
    /// 用途：worker 收尾时发现用户已 N 分钟没翻译，就把内存里的 cache 砍回热 N
    /// 条，主动收缩常驻占用。磁盘 cache.json 跟着重写，下次冷启动 load 进来
    /// 也是小容量——一次瘦身后长期受益。
    pub fn shrink_to(&mut self, target: usize) -> usize {
        let mut dropped = 0;
        while self.map.len() > target {
            match self.order.pop_front() {
                Some(k) => {
                    self.map.remove(&k);
                    dropped += 1;
                }
                None => break,
            }
        }
        if dropped > 0 {
            self.dirty = true;
        }
        dropped
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.dirty = true;
    }

    /// True when new entries arrived since the last [`Self::mark_clean`].
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_clean(&mut self) {
        self.dirty = false;
    }

    /// Test-only size probes (production reads the map only through get/set).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// Production reader for size: bridge.rs needs it to decide whether to
    /// trigger idle-shrink. Read-only, no exposed mutation path.
    pub(crate) fn len_pub(&self) -> usize {
        self.map.len()
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.map).unwrap_or_default()
    }

    pub fn from_json(&mut self, s: &str) {
        if let Ok(m) = serde_json::from_str::<HashMap<String, String>>(s) {
            self.order = m.keys().cloned().collect();
            self.map = m;
        }
    }

    /// Load the cache from a JSON file (creating an empty cache if missing).
    pub fn load(path: &Path) -> Cache {
        let mut c = Cache::new();
        if let Ok(s) = std::fs::read_to_string(path) {
            c.from_json(&s);
        }
        c.mark_clean();
        c
    }

    /// Persist the cache to a JSON file.
    /// 原子写（REL-3）：崩溃/断电不会留下截断的缓存文件。
    pub fn save(&mut self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        crate::atomic_write::write(path, self.to_json().as_bytes())?;
        self.mark_clean();
        Ok(())
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_carries_provider_variant_and_text() {
        assert_eq!(Cache::key("llm", "m@v1", "hi"), "llm\u{0}m@v1\u{0}hi");
    }

    #[test]
    fn changing_variant_invalidates_the_entry() {
        let mut c = Cache::new();
        c.set(Cache::key("llm", "model-a@v1", "hi"), "你好A".into());
        assert_eq!(c.get(&Cache::key("llm", "model-a@v1", "hi")), Some("你好A"));
        assert!(
            c.get(&Cache::key("llm", "model-b@v1", "hi")).is_none(),
            "switching model must miss the cache"
        );
        assert!(
            c.get(&Cache::key("llm", "model-a@v2", "hi")).is_none(),
            "bumping the prompt version must miss the cache"
        );
    }

    #[test]
    fn get_set_roundtrip_and_dirty_flag() {
        let mut c = Cache::new();
        assert!(!c.is_dirty());
        let key = Cache::key("auto", "", "hello");
        assert!(c.set(key.clone(), "你好".into()));
        assert!(c.is_dirty(), "new key marks dirty");
        assert_eq!(c.get(&key), Some("你好"));
        assert!(!c.set(key.clone(), "你好2".into()), "overwrite is not new");
        assert_eq!(c.get(&key), Some("你好2"));
        c.mark_clean();
        assert!(!c.is_dirty());
    }

    #[test]
    fn eviction_is_fifo_not_random() {
        let mut c = Cache::new();
        for i in 0..MAX {
            c.set(Cache::key("auto", "", &i.to_string()), "x".into());
        }
        let first = Cache::key("auto", "", "0");
        // Adding more must evict the oldest first, never the newest.
        for i in MAX..(MAX + 10) {
            c.set(Cache::key("auto", "", &i.to_string()), "x".into());
        }
        assert!(c.get(&first).is_none(), "oldest entry evicted first");
        let newest = Cache::key("auto", "", &(MAX + 9).to_string());
        assert!(c.get(&newest).is_some(), "newest entry survives");
        assert!(c.len() <= MAX);
    }

    #[test]
    fn json_roundtrip_preserves_entries() {
        let mut c = Cache::new();
        c.set(Cache::key("a", "v", "x"), "y".into());
        let json = c.to_json();
        let mut d = Cache::new();
        d.from_json(&json);
        assert_eq!(d.get(&Cache::key("a", "v", "x")), Some("y"));
    }

    #[test]
    fn save_clears_dirty() {
        let dir = std::env::temp_dir().join(format!("qingbird-cache-test-{}", std::process::id()));
        let path = dir.join("cache.json");
        let mut c = Cache::new();
        c.set(Cache::key("a", "v", "x"), "y".into());
        c.save(&path).unwrap();
        assert!(!c.is_dirty(), "persisted cache is clean");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- shrink_to（空闲收缩路径）----

    #[test]
    fn shrink_to_drops_oldest_until_below_target() {
        let mut c = Cache::new();
        for i in 0..10 {
            c.set(Cache::key("auto", "", &format!("t{i}")), format!("v{i}"));
        }
        assert_eq!(c.len(), 10);
        let dropped = c.shrink_to(3);
        assert_eq!(dropped, 7);
        assert_eq!(c.len(), 3);
        // 保留的是后插入的 3 条（t7/t8/t9）——FIFO 从最老开始裁
        assert!(c.get(&Cache::key("auto", "", "t0")).is_none());
        assert!(c.get(&Cache::key("auto", "", "t9")).is_some());
    }

    #[test]
    fn shrink_to_with_target_above_len_is_noop_and_clean() {
        let mut c = Cache::new();
        c.set(Cache::key("auto", "", "a"), "甲".into());
        c.mark_clean();
        let dropped = c.shrink_to(100);
        assert_eq!(dropped, 0);
        assert!(!c.is_dirty(), "no-op shrink must not mark dirty");
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn shrink_to_exact_target_size_drops_nothing() {
        let mut c = Cache::new();
        for i in 0..5 {
            c.set(Cache::key("auto", "", &i.to_string()), "x".into());
        }
        c.mark_clean();
        let dropped = c.shrink_to(5);
        assert_eq!(dropped, 0);
        assert!(!c.is_dirty());
    }

    #[test]
    fn shrink_to_persists_through_save_and_reload() {
        // 重要契约：shrink 后 save，下次冷启动 load 进来还是小容量，
        // 不能「内存瘦了磁盘仍臃肿」让瘦身后的版本被旧版覆盖。
        let dir = std::env::temp_dir()
            .join(format!("qingbird-cache-shrink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cache.json");
        let mut c = Cache::new();
        for i in 0..50 {
            c.set(Cache::key("auto", "", &format!("t{i}")), format!("v{i}"));
        }
        c.save(&path).unwrap();
        let dropped = c.shrink_to(10);
        assert_eq!(dropped, 40);
        c.save(&path).unwrap();
        let reloaded = Cache::load(&path);
        assert_eq!(reloaded.len_pub(), 10);
        // 重新 load 进来的 order 也对（最老的没了）
        for i in 0..40 {
            assert!(
                reloaded.get(&Cache::key("auto", "", &format!("t{i}"))).is_none(),
                "oldest entries must stay dropped after reload"
            );
        }
        for i in 40..50 {
            assert!(
                reloaded.get(&Cache::key("auto", "", &format!("t{i}"))).is_some(),
                "newest entries must survive reload"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
