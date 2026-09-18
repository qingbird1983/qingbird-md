# 翻译缓存接 SQLite：从「单个 JSON 大 blob」到「可增量写、可 LRU 收缩、可全文检索」

**Date:** 2026-09-18
**状态:** 计划（未开工）
**触发:** 用户提出"青鸟的目录很乱，能不能拿 tauri2-react-template 当底座迁移"，并追问"甚至我看到可以接入 SQLite 数据的是吧？" → 结论是**不做整体迁移**，改做外科手术式合并；而"翻译缓存接 SQLite"被选为**第一个切口**（理由见 §一）
**前置文档:** `2026-09-16-translation-correctness.md`（红线 7 明确"核查结果不进现有 Cache"，与本计划的分工不冲突）
**门禁口径:** 沿用项目惯例——`cargo check --all-targets` 0 error 0 warning、`cargo test`、`tsc --noEmit`、`vitest run`；**新守卫测试必须验证"旧代码会让它变红"**

---

## 结论先行

1. **能接，而且门槛很低**：全部持久化都已经在 Rust 侧（`storage.rs` 的 `cache_path()`），前端一行不用改。
2. **但"换数据库"本身不带来收益，选对放什么进去才带来收益。** 现在真正的三个痛点见 §二。
3. **本计划的核心不是 SQLite，是"把缓存策略从 Cache 里拆出来"**——先用一个 trait 划边界（Step 1），再换实现（Step 2），最后才删旧路径（Step 3）。这样每一步都能独立回滚，且**双写对拍期零功能损失**。
4. **⚠️ 最大的技术约束：`translate/` 整个模块是同步的**（实测 0 个 `async fn`、0 处 `.await`）。所以 **不要用 `sqlx`**——它会把这个模块拖进 async 化改造。用 **`rusqlite`**（同步、`Connection: Send`、可塞进现有 `Mutex`），与 `Arc<Mutex<Cache>>` 的形状天然吻合。
5. **顺手修掉一个既有的语义小坑**：`from_json` 用 `HashMap` 重建 `order`，**FIFO 顺序在重启后其实已经退化成随机顺序**（详见 §三 F3）。SQLite 加一列显式序号正好把这件事做对。

---

## 一、为什么选它当第一个切口

| 维度 | 评估 |
| --- | --- |
| 收益可见度 | 中高。缓存是"只涨不跌"常驻内存的主因（`bridge.rs:28-30` 的 2026-09-05 内存诊断已经写明） |
| 爆炸半径 | **小且封闭**。`Cache` 只有一个持有者（`AppTxn.cache`），消费点全部在 `translate/` + `bridge.rs`，**不碰 `data-bi` / `data-ri` 索引空间** |
| 测试兜底 | **强**。`cache.rs` 自带 312 行、8 条契约测试（含 FIFO 驱逐、shrink 后落盘再 load 的持久化契约），迁移期可对拍 |
| 与既有红线冲突 | **无**。红线 7 只说"核查结果不进 Cache"，与本计划改造 Cache 本身不矛盾 |
| 是否解锁后续能力 | 是。做完它，FTS5 全文检索（搜索已缓存译文）才是顺手的事 |

> **与 `2026-09-16-translation-correctness.md` 的排期关系**：那份计划的第 3 步（核查面板 + 确定性检查，共 7 项）**优先级高于本计划**。理由：核查是用户可感知的产品能力，缓存后端重构是内部质量工作；且核查面板落地后 `translations` 的数据量会显著增长，届时再做缓存迁移收益更大。**建议顺序：先完成 correctness 第 2 步收尾 + 第 3 步，再开工本计划。**

---

## 二、现状核实（已读源码，附行号）

### 2.1 `Cache` 的确切形状

```
src-tauri/src/translate/cache.rs        (312 行)
├─ MAX = 5_000                          条数硬上限
├─ struct Cache { map: HashMap<String,String>,
│                 order: VecDeque<String>,   插入序（FIFO 驱逐用）
│                 dirty: bool }              有新键才置位 → 避免冗余全量写盘
├─ key(provider, variant, text) -> String    "{provider}\0{variant}\0{text}"
├─ get / set / prune / shrink_to / clear
├─ is_dirty / mark_clean
├─ len (test) / len_pub (prod, 给 bridge 判是否该收缩)
├─ to_json / from_json
└─ load(path) / save(path)                  std::fs::read_to_string / write
```

**调用面（全部已核实）：**

| 位置 | 干什么 |
| --- | --- |
| `lib.rs:53` | `Arc::new(Mutex::new(Cache::load(&storage::cache_path())))` → 唯一持有者 |
| `engine.rs:88-89`, `:157-159` | 同步命中读取 / 回写（`run(&req, &mut cache, &emit)`，**`&mut Cache` 是同步接口**） |
| `lookup.rs:296`, `:308` | 划词查词：复用同一 Cache，value 是 `WordLookupDTO` 的 JSON 串 |
| `bridge.rs:199`, `:220` | 命中预检（只读） |
| `bridge.rs:327-329`, `:577-588` | 短锁内 `set` 完统一 `save(cache_path())` |
| `bridge.rs:381` | `.clone()` 出快照交给 worker（**关键：靠 Clone 而不是共享锁**） |
| `bridge.rs:51-63` | `shrink_if_idle`：空闲 10 分钟且 >1000 条 → `shrink_to(1000)` |
| `lib.rs:214-216` | `clear_cache` 命令：`clear()` + `save()` |

### 2.2 三个真实痛点

