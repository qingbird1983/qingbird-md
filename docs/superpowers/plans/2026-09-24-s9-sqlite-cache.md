# S9 · 翻译缓存接 SQLite 执行工单（C 计划 Step 1–3）

**Date:** 2026-09-24
**来源:** C 计划（`2026-09-18-sqlite-translation-cache.md`）Step 1–3 + 进度表排期。
**排期决策:** 经用户拍板 **跳过 B 计划（所见即所得 S7/S8）**，直接做 S9。依据：附 3 已确认「C 与 A/B 其他项技术独立，唯一交互是 A 第 4 步让 translations 变大、放 A 之后收益更大」——A 第 4 步（S5）已完成，前置满足，跳 B 不破坏任何依赖。**不碰 `data-bi`/`data-ri` 索引空间，前端零改动。**
**状态:** ⏸ 工单已落，**未开工**。三步各自独立可发布、可回滚。

> 本工单是 C 计划 §四–§七 的**执行切片**，架构论证、表设计、逐列理由以原文档为准，此处只列「本轮做哪几刀、接缝在哪、门禁怎么过」，不重复抄录。

---

## 一、范围与边界（本轮 = Step 1–3）

**做什么**：把 `Cache` 从「内存索引 + 驱逐 + 序列化 + 文件 IO」四合一，拆成「`CacheBackend` trait 划边界 → `SqliteCache`（热层 HashMap + rusqlite 持久层）→ 切流 + 一次性导入 + 保留旧 JSON」。三步分别对应 C 计划 §六 Step 1/2/3。

**不做什么**：
- **Step 4（FTS5 全文检索）不做**——是新能力，单独排期（C 计划 §六 Step 4、§八 6）。
- **不设置迁 SQLite、不重排 `%APPDATA%` 目录、不新建子目录**（§九 明确排除）。
- **不做任何前端改动**，`types/ipc.ts` 一行不碰（红线 8）。

**选型（已拍板，不再议）**：`rusqlite` + `bundled`（§三，`translate/` 是同步模块，引 `sqlx` 会拖整个引擎 async 化——明确拒绝）。

---

## 二、现状接缝（2026-09-24 逐项对仓库核实；含与 C 计划原文的两处漂移）

| 接缝 | C 计划原文 | **当前真实位置** | 备注 |
| --- | --- | --- | --- |
| 唯一持有者 | `lib.rs:53` | **`lib.rs:62`** `Cache::load(&storage::cache_path())`；字段 `lib.rs:47 Arc<Mutex<Cache>>` | Step 3 切流点 |
| 引擎读写 | `engine.rs:run(&req, &mut cache)` | **`translate/runner.rs:35` `run(..., cache: &mut Cache, ...)`**（命中 `:47` / 回写 `:119`） | ⚠️ **漂移**：不在 `engine.rs`，在 `runner.rs`。Step 1 改签名以此为准 |
| 划词查词 | `lookup.rs:296/:308` | **`lookup.rs:295` `cache_get_lookup(&Cache,…)` / `:302` `cache_set_lookup(&mut Cache,…)`** | 与译文共用同一 Cache，value 是 `WordLookupDTO` JSON |
| 落盘时机 | `bridge.rs:588` 收尾 save | **`bridge/worker.rs:233` `shared.save(&storage::cache_path())`**（`set` 本身不落盘） | 红线 4：SQLite 版沿用「命令层短锁内统一落盘」 |
| 空闲收缩 | `bridge.rs:51-63` | **`bridge/worker.rs:46` `shrink_if_idle`**，`:30 SHRINK_TO=1000` | 热层上限 N 与 SHRINK_TO 同源=1000（红线 10） |
| 清空命令 | `lib.rs:214` | **`commands/settings.rs:52`** + **`bridge/commands.rs:102`** 两处 `c.save(cache_path())` | Step 3 `clear` |
| 路径 | `cache_path()` | **`storage.rs:210`** | Step 2 并列加 `cache_db_path()` |
| `Cache` 本体 | 312 行 | **`cache.rs`（313 行）**，`save` 已走 `crate::atomic_write::write`（`:152`） | ⚠️ **F2 写截断隐患已顺带解决**（REL-3）；但 `load`/`from_json` 解析失败**仍静默当空缓存**（`cache.rs:129-134,137-144`）——这条仍待 SQLite 修 |

**`Cache::key` 三段制**（`cache.rs:37`）= 承重点，全流程一个字不改（红线 1）。既有 8 条契约测试（`cache.rs:164-313`）Step 1 结束必须一条不改全过。

---

## 三、三步批次（≈3 天，各自独立可回滚）

### 批次一 · Step 1：抽 `CacheBackend` trait（零行为变化，≈0.5 天）
1. `cache.rs` 定义 `trait CacheBackend: Send`（`get/set/shrink_to/clear/len` 见 §四），**保留 `Cache` 名字**（改名为 trait 实现，避免 130 处调用点动荡），trait 名单独起。
2. `runner.rs:35 run` 的 `&mut Cache` → `&mut dyn CacheBackend`（**用 `&mut dyn` 不用泛型**：`run` 内部是网络请求，动态派发开销可忽略，调用点不必泛型化）。
3. `lookup.rs:295/:302` 两函数签名同步改 trait 对象。
4. **红线**：`Cache::key` 一字不改。
5. 门禁：`cargo check --all-targets` 0/0 + `cargo test` 全过 + **`cache.rs` 既有测试体不动**（动了=行为漂了）。
6. **回滚**：单提交 `git revert`，无数据迁移。

