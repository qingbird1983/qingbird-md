# 翻译打字机"前几行有效果、后面一次性回填"问题排查记录

> 状态：**未解决**（2026-09-15 第三/四轮修复后用户实测仍复现）
> 优先级：高（用户连续四轮验收同一效果未达标）

## 1. 用户现象（四轮反馈口径稳定）

- 点翻译后，**只有前面 3-5 行有逐字打字效果**，然后停住不动；
- 等翻译进度条跑完 100%，**整片一次性回填**（看不到打字机吐字）；
- 用户参考小软件 `F:\AI data\work\qingniao`（Rust+windui）：点翻译后从头逐字吐字、一行行往下走，全部打完才收尾；
- 用户第 4 轮反馈："没有改变，基本还是前面几行有效果，后面等进度条走完一下子回填。不过比之前观感上顺滑了点。"

## 2. 已做修复（三轮，均全绿验证但未解决核心现象）

| 轮次 | 修复内容 | 验证 | 结果 |
| --- | --- | --- | --- |
| 1 | 真流式（EngineEvent::Streaming、前端灰字直写、done 不整树回填） | 全绿 | 用户：只有前 3-5 行有效果 |
| 2 | 打字单元 run → 整段（collect_text_runs_windowed_blocks、块级 reveal、块间零停顿连锁） | tsc 0 / vitest 194 / cargo 252 | 用户：仍前几行打字后停、done 一次性回填 |
| 3（本次） | **Failed 事件转发**（bridge.rs 不再丢弃 EngineEvent::Failed，带原文 `failed:true` 转发；前端 failed run 原文回退、跳过打字、照常放行） | tsc 0 / vitest 198 / cargo 全过 | 用户：**仍复现**，但"观感上顺滑了点" |

## 3. 已确认机制（模拟测试精确复现）

集成模拟 `src/lib/blockFlow.sim.test.ts`（真实 typewriter + reveal + 复制 store 组装逻辑）：

- **缺 1 个 run 的 partial → 其后全部块卡 pending、reveal 队列只进缺失前的块、其余等 done 兜底一次性上屏** —— 精确复现用户现象；
- 乱序 partial 全到齐 → 30 块全部进队并打完，无卡死；
- failed 事件补齐（原文回退）→ 照常放行、全块打完（修复后回归测试）。

**结论：前端 typewriter/reveal/组装逻辑本身正确（全 partial 到达时无卡死）。卡停 = 某个 run 的 partial 始终没到。**

## 4. 本轮修复为何无效 → 关键推论

引擎侧保证：所有 Ok 单元都会 emit Unit；所有 Err 单元都会 emit Failed（此前被 bridge 丢弃，本轮已转发）。**Failed 转发修复后用户仍复现，说明缺失的 partial 不是（主要）来自引擎失败**——还有别的来源。

"比之前顺滑了点"的合理解释：failed 转发确实消除了部分失败场景的卡死，但核心缺失另有来源。

## 5. 下次排查方向（按嫌疑排序）

1. **`src/lib/ipc.ts` 的 `api.listenPartial` 事件注册实现（尚未读取！）**——检查 Tauri 事件监听是否存在丢失/节流/批量拉取间隙；`invoke` 与 `listen` 的初始化时序。
2. **Tauri 跨线程 emit 顺序**：worker 线程 emit Unit/Progress（`translation-partial`）与 bridge 线程 emit Done（`translation-done`）竞争，Done 可能先于部分 partial 到达前端 → `handleDone` 立即兜底回填。前端可在 handlePartial 里打日志统计"收到的 partial 数 vs done 载荷条数"验证。
3. **引擎真实运行时是否对每个 run 都发了 partial**——加运行时计数（如 eprintln 或前端事件计数），确认是"没发"还是"发了没收到"。这是分叉点：前者查引擎，后者查通道。
4. **用户实际场景未确认**：点的是「译文」（视口窗口 scope=viewport，只译窗口内，done 走 mergeTranslations + scheduleCanonicalRebuild 400ms 重建）还是「翻译全文」（win=null，done 走 finalizeAfterReveal）？两分支收口路径不同。**下次先问用户。**
5. **单单元裸发 Streaming 路径**（超长 run 拆分、单单元批次）：前端 `streamed` 直写灰字。若大量单单元批次，`streamedBlock` 导致整块 instant 定格（不走打字动画），观感"没打字"。
6. **批次间隙（慢模型）**：8 units/batch + 6 路并发，慢模型下批次完成间隙 10-30s，打字"一阵一阵"；qingniao 是 3 路并发 + 更小批次。用户"顺滑了点"可能与并发/批次行为有关。可对比：把 `units_per_batch` 降到 4、并发降到 3（对齐 qingniao）实测。
7. **前端等位超时自动放行**的设计讨论（破坏文档序，风险高，慎用）：仅在确认"某 run 永远等不到"时作为最后手段。

## 6. 关键文件与事件链路（下次直接定位用）

- 事件链路：`EngineEvent::{Unit, Streaming, Progress, Failed}` → bridge `translation-partial`（含 streaming/failed 布尔）→ 前端 `handlePartial`；
- `TranslateStart::Started { gen, first_index, indices, indices_blocks }`（indices_blocks 与 indices 等长，run→块映射）；
- 引擎：`src-tauri\src\translate\engine.rs`（run() 177-265、process_batch 276-418、commit 闭包 222-235）；
- 解码器：`src-tauri\src\translate\batch.rs`（BatchDecoder::next_unit 176-235，越界 slot 静默丢弃、retry missing 补齐）；
- 前端注册：`src\lib\ipc.ts`（**listenPartial 实现尚未读**）；
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