**F1 · 写盘是全量重写，且随缓存增长线性变慢**
`save()` → `to_json()` 把整个 `HashMap` 序列化成一个字符串再 `fs::write`。5000 条译文（长文档的译文段落可以很长）意味着**每次落盘都要序列化几百 KB 到数 MB**。而调用点在 `bridge.rs:588`——**每批翻译 worker 收尾都可能触发**。
→ SQLite 增量 `INSERT OR REPLACE` **只写变化的那几行**。

**F2 · 单文件损坏 = 全部缓存丢失，且没有任何加固**
对比 `storage.rs:213-225`：设置文件解析失败会**重命名为 `.bak-<时间戳>` 再回退默认值**，注释明写"绝不静默丢弃用户数据"。
而 `Cache::load`（`cache.rs:137-144`）是：

```rust
if let Ok(s) = std::fs::read_to_string(path) {
    c.from_json(&s);          // ← 解析失败静默忽略，直接当空缓存
}
```

`read_to_string` 失败（文件被占用/权限）或 `from_json` 失败（JSON 截断——**全量重写时断电就会截断**）→ **静默拿到空缓存，用户所有译文缓存消失，且没有任何提示**。这是设置文件享受了加固、缓存文件没享受的不一致。
→ SQLite 有 WAL + 事务，**写入是原子的**，不会出现"写一半的缓存文件"。

**F3 · FIFO 顺序在重启后退化成随机（既有语义小坑）**

```rust
pub fn from_json(&mut self, s: &str) {
    if let Ok(m) = serde_json::from_str::<HashMap<String, String>>(s) {
        self.order = m.keys().cloned().collect();   // ← 顺序来自 HashMap 迭代
        self.map = m;
    }
}
```

`to_json` 是 `serde_json::to_string(&self.map)`——写盘时顺序正确（HashMap 迭代序 = 输出序，`order` 其实没参与），但**反序列化回来后再用 `m.keys()` 重建 `order`，拿到的是那个新 HashMap 自己的迭代序**，与原来的插入序无关。
→ **进程内 FIFO 是正确的（测试 `eviction_is_fifo_not_random` 覆盖的正是进程内行为），但重启之后"谁先被驱逐"就变成了任意顺序。** 后果不严重（驱逐策略本就是启发式，不会给出错误答案），但它让"FIFO 可预测"这个设计意图（`cache.rs:17-19` 注释明写"eviction is FIFO-predictable instead of depending on `HashMap` iteration order"）**在重启后失效**。
→ SQLite 加一列显式自增序号，把这件事真正做对。

### 2.3 确认无碍的事实

- **`Cache` 不进 IPC 契约**：它是纯 Rust 内部态，前端只看到译文结果。**改它不动 `types/ipc.ts`**。
- **`Cache::key` 的三段制必须原样保留**：它是"改模型/改 prompt 自动失效"与"方向不串味"（correctness 计划 H3 的成果）的承重点。SQLite 版**继续用同一个字符串当主键**，于是 `PROMPT_VERSION` / 方向进 variant 的整套语义零改动。
- **`lookup.rs` 与 `engine.rs` 共用同一 Cache**：value 类型不同（一个是 `WordLookupDTO` 的 JSON，一个是译文），但**都是 `String`**——所以同一张表能装下两者，靠 key 前缀（`CACHE_PROVIDER`）区分。
- **无 `sqlx` / `rusqlite` 已存在**：`Cargo.lock` 里都没有；`tauri = 2.11.5`、`serde = 1.0.229`、`serde_json = 1.0.151`、`tokio = 1.53.1`（tokio 是传递依赖，本计划不需要直接用）。
- **`translate/` 是同步模块**：0 个 `async fn`、0 处 `.await`（已 grep 实测）。这条决定选型。

---

## 三、选型决策：`rusqlite` 而不是 `sqlx`（**已拍板口径**）

| | `sqlx` + `runtime-tokio` | **`rusqlite`（选它）** |
| --- | --- | --- |
| 接口 | `async fn` | **同步** |
| 对 `translate/` 的影响 | **需要把整个模块 async 化**（`run()`、`EngineOp`、`lookup` 全部改签名），爆炸半径从"缓存"扩散到"引擎" | **零签名改动**：`&mut Cache` 照旧 |
| 连接形状 | `SqlitePool`（`Send + Sync`） | `Connection` 是 `Send` 但**非 `Sync`** → 必须 `Mutex<Connection>`。**而我们已经是 `Arc<Mutex<Cache>>`，形状完全吻合** |
| 迁移文件 | `sqlx::migrate!` 编译期内嵌（很好用） | 手写 `execute_batch` 的 `CREATE TABLE IF NOT EXISTS`，或用 `user_version` pragma 做版本闸 |
| 首次编译成本 | 拉 tokio + sqlx 一棵树 | `bundled` 会编译一份 SQLite C 源码（一次性，之后增量） |
| 离线/网络 | 需要 crates.io | 同 |

**决策：`rusqlite` + `bundled` feature。** 理由一句话：**`translate/` 是同步的，缓存访问是本地微秒级操作，引入 async 是纯负担。**

> **注意 `bundled` 的取舍**：它免掉"用户机器上有 sqlite3.dll"这个部署前提，代价是一次性编译 C 源码。
>
> ⚠️ **与你项目的 `profile.release` 有交互**：`Cargo.toml` 里 `lto = true` + `codegen-units = 1`，加一个 C 依赖会让 **release 链接时间变长**。这是可接受的，但要知道它会发生——如果打包时间变得难以忍受，先试 `rusqlite` 不带 `bundled`（改依赖系统 sqlite），或把 `lto` 在调试 profile 下调松（`[profile.dev]` 本就没开 lto，日常迭代不受影响）。

### 预期依赖改动（`src-tauri/Cargo.toml`）

