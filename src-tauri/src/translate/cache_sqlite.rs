#![allow(dead_code)] // Step 2 未接生产：open_or_create/flush/shrink_to 等暂只被本文件测试调用，Step 3 切流后随实际消费者出现而移除。
//! `SqliteCache` —— S9 Step 2：rusqlite 持久层 + 内存热层。
//!
//! **本 Step 不切流**：生产路径仍走 JSON（`lib.rs` 的 `Cache::load` 不动），本文件
//! 与文件末的对拍测试先证明「新后端与旧后端逐条同义」。切流在 Step 3。
//!
//! 红线 2：`translate/` 保持同步——用 `rusqlite`（`Connection: Send`），绝不 `async`。
//! 红线 3：`get` 读路径不写库（回查只读、`accessed_at` 不更新），LRU 年龄只在 `set` 改。
//! 红线 4：`set` 不落盘——只改热层 + 压 `pending`；由命令层统一 `flush()` 一事务写。
//! 红线 10：热层预热 `WARM` 与 `bridge/worker.rs` 的 `SHRINK_TO` 同源（都是 1000）。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::cache::CacheBackend;

/// 热层预热条数 = `bridge/worker.rs::SHRINK_TO`（红线 10：必须同源，别另定一个）。
pub const WARM: usize = 1_000;