### 批次二 · Step 2：落 `SqliteCache` + 双写对拍（**不切流**，生产仍走 JSON，≈1.5 天）
1. `cargo add rusqlite --features bundled`（**版本让它自己解析，别照抄 0.32**）。
2. 新建 `translate/cache_sqlite.rs`：`SqliteCache { hot: HashMap<String,String>, conn, seq, dirty }`；`open_or_create(path)` = 开库→设 pragma→`CREATE TABLE IF NOT EXISTS`→按 `ORDER BY seq DESC LIMIT 1000` 预热热层。`translate/mod.rs` 注册。
3. 表结构逐列照 C 计划 §五（`key/value/seq/accessed_at/created_at` + 两索引；`STRICT` 若 rusqlite 版本不支持则去掉，不影响正确性）。
4. `storage.rs` 加 `cache_db_path()`，与 `cache_path()` 并列，**不新建子目录**。
5. **对拍测试**（新增，纯 Rust、离线）：①同一 `set` 序列喂 `Cache`(JSON) 与 `SqliteCache`，逐条 `get` 相等；②`shrink_to` 后两者**保留集合相同**（最易错，红线 5）；③关连接重开→条目与顺序都在（**证明 F3 修好，JSON 版做不到**）；④库有 5000 条、热层 1000，未预热的 4000 条**仍可命中**（`get` miss 热层→回查 SQLite→塞热层）。
6. （可选推荐）进程级双写：环境变量 `QINGBIRD_CACHE_DUAL=1` → 同时写两库、**只读 JSON**，跑几天。**不做成用户可见设置**。
7. 门禁：新增测试全过 + 既有测试不动。
8. **回滚**：SQLite 文件是新增的，删掉即可，生产路径没变。

### 批次三 · Step 3：切流 + 一次性导入 + 保留旧文件（≈1 天）
1. `lib.rs:62` 切为 `SqliteCache::open_or_create(cache_db_path())`。
2. `migrate_json_to_sqlite`：启动时若 db 不存在/表空 **且** `qingbird-cache.json` 存在 → 批量插入、**一个事务**提交；`seq` 按 `HashMap` 迭代序赋（**已知顺序损失，代码注释写明，不得声称"无损迁移"**——红线 7）；成功后旧 JSON **不删**，重命名 `qingbird-cache.json.imported-<时间戳>`（红线 6，回滚依赖它）。
3. `set` 保持「只改热层+标脏、不落盘」；由 `worker.rs:233` 那个已有收尾点调 `flush()` 批量 `INSERT OR REPLACE`（**一个事务**）——**写盘时机与今天一致**（红线 4）。
4. `shrink_to`：`DELETE … WHERE key IN (SELECT key … ORDER BY seq ASC LIMIT N)` + 同逻辑动作收缩热层；`shrink_if_idle` 判据（空闲 10 分钟 + >1000）不变。
5. `clear`：`DELETE FROM translation_cache` + 清热层；**`VACUUM` 不在命令路径同步调**（红线 9）。
6. **回滚**：`lib.rs` 那行改回 `Cache::load(cache_path())`，`qingbird-cache.json.imported-*` 改回原名——旧文件在，是**真回滚**。

---

## 四、红线（全部并入项目红线，抄自 C 计划 §七）

1. `Cache::key` 三段制一个字不改。
2. `translate/` 保持同步——**看到 `async` 进 `translate/` 就是走错了**。
3. `get` 保持 `&self` 且不写库；LRU 年龄只在 `set` 更新。
4. 落盘时机不得改变（`set` 不落盘、命令层短锁统一落盘）。
5. `SqliteCache` 与旧 `Cache` 的 `shrink_to` 保留集合**测试里逐条相等**。
6. 旧 `qingbird-cache.json` 迁移后保留为 `.imported-<ts>`，**不得删除**。
7. JSON→SQLite 顺序损失**已知且写进注释**，**不得声称无损**。
8. 缓存库**不进 IPC 契约**，`types/ipc.ts` 零改动。
9. `VACUUM` 不在命令路径同步调。
10. 热层上限 `N` 与 `SHRINK_TO` 同源（都 1000）。

---

## 五、门禁（沿用项目惯例，构建走 PowerShell）

```powershell
cd F:\AIwork\qingbird-md-rust\src-tauri
cargo check --all-targets   # 期望 0 error 0 warning
cargo test                  # 基线 377（S6 后），每步只涨不跌；新守卫必须"旧代码会变红"
cd F:\AIwork\qingbird-md-rust
npx tsc --noEmit            # 期望 0（本计划前端零改动，应保持不动）
npm test                    # 基线 354，应保持不动
```

> ⚠️ **`rusqlite` + `bundled` 会编译一份 SQLite C 源码**；`profile.release` 已开 `lto=true`+`codegen-units=1`，**release 链接时间变长**（可接受，`[profile.dev]` 没开 lto，日常迭代不受影响）。开工前按 C 计划 §十手动备份一次 `qingbird-cache.json`。

---

## 六、待办状态与验收

- 三步做完 = S9 完成，A 计划仅剩第 5 步 23（另立）。B 计划（S7/S8/S10）按用户决策**整体推后**，不在本轮。
- 真机验收：S9 是纯后端，无 UI 观感项；验收=四道门禁全绿 + 双写对拍测试 + 真实使用下「切流后译文缓存命中、重启后 FIFO 顺序真实、旧 JSON 保留为 `.imported-*`」。完成后 `regression-checklist.md` 补「S9 · SQLite 缓存」节 + 进度表 C 行翻正。
- **对拍观察期**（Step 2 的 `QINGBIRD_CACHE_DUAL` 跑几天）可与后续并行，不阻塞切流。