```toml
# 缓存持久化：同步嵌入式库，与 translate/ 的同步接口一致。
# bundled = 自带 SQLite 源码，不依赖用户机器上的 sqlite3.dll。
rusqlite = { version = "0.32", features = ["bundled"] }
```

> **版本要现查**：`0.32` 是落笔时的常见版本，**开工时用 `cargo add rusqlite --features bundled` 让它自己解析**，别照抄这个数字。

---

## 四、目标架构：策略与存储分离

现在的 `Cache` **同时**是「内存索引 + 驱逐策略 + 序列化 + 文件 IO」四件事。SQLite 版把这四件事拆开：

```
┌─ 上层（不改）──────────────────────────────────────────┐
│  engine.rs  run(&req, &mut cache, &emit)               │
│  lookup.rs  cache_get_lookup(&cache, …)                │
│  bridge.rs  st.cache.lock()…get()/set()                │
└────────────────────┬───────────────────────────────────┘
                     │  同一组方法（get / set / key / len / shrink_to / clear）
┌────────────────────▼───────────────────────────────────┐
│  trait CacheStore: Send                                 │
│    fn get(&self, key: &str) -> Option<&str>             │
│    fn set(&mut self, key: String, value: String) -> bool│
│    fn shrink_to(&mut self, target: usize) -> usize      │
│    fn clear(&mut self)                                  │
│    fn len(&self) -> usize                               │
└──────┬──────────────────────────────┬──────────────────┘
       │                              │
┌──────▼──────────┐        ┌──────────▼───────────────────┐
│ JsonCache       │        │ SqliteCache                  │
│ （= 今天的实现） │        │  内存 HashMap（热层，读极快） │
│  迁移期保留，    │        │  + rusqlite Connection       │
│  之后删除        │        │  （持久层 + 增量写 + LRU）    │
└─────────────────┘        └──────────────────────────────┘
```

**一个必须提前想清楚的接口矛盾**：今天的 `get(&self) -> Option<&str>` **返回借用**。SQLite 版如果热层是 `HashMap<String,String>`，这个签名完全能保留（借用热层）；**但 LRU 需要 `get` 记录访问时间，而那要 `&mut self`**。

→ **处理办法：`get` 保持 `&self` 且不写库**（读路径零写放大），**LRU 的"访问时间"只在 `set` 时更新**。这是有意的取舍：代价是"只读不写的热条目不会被刷新年龄"，收益是**读路径完全不上锁写、不碰磁盘**。对翻译场景这是对的——被翻译过的文本几乎总会再被 `set` 一次。
→ 如果将来确实要"读也刷新年龄"，再加一个显式的 `touch(&mut self, key)` 在 worker 收尾时批量调用，**不要**把 `get` 改成 `&mut self`（那会让 `lookup.rs:296` 这种只读调用点全部动荡）。

---

## 五、SQLite 表设计

```sql
PRAGMA journal_mode = WAL;      -- 原子写 + 读写不互斥
PRAGMA synchronous = NORMAL;    -- WAL 下的常用取舍：崩溃不损坏，极端断电可能丢最后几笔
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS translation_cache (
    key         TEXT PRIMARY KEY NOT NULL,   -- 就是 Cache::key 的 "{p}\0{v}\0{text}"
    value       TEXT NOT NULL,               -- 译文，或 WordLookupDTO 的 JSON 串
    seq         INTEGER NOT NULL,            -- 显式插入序（修 F3）
    accessed_at INTEGER NOT NULL,            -- Unix 秒；仅 set 时更新（见 §四）
    created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_cache_accessed ON translation_cache(accessed_at);
CREATE INDEX IF NOT EXISTS idx_cache_seq      ON translation_cache(seq);
```

**逐列说明：**

| 列 | 为什么 |
| --- | --- |
| `key` 主键 | **沿用现有的三段字符串**，于是"改模型/改 prompt/换方向自动失效"整套语义**零改动**地继承过来。别再拆成三列——拆了就要在 SQL 里重建拼接逻辑，两份真源 |
| `value` | 译文与查词 JSON 共用一列（都是 `String`）。**表名不叫 `lookup_cache` 也不叫 `translation_entries`**，因为它装两种东西 |
| `seq` | `INTEGER`，进程启动时取 `MAX(seq)` 继续递增（或直接用 `AUTOINCREMENT` 的 rowid）。**修 F3**：重启后 FIFO 顺序依然真实 |
| `accessed_at` | 给将来的 LRU 与"按龄清理"留的钩子；v1 只用它做 `shrink_to` 的排序键（等价 FIFO 时用 `seq`，等价不了就退化用 `accessed_at`） |
| `created_at` | 诊断/将来做"缓存年龄分布"用 |
| `STRICT` | SQLite 3.37+ 的类型严格表。**如果你用的 rusqlite 版本偏老不支持，去掉即可**（不影响正确性） |

> **`PRAGMA` 是每连接生效的**：`journal_mode = WAL` 是**持久化**属性（写在库文件头，设一次就一直有效），但 `synchronous` / `foreign_keys` 是**每连接**属性，每次开连接都要重设。

### 文件位置

```
%APPDATA%\qingbird-md\qingbird-cache.db      ← 新
%APPDATA%\qingbird-md\qingbird-cache.db-wal  ← WAL 副产物，别手动删
%APPDATA%\qingbird-md\qingbird-cache.db-shm  ← 同上
%APPDATA%\qingbird-md\qingbird-cache.json    ← 旧文件，迁移后保留（不删，见 §六 Step 3）
```

`storage.rs` 增一个 `cache_db_path()`，与现有 `cache_path()` 并列。

---

## 六、落地顺序（每步独立可发布、独立回滚）

### Step 1 — 划边界：抽 `CacheStore` trait，不动行为

