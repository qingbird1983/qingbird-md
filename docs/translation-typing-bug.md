# 翻译打字机"前几行有效果、后面一次性回填"问题排查记录

> 状态：**根因已定位并修复（第 5 轮，2026-09-16）——待用户实测确认**
> 优先级：高（用户连续四轮验收同一效果未达标；本轮为根因修复，非症状缓解）

## 1. 用户现象（四轮反馈口径稳定）

- 点翻译后，**只有前面 3-5 行有逐字打字效果**，然后停住不动；
- 等翻译进度条跑完 100%，**整片一次性回填**（看不到打字机吐字）；
- 用户参考小软件 `F:\AI data\work\qingniao`（Rust+windui）：点翻译后从头逐字吐字、一行行往下走，全部打完才收尾；
- 用户第 4 轮反馈："没有改变，基本还是前面几行有效果，后面等进度条走完一下子回填。不过比之前观感上顺滑了点。"
- **（2026-09-15 用户确认）本项目界面只有「译文」按钮，没有「翻译全文」按钮**——用户实际使用的就是「译文」（视口窗口 scope=viewport）路径，排查只走窗口分支，不走全文分支。

## 2. 已做修复（四轮，前三轮全绿验证但未解决核心现象；第 4 轮为根因修复）

| 轮次 | 修复内容 | 验证 | 结果 |
| --- | --- | --- | --- |
| 1 | 真流式（EngineEvent::Streaming、前端灰字直写、done 不整树回填） | 全绿 | 用户：只有前 3-5 行有效果 |
| 2 | 打字单元 run → 整段（collect_text_runs_windowed_blocks、块级 reveal、块间零停顿连锁） | tsc 0 / vitest 194 / cargo 252 | 用户：仍前几行打字后停、done 一次性回填 |
| 3（2026-09-15） | **Failed 事件转发**（bridge.rs 不再丢弃 EngineEvent::Failed，带原文 `failed:true` 转发；前端 failed run 原文回退、跳过打字、照常放行） | tsc 0 / vitest 198 / cargo 全过 | 用户：**仍复现**，但"观感上顺滑了点" |
| 4（本次 2026-09-16） | **根因修复：Started 响应竞态丢事件**（见 §8）——早期事件缓冲（Started 落定后按 gen 回放）+ invoke 在飞闩 + windowed done 兜底排空（drainPendingToDom）+ 缺失诊断 | tsc 0 / vitest 204 / cargo 252 | 待用户实测 |

## 3. 已确认机制（模拟测试精确复现）

集成模拟 `src/lib/blockFlow.sim.test.ts`（真实 typewriter + reveal + 复制 store 组装逻辑）：

- **缺 1 个 run 的 partial → 其后全部块卡 pending、reveal 队列只进缺失前的块、其余等 done 兜底一次性上屏** —— 精确复现用户现象；
- 乱序 partial 全到齐 → 30 块全部进队并打完，无卡死；
- failed 事件补齐（原文回退）→ 照常放行、全块打完（修复后回归测试）。

**结论：前端 typewriter/reveal/组装逻辑本身正确（全 partial 到达时无卡死）。卡停 = 某个 run 的 partial 始终没到。**

## 4. 本轮修复为何无效 → 关键推论

引擎侧保证：所有 Ok 单元都会 emit Unit；所有 Err 单元都会 emit Failed（此前被 bridge 丢弃，本轮已转发）。**Failed 转发修复后用户仍复现，说明缺失的 partial 不是（主要）来自引擎失败**——还有别的来源。

"比之前顺滑了点"的合理解释：failed 转发确实消除了部分失败场景的卡死，但核心缺失另有来源。

## 5. 排查结论（第 5 轮逐项核查，2026-09-16）

1. **`src/lib/ipc.ts` 的 `api.listenPartial`**——已核查：标准 Tauri `listen`，App.tsx:162 启动即注册，无丢失/节流/初始化时序问题。**排除**。
2. **Tauri 跨线程 emit 顺序（Done 先于 partial）**——已核查：Done 与全部 Unit/Failed/Progress 均由**同一 worker 线程**按序 emit（`run()` 线程 scope join 全部 commit 之后才发 Done），同线程发射经事件通道 FIFO 送达，Done 不可能越过本轮的 partial。**排除**。
3. **引擎是否对每个 run 都发 partial**——已核查 `engine.rs run()`：每个单元必然 `commit`（Ok→Unit / Err→Failed），无静默缺发路径；唯一不发射路径是 worker panic（此时 Done 也不会到，与本现象不符）。**排除"引擎没发"**；前端已补运行时诊断（done 时对比 seq 与已收事件，缺失非空即 console.warn 清单），下次实测可直接在 DevTools 确认"发了但前端没收到"的具体 run。
4. **scheduleCanonicalRebuild / 窗口分支**——已核查：重建受 `revealIdle` 守卫（打字未完会重排期）；"一次性回填"是**症状**（缺失 run 的块在重建时才被整树补上），不是原因。已加 `drainPendingToDom` 兜底：done 时缺失 run 直接从 done 载荷定格上屏，不再等整树重建。
5. **单单元裸发 Streaming 路径**——已核查：单单元批的 Unit 必达（stream 结束 commit），无系统缺发。**保留观察**（观感而非卡死）。
6. **批次间隙（慢模型）**——保留观察（UX 感知，非卡停根因；可后续对齐 qingniao 3 并发小批次对比）。
7. **前端等位超时自动放行**——根因已修，**不再需要**（破坏文档序的风险方案不启用）。