pub struct SqliteCache {
    /// 内存热层：只预装最新 `WARM` 条 + 最近被回查命中的。`RefCell` 让 `get(&self)`
    /// 能在 DB 命中后回填内存（红线 3 的「读不写库」不受影响——回填只碰内存）。
    hot: RefCell<HashMap<String, String>>,
    conn: Connection,
    /// 单调递增插入序（修 F3）。进程启动取 `MAX(seq)` 继续，故重启后 FIFO 真实。
    seq: i64,
    /// 自上次 `flush` 以来新增/覆盖的 `(key, value, seq)`；`flush` 时一个事务批量写。
    pending: Vec<(String, String, i64)>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl SqliteCache {
    /// 开库（不存在则建）：设 pragma → 建表建索引 → 续 `seq` → 预热热层。
    pub fn open_or_create(path: &Path) -> rusqlite::Result<SqliteCache> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        // `journal_mode=WAL` 持久（写进库头）；`synchronous`/`foreign_keys` 每连接重设。
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS translation_cache (
                 key         TEXT PRIMARY KEY NOT NULL,
                 value       TEXT NOT NULL,
                 seq         INTEGER NOT NULL,
                 accessed_at INTEGER NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_cache_accessed ON translation_cache(accessed_at);
             CREATE INDEX IF NOT EXISTS idx_cache_seq      ON translation_cache(seq);",
        )?;
        let seq: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM translation_cache",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let mut c = SqliteCache {
            hot: RefCell::new(HashMap::new()),
            conn,
            seq,
            pending: Vec::new(),
        };
        c.warm(WARM)?;
        Ok(c)
    }

    /// 预热：取最新 `n` 条灌进热层（按 `seq DESC`，即最近插入的）。
    fn warm(&mut self, n: usize) -> rusqlite::Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM translation_cache ORDER BY seq DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![n as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut hot = self.hot.borrow_mut();
        for row in rows {
            let (k, v) = row?;
            hot.insert(k, v);
        }
        Ok(())
    }

    /// 一个事务把 `pending` 批量写库（`INSERT ... ON CONFLICT DO UPDATE`）。
    /// 红线 4：落盘只在命令层这个统一收口发生，写盘时机与今天的 JSON `save` 一致。
    pub fn flush(&mut self) -> rusqlite::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        let now = now_secs();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO translation_cache(key, value, seq, accessed_at, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                 accessed_at = excluded.accessed_at",
            )?;
            for (k, v, s) in &self.pending {
                stmt.execute(params![k, v, s, now])?;
            }
        }
        tx.commit()?;
        self.pending.clear();
        Ok(())
    }

    /// DB 里是否已有该 key（`set` 判「新键」用；只在写路径调用）。
    fn exists_in_db(&self, key: &str) -> bool {
        self.conn
            .query_row(
                "SELECT 1 FROM translation_cache WHERE key = ?1",
                params![key],
                |_| Ok(()),
            )
            .is_ok()
    }

    /// 按 `seq`（真实插入序，FIFO）丢最旧直到剩余 `<= target`，返回删除数。
    /// 热层与 `pending` 同步剔除，保证「库瘦了内存也瘦」（红线 5）。
    pub fn shrink_to(&mut self, target: usize) -> usize {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM translation_cache", [], |r| r.get(0))
            .unwrap_or(0);
        if (count as usize) <= target {
            return 0;
        }
        let drop_n = count - target as i64;
        let doomed: HashSet<String> = self
            .conn
            .prepare_cached(
                "SELECT key FROM translation_cache ORDER BY seq ASC LIMIT ?1",
            )
            .and_then(|mut s| {
                let rows = s.query_map(params![drop_n], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<HashSet<String>>>()
            })
            .unwrap_or_default();
        let removed = self
            .conn
            .execute(
                "DELETE FROM translation_cache
                 WHERE key IN (SELECT key FROM translation_cache ORDER BY seq ASC LIMIT ?1)",
                params![drop_n],
            )
            .unwrap_or(0);
        self.pending.retain(|(k, _, _)| !doomed.contains(k));
        let mut hot = self.hot.borrow_mut();
        for k in &doomed {
            hot.remove(k);
        }
        removed
    }

    pub fn clear(&mut self) {
        let _ = self.conn.execute("DELETE FROM translation_cache", []);
        self.pending.clear();
        self.hot.borrow_mut().clear();
    }

    /// DB 现存条数（不含未 flush 的 pending）。
    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT COUNT(*) FROM translation_cache", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl CacheBackend for SqliteCache {
    fn get(&self, key: &str) -> Option<String> {
        if let Some(v) = self.hot.borrow().get(key) {
            return Some(v.clone());
        }
        // 热层未命中 → 只读回查 DB（红线 3：读不写库、`accessed_at` 不更新）。
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM translation_cache WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok();
        if let Some(val) = &v {
            self.hot.borrow_mut().insert(key.to_string(), val.clone());
        }
        v
    }

    fn set(&mut self, key: String, value: String) -> bool {
        let in_hot = self.hot.borrow().contains_key(&key);
        let is_new = !in_hot && !self.exists_in_db(&key);
        // 新键才推进 `seq`；覆盖沿用 DB 里原 `seq`，保持真实插入序不被刷新。
        let s = if is_new {
            self.seq += 1;
            self.seq
        } else {
            self.conn
                .query_row(
                    "SELECT seq FROM translation_cache WHERE key = ?1",
                    params![&key],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or_else(|_| {
                    self.seq += 1;
                    self.seq
                })
        };
        self.hot.borrow_mut().insert(key.clone(), value.clone());
        self.pending.push((key, value, s));
        is_new
    }
}

#[cfg(test)]
mod tests {
    use super::super::cache::Cache;
    use super::*;

    fn tmp_db(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qingbird-sqlite-cache-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("cache.db")
    }

    fn k(text: &str) -> String {
        Cache::key("auto", "", text)
    }

    /// 对拍①：同一 `set` 序列喂两后端，逐条 `get` 结果必须相等。
    #[test]
    fn parity_get_after_same_set_sequence() {
        let db = tmp_db("parity");
        let mut json = Cache::new();
        let mut sqlite = SqliteCache::open_or_create(&db).unwrap();
        let texts: Vec<String> = (0..200).map(|i| format!("t{i}")).collect();
        for (i, t) in texts.iter().enumerate() {
            let key = k(t);
            let v = format!("v{i}");
            let a = json.set(key.clone(), v.clone());
            let b = sqlite.set(key, v);
            assert_eq!(a, b, "新键标志必须逐条相等 @ {i}");
        }
        sqlite.flush().unwrap();
        for (i, t) in texts.iter().enumerate() {
            let key = k(t);
            assert_eq!(
                CacheBackend::get(&json, &key).as_deref(),
                CacheBackend::get(&sqlite, &key).as_deref(),
                "get 结果必须逐条相等 @ {i}"
            );
            assert_eq!(CacheBackend::get(&sqlite, &key).as_deref(), Some(format!("v{i}").as_str()));
        }
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// 对拍②（红线 5，最易错）：`shrink_to` 后两者保留的**条目集合**必须相同。
    #[test]
    fn parity_shrink_preserves_same_set() {
        let db = tmp_db("shrink");
        let mut json = Cache::new();
        let mut sqlite = SqliteCache::open_or_create(&db).unwrap();
        for i in 0..50 {
            let key = k(&format!("t{i}"));
            let v = format!("v{i}");
            json.set(key.clone(), v.clone());
            sqlite.set(key, v);
        }
        sqlite.flush().unwrap();
        let j = json.shrink_to(10);
        let s = sqlite.shrink_to(10);
        assert_eq!(j, s, "删除数必须相等");
        // 保留的必须是最新 10 条（t40..t49），两后端逐条一致；最老的 t0..t39 都没了。
        for i in 0..50 {
            let key = k(&format!("t{i}"));
            let in_json = CacheBackend::get(&json, &key).is_some();
            let in_sqlite = CacheBackend::get(&sqlite, &key).is_some();
            assert_eq!(in_json, in_sqlite, "@t{i} 两后端保留判定必须一致");
            assert_eq!(in_sqlite, i >= 40, "只应保留最新 10 条 @t{i}");
        }
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// 对拍③（修 F3）：关连接重开 → 条目与**真实插入序**都还在。
    /// JSON 版做不到（`from_json` 用 `HashMap` 重建 order，重启后 FIFO 退化随机）。
    #[test]
    fn reopen_preserves_true_fifo_order() {
        let dir = tmp_db("reopen");
        let path = dir.clone();
        let order: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
        {
            let mut sqlite = SqliteCache::open_or_create(&path).unwrap();
            for (i, t) in order.iter().enumerate() {
                sqlite.set(k(t), format!("v{i}"));
            }
            sqlite.flush().unwrap();
        } // 连接随作用域结束关闭
        let mut reopened = SqliteCache::open_or_create(&path).unwrap();
        assert_eq!(reopened.len(), 30, "重启后条目数不变");
        // 用真实 seq 顺序收缩：应精确砍掉最先插入的那批（t0..t19），留下后插的。
        reopened.shrink_to(10);
        for (i, t) in order.iter().enumerate() {
            let alive = CacheBackend::get(&reopened, &k(t)).is_some();
            assert_eq!(alive, i >= 20, "重启后 FIFO 必须是真插入序 @t{i}");
        }
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// 对拍④：库有 5000 条，**重开后**热层只预装最新 1000（`WARM`），未预热的 4000
    /// 条 `get` 仍可回查 DB 命中。
    #[test]
    fn unwarmed_entries_still_hit() {
        let db = tmp_db("warm");
        {
            let mut sqlite = SqliteCache::open_or_create(&db).unwrap();
            for i in 0..5000 {
                sqlite.set(k(&format!("t{i}")), format!("v{i}"));
            }
            sqlite.flush().unwrap();
            assert_eq!(sqlite.len(), 5000);
        }
        let sqlite = SqliteCache::open_or_create(&db).unwrap();
        // 预热只取最新 WARM=1000（t4000..t4999）；最老的 t0 一定不在热层。
        assert_eq!(sqlite.hot.borrow().len(), WARM, "重开后热层只装最新 WARM 条");
        assert!(!sqlite.hot.borrow().contains_key(&k("t0")), "t0 不该在预热热层里");
        assert_eq!(CacheBackend::get(&sqlite, &k("t0")).as_deref(), Some("v0"), "未预热仍可命中");
        // 回查命中后被灌进热层（下次读走内存）。
        assert!(sqlite.hot.borrow().contains_key(&k("t0")), "回查命中后应回填热层");
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// 覆盖不刷新 seq（真实插入序不被 overwrite 打乱）。
    #[test]
    fn overwrite_keeps_original_seq_order() {
        let db = tmp_db("ovw");
        let mut sqlite = SqliteCache::open_or_create(&db).unwrap();
        for i in 0..10 {
            sqlite.set(k(&format!("t{i}")), format!("v{i}"));
        }
        // 覆盖最早的一条：值变了，但它仍是「最老」，收缩时该第一个被丢。
        assert!(!sqlite.set(k("t0"), "CHANGED".into()), "覆盖 t0 应返回非新键");
        sqlite.flush().unwrap();
        assert_eq!(CacheBackend::get(&sqlite, &k("t0")).as_deref(), Some("CHANGED"));
        sqlite.shrink_to(9); // 丢最老的一条 → 应是 t0
        assert!(CacheBackend::get(&sqlite, &k("t0")).is_none(), "覆盖不刷新插入序，t0 仍最老先被丢");
        assert!(CacheBackend::get(&sqlite, &k("t1")).is_some(), "t1 应还在");
        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}