**目标：零行为变化，纯重构。** 这一步做完，`cargo test` 的 8 条契约测试必须**一条不改地全过**。

1. 在 `translate/cache.rs` 定义 `trait CacheStore`（方法见 §四），把今天的 `Cache` 改名为 `JsonCache`（或让 `Cache` 实现 trait，**保留 `Cache` 名字以免 130 处调用点动荡**——推荐后者，但那样 trait 名要另起，例如 `CacheBackend`）。
2. `engine.rs:run(&req, &mut cache: &mut impl CacheBackend, emit)` —— 用泛型或 `&mut dyn CacheBackend`。
   - **建议 `&mut dyn`**：`run` 不是热到需要单态化的路径（它内部是网络请求），动态派发开销可忽略，换来的是调用点不必泛型化（`bridge.rs` 的调用点很多）。
3. `lookup.rs` 的两个函数签名同步改成 trait 对象。
4. **红线**：`Cache::key` 是三段制字符串拼接，**这一步一个字都不许改**。
5. 门禁：`cargo check --all-targets` 0/0 + `cargo test` 全过 + **`cache.rs` 的既有测试体不改动**（改了就说明行为漂了）。

**回滚**：`git revert` 单提交，无数据迁移，零风险。

### Step 2 — 落 `SqliteCache` + 双写对拍（**不切流**）

**目标：新实现存在并与旧实现逐条对拍，但生产仍走 JSON。** 这一步是整份计划里唯一有实质风险的地方，所以**让它没有切换动作**。

1. 加 `rusqlite` 依赖（`cargo add rusqlite --features bundled`）。
2. 新建 `translate/cache_sqlite.rs`：
   - `SqliteCache { hot: HashMap<String,String>, conn: rusqlite::Connection, seq: i64, dirty: Vec<String>/或直接同步写 }`
   - `open_or_create(path)`：开库 → 设 pragma → 建表（`CREATE TABLE IF NOT EXISTS`）→ 预热热层。
3. **热层预热策略（要拍板）**：启动时 `SELECT key,value FROM translation_cache ORDER BY seq DESC LIMIT N`。
   - `N` 取多少？**建议 `N = SHRINK_TO = 1000`**（`bridge.rs:35` 已有的"热 1000 条"口径）。**直接复用这个数字，不要另定一个**——否则会出现"内存热层上限"和"收缩目标"两个互相打架的常量。
   - 库里有 5000 条、热层只装 1000 条时，**未预热的 4000 条仍可命中**（`get` 未命中热层 → 回查 SQLite → 塞进热层）。这条必须有测试。
4. **对拍测试**（新增，纯 Rust、不需要网络）：
   - 同一串 `set` 序列喂给 `JsonCache` 和 `SqliteCache`，逐条 `get` 结果必须相等
   - **`shrink_to` 后两者保留的条目集合必须相同**（这是最容易出错的一处，因为驱逐排序依据不同）
   - 关闭连接重开 → 条目与顺序都还在（**这条是 JSON 版做不到的，正好证明 F3 被修掉**）
5. **进程级双写开关**（可选但推荐）：环境变量 `QINGBIRD_CACHE_DUAL=1` → 生产路径同时写 JSON 与 SQLite，但**只读 JSON**。跑几天看两个库是否一致。
   - 好处：真实使用量下的差异（真实译文的长度分布、并发写）会暴露出来，而用户感知为零。
   - **不推荐**做成用户可见设置——它是开发期工具，不是功能。
6. 门禁：新增测试全过 + 既有测试不动。

**回滚**：SQLite 文件是新增的，删掉即可；生产路径没变。

### Step 3 — 切流 + 一次性导入 + 保留旧文件

1. 切换：`lib.rs:53` 的 `Cache::load(cache_path())` → `SqliteCache::open_or_create(cache_db_path())`。
2. **一次性导入**（`migrate_json_to_sqlite`）：
   - 启动时若 `qingbird-cache.db` 不存在（或表为空）**且** `qingbird-cache.json` 存在 → 读出、批量插入、**在一个事务里**提交。
   - `order`（FIFO 序）**没法从 JSON 忠实恢复**（F3），所以导入时按 `HashMap` 迭代序赋 `seq`——**这已经不比现状差**，且之后的新条目顺序是真的。**要在代码注释里写明这个已知损失**，别假装无损。
   - 导入成功后 **`qingbird-cache.json` 不删**，重命名为 `qingbird-cache.json.imported-<时间戳>`。
     - 理由与 `storage.rs:221-224` 的 `.bak-<ts>` 同源：**绝不静默丢弃用户数据**，且留一个可回退的旧版本。
     - ⚠️ 这里比设置文件更进一步——**磁盘上是两份缓存**（一份在 .db、一份在重命名后的 .json）。缓存是可重建的派生数据，体积也有限，这是可接受的；但**要在 §八 的数据与隐私一节向用户说明**。
3. `set` 的落盘策略拍板：
   - 今天：`bridge.rs:588` 在 worker 收尾时**显式** `save(cache_path())`；`set` 本身**不落盘**（`lookup.rs:300` 注释明写"不落盘——落盘由命令层在短锁内完成"）。
   - SQLite 版建议**保留这个形状**：`set` 只改热层 + 标脏；由 `bridge.rs` 那个已有的收尾点调 `flush()` 批量 `INSERT OR REPLACE`（**一个事务**）。
   - 这样**写盘时机与今天完全一致**，只是从"全量重写一个 JSON"变成"事务里写 N 行"。**改动最小，也最容易对拍。**
   - ⚠️ **代价**：进程被强杀时最后一批未 flush 的条目会丢——**这与今天的行为完全相同**（今天的 `set` 也不落盘），所以不是回归。