**根因定位见 §8。**

## 6. 关键文件与事件链路（下次直接定位用）

- 事件链路：`EngineEvent::{Unit, Streaming, Progress, Failed}` → bridge `translation-partial`（含 streaming/failed 布尔）→ 前端 `handlePartial`；
- `TranslateStart::Started { gen, first_index, indices, indices_blocks }`（indices_blocks 与 indices 等长，run→块映射）；
- 引擎：`src-tauri\src\translate\engine.rs`（run() 177-265、process_batch 276-418、commit 闭包 222-235）；
- 解码器：`src-tauri\src\translate\batch.rs`（BatchDecoder::next_unit 176-235，越界 slot 静默丢弃、retry missing 补齐）；
- 前端注册：`src\lib\ipc.ts`（已核查：标准 listen，App 启动即注册，无丢失/节流）；
- store 组装/兜底：`src\stores\useTranslationStore.ts`（handlePartial 281-332、finalizeAfterReveal 453-497、windowed done 405-433）；
- 打字机：`src\lib\typewriter.ts`；reveal：`src\lib\reveal.ts`；
- 复现测试：`src\lib\blockFlow.sim.test.ts`（可扩展"done 早于部分 partial"变体）。

## 7. 本次提交内容（2026-09-15）

- bridge.rs：Failed 事件带原文转发（`failed:true`）+ wire 测试；
- types/ipc.ts：`TranslationPartialPayload.failed?`；
- reveal.ts：`RevealRun.failed` + tick 跳过失败 run 打字；
- stores/useTranslationStore.ts：handlePartial failed 分支 + failedRuns 集合；
- reveal.test.ts：failed run 跳过打字测试；blockFlow.sim.test.ts：failed 补齐无卡死回归。

验证：`npx tsc --noEmit` 0 错；`npx vitest run` 198/198；`cargo test --lib` 全过。


## 8. 第 5 轮根因定位（2026-09-16）：Started 响应竞态丢事件

**根因**：`translate_document` 是**同步**命令——`spawn_translation` 起 worker 后立即返回 `Started`（bridge.rs:398-412）。worker 起跑瞬间先做 cache 命中扫荡，`from_cache:true` 的 partial 在毫秒级发出，**几乎必然先于 Started 的 invoke 响应到达前端**（invoke 响应要经历完整 IPC 往返；worker 的 cache 扫荡在 spawn 后微秒级完成）。此时前端 `st.gen` 还是上一轮、`status` 还是 idle，`handlePartial` 的 `p.gen !== st.gen || st.status !== "running"` 护栏把这些事件**全部丢弃**（该护栏自 c7f01c2 首个 partial 消费提交起就存在，四轮修复均未触碰）。

被丢弃的 run 在打字机放行序列 `seq` 中永远缺位 → `seq[pos]` 等不到 → **其后所有 run 永久 pending**（typewriter.ts 只放行连续前缀）→ 缺失点之前的块打完即"停住"，缺失点之后的块永不进 reveal 队列；done 到达 → merge + `scheduleCanonicalRebuild` 整树重建 → "一次性回填"。

**与用户现象逐条对应**：
- 反复实测同一文档 ⇒ 窗口前段通常已有缓存（前几轮翻译已落盘）⇒ 这些块的 cache 命中 partial 恰在竞态窗口被丢 ⇒ "前面 3-5 行打完就停住"（停住点 = 第一个缓存块的位置）；
- 第 3 轮后"比之前顺滑了点" = Failed 转发消除了引擎失败型缺位，但缓存竞态型缺位仍在；
- 第 1 轮起即复现：四轮修复全部在"收到事件之后"的逻辑上打补丁，没动"事件在 Started 落定前到达被丢"的入口。

**修复（第 5 轮，本次提交）**：
1. **早期事件缓冲**（根因修复）：新增 `src/lib/earlyPartial.ts`（纯函数、按 gen 键控：push/take）。`handlePartial` gen 失配且空闲时入缓冲；`translateDocument` Started 落定（`set({gen,status:"running"})`）后按 `r.gen` 取回回放。缓存命中块照常走"整块 instant"（不打字，qingniao 语义）。
2. **invoke 在飞闩**：`translateDocument` 双发防护（handleDone 自动续跑与 setViewport 的 idle 竞态）——第二发被后端 `compare_exchange` 拒绝时，catch 若强置 error 会把在途 run 的后续 partial 全挡在 status 护栏外 → 整轮卡死；现 catch 仅在本轮 gen 未前跳时收口 error。
3. **windowed done 兜底排空**：新增 `drainPendingToDom(d)`（从 done 载荷把 typewriter pending / 块组装残留 / 流式直显 run 定格上屏），窗口化分支与全文分支（finalizeAfterReveal）共用——即使事件真丢失，done 时补缺，不再等整树重建一次性回填。
4. **运行时诊断**：done 时对比 `seq` 与已收事件集合（receivedRuns），缺失非空时 `console.warn` 输出缺失 run 清单——下一轮实测可直接在 DevTools 确认"发了但前端没收到"的具体 run，若清单为空即事件通道问题，反之即前端丢弃点。

验证：`npx tsc --noEmit` 0 错；`npx vitest run` 204/204（新增 `earlyPartial.test.ts` 6 例）；`cargo test --lib` 252 全过。

**遗留观察项**：批次间隙/并发配置（§5.6）、单单元裸发观感（§5.5）——非卡停根因，用户验收通过后如仍有"一阵一阵"可再对齐 qingniao 参数。