4. `shrink_to` 的实现：`DELETE FROM translation_cache WHERE key IN (SELECT key ... ORDER BY seq ASC LIMIT N)` + 同步收缩热层。**必须与热层收缩在同一个逻辑动作里**，否则会出现"库瘦了内存没瘦"或反之。
   - `bridge.rs:51-63` 的 `shrink_if_idle` 判据（空闲 10 分钟 + >1000 条）**保持不变**，它只调 `shrink_to`，不关心实现。
5. `clear_cache` 命令（`lib.rs:214`）：`DELETE FROM translation_cache` + `clear()` 热层。**注意 `VACUUM` 不要在这里同步调**——大库 `VACUUM` 会卡住 UI 线程，交给 `shrink_if_idle` 那类空闲时机，或干脆不做（SQLite 会复用空闲页）。

**回滚**：把 `lib.rs` 那一行改回 `Cache::load(cache_path())`，并把 `qingbird-cache.json.imported-*` 改回 `qingbird-cache.json`。**因为旧文件被保留了，所以这是真回滚，不是"重建缓存"。**

### Step 4（可选，独立排期）— FTS5 内容检索

**这一步不是缓存改造，是新能力**，所以单独排期、单独发布。

- 加 FTS5 虚拟表，索引**已缓存的译文**：`CREATE VIRTUAL TABLE cache_fts USING fts5(key UNINDEXED, value, tokenize='trigram')`。
- `tokenize='trigram'` 是为了**中文**——默认的 unicode61 分词器对中文基本不可用（整段会被当成一个 token）。trigram 在中文子串搜索上表现可用。
- 用途：命令面板搜"哪个文档/段落译过这个词"。**这是 correctness 计划里还没覆盖的能力空缺。**
- ⚠️ **别和缓存表做成同步触发器**：FTS 索引会让每次 `set` 变重，而缓存写入是高频路径。**建议按需重建**（空闲时增量补）。

---

## 七、红线（需并入项目红线）

1. **`Cache::key` 的三段制字符串一个字都不许改。** 它是"改模型/改 prompt/换方向自动失效"的承重点（correctness 计划 H3 的成果）。SQLite 版**继续用它当主键**，不拆列、不重新拼接。
2. **`translate/` 保持同步。** 不得因为引入数据库而把 `run()` / `lookup` 改成 `async fn`。**看到 `async` 进 `translate/` 就是走错了**（那应该选 sqlx，而选 sqlx 的代价是把整个引擎 async 化——本计划明确拒绝）。
3. **`get` 保持 `&self` 且不写库。** 读路径不得有写放大。LRU 年龄只在 `set` 时更新（§四）。
4. **落盘时机不得改变。** 今天的契约是"`set` 不落盘、命令层短锁内统一落盘"（`lookup.rs:300` 注释）。SQLite 版沿用，只把"全量重写"换成"事务批量写"。
5. **`SqliteCache` 与旧 `Cache` 的 `shrink_to` 保留集合必须在测试里逐条相等。** 这是双写对拍期最容易漏的一处（驱逐排序依据不同）。
6. **旧 `qingbird-cache.json` 迁移后必须保留为 `.imported-<ts>`，不得删除。** 与 `storage.rs` 的 `.bak-<ts>` 同源：绝不静默丢弃用户数据。且**回滚路径必须依赖它**——没有它，"回滚"就退化成"用户缓存全丢"。
7. **JSON→SQLite 的顺序损失是已知且接受的**，必须写在导入代码的注释里（`HashMap` 迭代序 ≠ 原插入序，F3）。**不得在文档或注释里声称"无损迁移"。**
8. **缓存库不得进 IPC 契约。** `types/ipc.ts` 一行不改。它是纯 Rust 内部态。
9. **`VACUUM` 不得在命令路径同步调用**（会卡 UI 线程）。空闲时机或不做。
10. **热层上限 `N` 与 `SHRINK_TO` 必须同源**（建议都是 1000）。不得出现两个互相打架的常量。
11. **FTS5 若做，不得用触发器同步**（会让高频 `set` 路径变重）。按需重建。
12. 门禁沿用：`cargo check --all-targets` 0 error 0 warning、`cargo test`、`tsc --noEmit`、`vitest run`；**新守卫测试必须验证"旧代码会让它变红"**。构建走 PowerShell。

---

## 八、需要拍板的问题

| # | 问题 | 建议 | 影响 |
| --- | --- | --- | --- |
| 1 | `rusqlite` vs `sqlx` | **`rusqlite`**（§三，已给理由） | 决定 `translate/` 是否要 async 化。**这条是全局约束，先定它** |
| 2 | 是否要 `bundled` | **要**。免掉部署前提 | release 链接变慢（`lto` 已开） |
| 3 | 热层预热条数 `N` | **1000（= `SHRINK_TO`）** | 内存占用 vs 首次命中率 |
| 4 | 是否做 Step 2 的双写对拍 | **做**（推荐开 `QINGBIRD_CACHE_DUAL` 跑几天） | 多几天工期，换来真实负载下的验证 |
| 5 | 旧 JSON 文件怎么处理 | **重命名保留**，不删 | 磁盘上短暂两份缓存 |
| 6 | FTS5 是否并入本次 | **不并入**，单独排期 | 避免把"重构"和"新能力"混在一个可回滚单元里 |
| 7 | 是否顺带把 `Settings` 也搬进 SQLite | **不搬**。设置变动频繁（`SettingsModal.tsx` 56KB），且 JSON + `.bak` 加固已经在工作 | 见 §九 |

---

## 九、明确**不**在本计划范围内的

- **设置迁 SQLite**（`qingbird-settings.json` → 表）。理由：设置文件的加固（`.bak-<ts>` 回退）已经在正常工作，而它是**用户改动最频繁**的地方——`SettingsModal.tsx` 有 56644 字节。把高频写路径从"一个原子小文件"改成"数据库事务"没有明显收益，风险却不小。**缓存是只增不改的派生数据，设置是用户资产，两者风险等级不同。**
- **工作区 `.md` 索引表**。`workspace.rs` 的递归扫描 + 内存过滤是另一个独立痛点，收益明确（大仓库启动变快、可做增量更新），但它**牵动 `data-bi` / 打开文档的路径**，爆炸半径远大于缓存。单独排期。
- **`%APPDATA%` 目录迁移 / 目录结构重排**。缓存库放在现有 `user_data_dir()` 里，与 `qingbird-settings.json` 并列，**不新建子目录**——新建目录会让 `user_data_dir_label()`（`storage.rs:170`）的显示与"打开数据目录"的行为都要跟着改，无收益。
- **任何前端改动**。本计划前端零改动。

---

## 十、开工前检查清单（仅本计划）

```powershell
# 1. 基线：确认现在是绿的（动手前必须全过）
cd F:\AIwork\qingbird-md-rust\src-tauri
cargo check --all-targets        # 期望 0 error 0 warning
cargo test                        # 记录 passed 数作为基线

cd F:\AIwork\qingbird-md-rust
npx tsc --noEmit                  # 期望 0 输出
npm test                          # 记录文件数与用例数作为基线

# 2. 备份现有缓存（真回滚的保险，开工前手动做一次）
copy "%APPDATA%\qingbird-md\qingbird-cache.json" "%APPDATA%\qingbird-md\qingbird-cache.json.pre-sqlite"

# 3. 加依赖（让它自己解析版本，别照抄计划里的 0.32）
cargo add rusqlite --features bundled
```

> **⚠️ 注意 `target/` 已在 2026-09-18 清空**（25.7 GB 垃圾清理）。第一次 `cargo check` 会全量重编译，加上 `lto = true` + `codegen-units = 1`，预计 10-20 分钟。**这不是卡死**，别在中途 Ctrl+C。

---

# 附录 · 三份计划的总排期表（2026-09-18）

**覆盖范围**：本文档 + `2026-09-16-translation-correctness.md` + `2026-09-16-wysiwyg-live-preview.md`。
**用途**：这三份都是"未来要完成"的计划，各自内部有顺序、彼此之间却没写过依赖与冲突。本附录补这一层。
**口径**：工作量是**量级估计**（人日），依据是各计划自己写明的改动面（新增文件数、是否动网格、是否动 Rust 索引空间），**不是承诺**。

---

## 附 1 · 全局前置：两项技术债先还（**不是可选项**）

这两件事**不属于任何一份计划**，但三份计划都压在它们上面。**建议先做，成本很低。**

| # | 事项 | 为什么必须前置 | 量 |
| --- | --- | --- | --- |
| **P0-1** | `src/styles/global.css` 拆分（**3590 行**） | correctness §九 要往里加 `.panel-slot` / `.panel-handle` / 状态栏 AI 钮；wysiwyg 的 L0/L1 也全是 CSS。**不拆就是往一个已经过大的文件里继续堆**，且两份计划会改同一个文件 → 冲突面最大 | 1 天 |
| **P0-2** | `patchPartial.ts` 锚点缺失**静默跳过** → 改为打日志 | 两份计划都点名了它（correctness 的 issue 跳转、wysiwyg 的 §六）。现在翻译"没反应"且**无迹可查**——调试成本极高 | 2 小时 |

> P0-1 的拆分口径 `2026-09-16-module-splits.md` 的 P1-2 已经给了：按关注面切 `layout-shell`（网格/栏）/ `panels`（侧栏·大纲·拖宽条）/ `editor` / `preview` / `overlays`，入口用一个 `@import` 列表固定顺序。**照它做，别另起一套。**

---

## 附 2 · 三份计划的真实剩余量（已逐行核对源码）

### A. `2026-09-16-translation-correctness.md` —— 剩余最大，优先级最高

| 步骤 | 项 | 状态 | 量 |
| --- | --- | --- | --- |
| 第 0 步 | H1 / H3 / B4 | ✅ 完成（`19364ee`） | — |
| 第 1 步 | 方向贯通（4 项） | ✅ 完成 | — |
| **第 2 步** | 7 Rust `export_translation` | ⚠️ **仅单语**（`cmark.rs:77`，`mode`/`policy` 参数不存在） | — |
| | 8 前端入口 | ✅ 完成 | — |
| | **9 双语对照导出** | ❌ 未做 | **0.5 天** |
| **第 3 步** | **15 确定性检查断言** | ❌ 未做 | **1 天** |
| | 10 + 10b 槽位泛化 + `.panel-slot`/把手/状态栏 AI 钮 | ❌ 未做 | **1.5 天** |
| | 11 / 12 / 13 / 14 / 16（Timeline / Composer / 滚动跟随 / 入口层 / IssueCard） | ❌ 未做 | **1.5 天** |
| **第 4 步** | 17–21 AI 语义核查（prompt + 严格解码 + 分批 + 锚点守卫） | ❌ 未做 | **2 天** |
| **第 5 步** | 22–23 重排版规则集 | ❌ 未做 | **1.5 天** |
| | | | **合计 ≈ 8 天** |

### B. `2026-09-16-wysiwyg-live-preview.md` —— 全部未做

| 阶段 | 内容 | 量 |
| --- | --- | --- |
| 第一阶段 | L0 排版提示（纯 CSS）+ L1-a 行内标记隐藏 + **视口裁剪** | **1 天** |
| 第二阶段 | L1-b 标题分级 + 列表/引用 + 任务列表勾选；**分栏联动改行号→offset 直接映射** | **1.5 天** |
| 第三阶段 | 代码块渲染态 → 表格 Tab 导航 → front matter；+ §六 视图约束 | **2.5 天** |
| 第四阶段 | 公式 / mermaid 双击、气泡工具条、专注模式（**储备，可无限延后**） | 按需 |
| | | **前两阶段 ≈ 2.5 天；前三阶段 ≈ 5 天** |

### C. 本文档（SQLite 缓存）—— 全部未做

| 步骤 | 内容 | 量 |
| --- | --- | --- |
| Step 1 | 抽 `CacheBackend` trait（零行为变化） | 0.5 天 |
| Step 2 | `SqliteCache` + 双写对拍（**不切流**） | 1.5 天 |
| Step 3 | 切流 + 一次性导入 + 保留旧文件 | 1 天 |
| Step 4 | FTS5 内容检索（**可选，独立排期**） | 1.5 天 |
| | | **Step 1–3 ≈ 3 天**（另加对拍观察期，与开发并行） |

**三份合计 ≈ 16 天**（不含 P0 的 1 天、不含可选项与第四阶段储备）。

---

## 附 3 · 依赖关系（谁卡谁）

```
P0-1 global.css 拆分 ──┬──> A 第 3 步（§九 要加 .panel-slot/.panel-handle）
                       └──> B 第一阶段（L0/L1 全是 CSS）
P0-2 patchPartial 日志 ─┬──> A 第 3 步（issue 跳转依赖锚点）
                        └──> B §六（视图约束）

A 第 2 步 第 9 项（双语导出）── 独立，无前置
A 第 3 步 第 15 项（确定性检查）── 独立纯 Rust，且是第 3 步其余项的地基
A 第 3 步 面板外壳 ──> A 第 4 步（没面板就没地方展示 issue）
A 第 4 步 ──> A 第 5 步（重排版要处置 issue 之后才谈）

B ── 与 A 完全并行，但**共享三个改动面**（见附 4）
C ── 与 A/B 其他项**技术独立**；唯一交互是 A 第 4 步会让 translations 变大，
     所以 C 放在 A 之后收益更大（§一已述）
```

**关键路径**：`P0-1 → A 第 3 步 → A 第 4 步 → A 第 5 步`。A 是唯一有"先做地基"性质的计划，所以它占关键路径。

---

## 附 4 · ⚠️ 三份计划之间的四处真实冲突（**这是本附录最重要的部分**）

三份文档各自内部都写得很细，但**彼此之间的重叠面没写过**。以下四处如果不排序就并行开工，会产生返工：

### 冲突 1 · 两套东西都想要网格列（**最严重**）

| | 要什么 |
| --- | --- |
| **A 第 3 步第 10 项** | 把 col3 左槽 / col7 右槽从「大纲栏专属」泛化为**双宿主槽位**；新增 `showReview` / `reviewWidth`；独立 `PanelResizer` place；`absorb` 判断变量改名 |
| **B §五 / §十** | 保留三态视图（源码 / Live Preview / 双栏），`Compartment.reconfigure` 切模式 |

**冲突点**：A 在改**侧栏**网格，B 在改**主区**的视图模式。两者都动 `App.tsx` 的网格与 `useUiStore`。虽然**理论上不互斥**（侧栏 vs 主区），但 `absorb` / `--col-ws` / intro 两态那套逻辑很敏感，**同时改会很难定位回归**。

→ **处置：串行。A 第 3 步的面板外壳先做，B 的第一阶段后做。**

### 冲突 2 · `global.css` 是共同战场

A 要加 `.panel-slot` / `.panel-handle` / 状态栏 AI 钮；B 的 L0/L1 加标题分级、标记淡色、列表 `::before`。**两者都在 3590 行的大文件里加规则。**

→ **处置：P0-1 必须先行**，且拆分后的 `panels` 与 `editor` 两个关注面正好一人一块，冲突自然消解。**这是 P0-1 从"技术债"升级为"前置条件"的真正原因。**

### 冲突 3 · 视图状态联动是同一处逻辑

- A §六：**点 issue 跳转**要按 `lockSplitSide("preview")` → `scrollIntoView` → `emitSplitSync` 的顺序
- B §六：新增**视图约束**——"开始翻译时若处于单栏 Live Preview/纯源码，自动确保预览面板可见（切到分栏）"

**两者都在改"翻译与预览面板的联动"**，且都动 `splitSync.ts` / `useUiStore` 的视图状态。B §十 第二阶段还要把**分栏联动从像素反查改成行号→offset 直接映射**，那正是 A 跳转要依赖的机制。

→ **处置：合并考虑。建议 B 的"行号→offset 映射"改动放在 A 第 3 步之前**——它是底层机制改进，先做能让 A 的跳转少一层脆弱假设。或者**明确接受 A 先用现有块级锚点，B 之后再改进**（A §8.7 已经说了 issue 大多块级性质，跳块即可）。**两种都行，但不能两边都以为对方会处理。**

### 冲突 4 · `hotkeyRegistry.ts` 的写入排队

- A 第 3 步第 14 项：加 `Ctrl+J`（AI 核查入口）
- B §七 红线 5：**新增快捷键必须同步 `hotkeyRegistry.ts`** 且让三方对齐测试通过

→ **处置：A 先登记 `Ctrl+J`。** B 目前没有明确要加新键（是改视图模式循环，可能复用现有键），但要**在开工前确认它打算用的键没被占**。`hotkeyRegistry.ts` 是单一真源，**改动必须串行**。

---

## 附 5 · 推荐的串行排期（一条路，不并行）

**原则：A 优先（护城河 + 用户可感知），B 随后（观感基线），C 最后（内部质量）。**

| 阶段 | 内容 | 累计 | 里程碑 |
| --- | --- | --- | --- |
| **S0** | **P0-1 CSS 拆分** + **P0-2 patchPartial 日志** | 1.2 天 | 地基就位，后续三份计划都可安全落笔 |
| **S1** | **A 第 2 步第 9 项**：双语对照导出 | +0.5 天 | 🚩 **可发布**：第 2 步收尾，用户感知明确 |
| **S2** | **A 第 3 步第 15 项**：确定性检查断言（纯 Rust） | +1 天 | 检查能力可用（无 UI 也能靠测试证明） |
| **S3** | **A 第 3 步 10/10b**：槽位泛化 + `.panel-slot` + 把手 + 状态栏 AI 钮 | +1.5 天 | 🚩 **可发布**：面板能开能关能拉宽，但还只能跑确定性检查 |
| **S4** | **A 第 3 步 11/12/13/14/16**：Timeline / Composer / 滚动跟随 / 入口层 / IssueCard | +1.5 天 | 🚩 **可发布**：核查面板完整（L2 ① 全部落地） |
| **S5** | **A 第 4 步 17–21**：AI 语义核查 | +2 天 | 🚩 **可发布**：交付型翻译闭环完成 ← **本项目的产品分水岭** |
| **S6** | **A 第 5 步 22–23**：重排版规则集 | +1.5 天 | 🚩 A 计划全部完成 |
| **S7** | **B 第一阶段**：L0 + L1-a + 视口裁剪 | +1 天 | 🚩 **可发布**：编辑观感第一步 |
| **S8** | **B 第二阶段**：L1-b + 行号→offset 映射 | +1.5 天 | 🚩 **可发布**：第一梯队全齐（§十 建议在此收反馈） |
| **S9** | **C Step 1–3**：SQLite 缓存 + 双写对拍 | +3 天 | 🚩 可发布（对拍观察期与 S10 并行） |
| **S10** | **B 第三阶段**：代码块 / 表格 Tab / front matter | +2.5 天 | 🚩 第二梯队全齐 |
| **S11** | **C Step 4** FTS5 + **B 第四阶段**（公式/mermaid/气泡条/专注模式） | 按需 | 储备项，无排期承诺 |

**总长约 16–17 个工作日**（S0–S10），到 S8 就能覆盖三份计划里**用户可感知的主体**（约 11 天）。

### 为什么 A 排在 B 前面（而 B 文档自己建议"另存为先行"）

B 的 §十一 结尾确实建议"若排期紧张，先做另存为 + 双向互译"。**本排期与它一致**——S1 就是第 9 项，而且它把 correctness 计划里剩下的部分也一并排在了 B 之前。理由：

1. **A 是护城河**（流式翻译 + 交付型正确性），B 是**行业基线**（B §四 自己定性："缺了就没有竞争力"，但"有"了也只是不输）。
2. **A 已完成一半**（第 0、1 步全完 + 第 2 步大半），**沉没成本已付**，收尾边际成本低于从头开 B。
3. **A 第 4 步会让 `translations` 数据量显著增长** → C 放 A 之后收益更大（§一）。
4. B 的 §四 自己给了"**观感上不输**"的止损立场，说明它**不急于抢先**。

---

## 附 6 · 各计划自己的"待拍板"清单（**开工前必须清掉**）

| 来源 | # | 议题 | 建议 |
| --- | --- | --- | --- |
| B §十二 | 1 | 第一刀：L0 还是 L1-a | **L0 先**（B 自己的建议，零风险） |
| B §十二 | 2 | 表格做到哪一步：只做 Tab 导航 vs 完整 widget | **只做 Tab 导航**（B §九 已把 widget 列为工期失控风险，允许降级） |
| B §十二 | 3 | 是否引入 `highlight.js` | **评估复用**——预览侧高亮是 Rust 做的，编辑器侧新引依赖会造成**两套高亮不一致** |
| A §八 | — | `SESSION_VERSION` 是否 bump | **不 bump**（A §9.4 已论证：字段都带 `#[serde(default)]`，bump 会丢用户草稿） |
| A §五 | 21 | 是否加 `review_model` 字段 | **加**（照 `lookup_model` 先例，成本两行） |
| 本文档 §八 | 1 | `rusqlite` vs `sqlx` | **`rusqlite`**（§三，`translate/` 是同步的） |
| 本文档 §八 | 3 | 热层预热条数 `N` | **1000（= `SHRINK_TO`）**，必须同源 |
| 本文档 §八 | 7 | `Settings` 是否也搬 SQLite | **不搬** |

---

## 附 7 · 跨计划的共同门禁（沿用项目惯例，三份计划都适用）

```powershell
# Rust 侧
cargo check --all-targets     # 期望 0 error 0 warning
cargo test                    # 基线：correctness 计划记录为 265 passed

# 前端
npx tsc --noEmit              # 期望 0 输出
npm test                      # 基线：18 文件 209 用例
```

**共同红线（三份计划反复重申的，合并列在这里）：**

1. **新守卫测试必须验证"旧代码会让它变红"**——A、B、C 三份都写了这条，别写成只会通过的测试。
2. **构建走 PowerShell**（B §七 红线 7：Bash 通道会静默失败）。
3. **快捷键单一真源是 `hotkeyRegistry.ts`**，新增必须让三方对齐测试通过。
4. **`data-ri` / `data-bi` 索引空间不得自建 walker**（A 红线 4）——C 的改造完全不碰它，是这三份里**唯一不触碰索引空间**的计划。
