# 源码文件拆分记录与拆分计划

**Date:** 2026-09-16
**触发:** 用户指出「这个扩展要叠很多功能，要先认真数一下源码行数。对于行数太多的/会爆的，该拆分了就拆分，不要怕麻烦；或者留个记录，以后单独开一个拆分任务计划。」
**定位:** 这份文档是**债的记录 + 拆分处方**。拆分本身按 P0/P1/P2 分批，每批独立提交、独立过门禁。

---

## 一、量测口径（复测时照这个来，别换口径）

**统一用 `.Count`**（读成数组后的元素个数）。不要混用 `Measure-Object -Line`——两者对"末行有无换行"的处理不同，同一个文件会差 5%（例：`html.rs` 1049 vs 1107），混口径的表没法用。

```
# Rust：生产/内联测试 分开数（以第一个 #[cfg(test)] 行为界）
Get-ChildItem -Path 'src-tauri\src' -Recurse -Filter *.rs | ForEach-Object {
  $lines = Get-Content -LiteralPath $_.FullName
  $tot = $lines.Count
  $ti = 0
  for ($i = 0; $i -lt $tot; $i++) { if ($lines[$i] -match '^#\[cfg\(test\)\]') { $ti = $i + 1; break } }
  if ($ti -eq 0) { $prod = $tot; $test = 0 } else { $prod = $ti - 1; $test = $tot - $ti + 1 }
  [pscustomobject]@{ prod=$prod; tot=$tot; test=$test; f=$_.FullName }
} | Sort-Object prod -Descending

# 前端：测试是独立 *.test.ts(x) 文件，按文件名区分即可
```

**总量基线（2026-09-16 实测；P0 拆分完成后最终复测）**

| 树 | 文件数 | 生产行 | 测试行 | 合计 |
| --- | --- | --- | --- | --- |
| `src-tauri/src`（Rust） | 40 | 8,165 | 4,065 | 12,230 |
| `src`（TS/TSX/CSS） | 83 | 15,664 | 2,311 | 17,975 |
| **合计** | **123** | **23,829** | **6,376** | **30,205** |

> **⚠️ 口径细化（P0 之后必须这么数）**：`*_tests.rs` 这种**整文件即测试**的兄弟文件
> 没有 `#[cfg(test)]` 行，会被上面的规则误算成生产。**文件名以 `_tests.rs` 结尾的，
> 整体计入测试行。** 上一版就是按旧口径把 `html_tests.rs` 的 639 行算进了生产，
> 导致生产虚高 639 —— 下次复测记得先排除它。

> **P0 拆分带来的变化**：文件数 37 → **40**（新增 `html_tests.rs` / `policy.rs` / `packing.rs`）。
> 生产 8,135 → 8,165（+30：模块声明、`pub use` 转发、新文件头注释），测试 4,052 → 4,065（+13）。
> 净增 43 行，全部是拆分本身的开销——**没有一行是逻辑改动**。

**总量复测快照（2026-09-20，P2 批次二·Rust 拆分完成后）**

> 工具：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File` 跑第一节原版脚本
> （`.Count` 口径 + `*_tests.rs` 整体计测试规则），全树逐一计数后 `Measure-Object` 汇总。
> **Rust**：文件数 40 → **75**，生产 8,165 → **9,750**，测试 4,065 → **5,944**，
> 合计 12,230 → **15,694**；**最大生产文件 = `capture/window/mod.rs` 371 行**（全树 ≤ 400 达标）。
> 文件数净变化以 `git diff --name-status eed0304 HEAD -- src-tauri/src` 实测为凭：
> 新增 40、删除 5——含 P2-7 九文件拆分的目录化（bridge/ commands/ model/ html/ cmark/
> hibernate/ providers/ translate/{events,runner} capture/window/）、基线后功能批次的
> `check.rs` / `export.rs`（翻译正确性）与 P1-6 的 `atomic_write.rs`。
> **前端**：文件数 83 → **122**（P1-2 CSS 十三域拆分 + 批次一 MenuPanes/createDialogHost 等），
> 生产 15,664 → **17,654**，测试 2,311 → **4,752**，合计 17,975 → **22,406**。
> 两树行数净增含 P0/P1/批次一/批次二的功能与测试增量，非拆分开销（拆分单元各自的
> 纯提取审计见《审查与整改》执行记录）。

**前端复测快照（2026-09-20，P2 批次三·前端拆分完成后）**

> 工具：`powershell.exe -NoProfile` + `Get-Content -Encoding UTF8` 后取 `.Count`
> （生产 = ts/tsx，测试 = `*.test.ts(x)` 独立文件，CSS 单列——规则同第一节）。
> **⚠️ 工具口径修正（本批实测发现）**：Windows PowerShell 5.1 的 `Get-Content`
> 默认按 ANSI 解码 UTF-8 无 BOM 的中文文件，中文注释的字节对会吞掉行尾换行，
> 行数**系统性偏小**（同一文件默认口径 445 vs UTF8 口径 492，后者与 `wc -l` 一致）。
> 前端复测自本批起一律加 `-Encoding UTF8`，其余口径不变。
> **前端**：文件数 122 → **157**（批次三新增 37 个拆分产物 − 删除 paletteSeeds.ts 1，净 +36），
> 生产（ts/tsx + css）17,654 → **18,864**（ts/tsx 13,407 + CSS 5,457），
> 测试 4,752 → **4,999**，合计 22,406 → **23,863**。
> 行数净增含功能与测试增量，非拆分开销；拆分产物的纯提取审计见《审查与整改》
> 「执行记录（2026-09-20，P2 批次三：前端拆分）」。

---

## 二、阈值（拆分判定线）

| 对象 | 线 | 超了怎么办 |
| --- | --- | --- |
| Rust / TS **单模块生产代码** | **≤ 400 行** | 按职责切子模块 |
| **单文件总量**（含内联测试） | **≤ 700 行** | 先把内联测试挪出去，再判生产是否仍超 |
| **内联测试块** | **≤ 300 行** | 用 `#[cfg(test)] #[path = "xxx_tests.rs"] mod tests;` 挪到同目录兄弟文件（私有项仍可见，能力不丢） |
| **CSS 单文件** | **≤ 800 行** | 按"关注面"切分文件，**用显式 `@import` 列表保序** |
| 单 React 组件 | ≤ 400 行 | 拆子组件 + 抽 hook |

> **为什么要分「生产」和「总量」两条线**：`html.rs` 总量 1107 里 548 行是内联测试，生产只有 559。把测试挪走就能降到 559，**不必动生产代码**——这是最便宜的一刀，先做这个。

---

## 三、现状：超标清单（按生产行数排序）

### 3.1 Rust

**复测表（2026-09-20，P2 批次二拆分后；工具与汇总见第一节复测快照。原 2026-09-16 表中被拆
文件的旧行数已随行标注）**

| 生产 | 总量 | 内联测试 | 文件 | 超标项 |
| --- | --- | --- | --- | --- |
| **371** | 371 | 0 | `capture/window/mod.rs` | —（P2-7k2 拆后全树最大；原 `capture/window.rs` 751/781 已撤） |
| 370 | **748** | **378** | `translate/http.rs` | 总量 ✗ 内联测试 ✗（**未登记·新发现**；P1-4/P1-8 加固增厚所致，存量非本批引入） |
| 367 | 632 | 239 | `translate/lookup.rs` | — |
| 321 | 598 | 277 | `translate/runner.rs` | ✅ **P2-7j 已达标**（执行器；`engine.rs` 留 40/105/65，原 366/678） |
| 305 | 488 | 183 | `markdown/units.rs` | — |
| 295 | 298 | 3 | `markdown/html.rs` | ✅ **P2-7f 已达标**（原 559/562，生产拆出 html/{inline,code,footnote}） |
| 285 | 415 | 130 | `bridge/worker.rs` | ✅ **P2-7a 已达标**（原 `bridge.rs` 559/886 已撤） |
| 283 | 475 | 192 | `translate/openai.rs` | — |
| 276 | 308 | 32 | `bridge/commands.rs` | ✅ P2-7a |
| 271 | 477 | 206 | `markdown/model/parse.rs` | ✅ **P2-7e 已达标**（原 `model.rs` 599/807 已撤） |
| 268 | 505 | 163 | `storage.rs` | — |
| 267 | 421 | 154 | `markdown/cmark/writer.rs` | ✅ **P2-7g 已达标**（原 `cmark.rs` 426/621 已撤） |
| 260 | 333 | 73 | `capture/window/pixels.rs` | ✅ P2-7k2 |
| 254 | 612 | **358** | `translate/export.rs` | 内联测试 ✗（**未登记·新发现**；BUG-1 回归增厚所致，存量非本批引入） |
| 254 | 411 | 157 | `workspace.rs` | — |
| 252 | 270 | 18 | `window_boot.rs` | ✅ **P2-7d 已达标**（新建；原 `lib.rs` 812/999） |
| 238 | 332 | 94 | `markdown/model/inlines.rs` | ✅ P2-7e |
| 231 | 409 | 94 | `translate/batch.rs` | — |
| 204 | 263 | 59 | `translate/providers/signed.rs` | ✅ **P2-7i 已达标**（原 `providers.rs` 397/525 已撤） |
| 195 | 401 | 206 | `translate/check.rs` | — |
| 193 | 275 | 82 | `commands/workspace_ops.rs` | ✅ P2-7d |
| 0 | 639 | 639 | `markdown/html_tests.rs` | 纯测试文件（生产 0） |

其余 53 个文件生产均 < 190 行，健康（含 P0-1 新建的 `policy.rs` 169 / `packing.rs` 145、
P2-7h 拆后的 `hibernate/{state 136, session 125, window 72, handoff 50}`）。

> **P2 批次二之后还剩什么**：生产超线（> 400）的 Rust 文件**清零**——9-16 清单上的
> `lib.rs` 812 / `capture/window.rs` 751 / `model.rs` 599 / `bridge.rs` 559 / `hibernate.rs` 429
> 五个全部拆完，`providers.rs` / `engine.rs` / `html.rs` / `cmark.rs` 同批归位。
> 剩余债集中在**总量 / 内联测试块**两线：`http.rs`（总量 748、测试块 378）与
> `export.rs`（测试块 358）——均为存量（P1-4/P1-8 加固与 BUG-1 回归各自增厚测试），
> 非本批拆分引入；按第二节「先把内联测试挪出去，再判生产」的最便宜一刀处理即可，
> 留待后续批次。前端拆分（P2-8）未动，见 §3.2。

### 3.2 前端

**复测表（2026-09-20，P2 批次三前端拆分后；口径与工具见第一节前端复测快照。
原 2026-09-16 清单中七个超标文件的旧行数已随行标注；另收批次三新拆的 App.tsx）**

| 现行数 | 原行数 | 文件 | 状态 |
| --- | --- | --- | --- |
| **59** | 3590 | `src/styles/global.css` | ✅ **P1-2 已达标**（manifest 59 行 + 13 个 ≤800 行域文件） |
| 455 | 1260 | `components/SettingsModal.tsx` | ✅ **P2-8c 拆分完成**（壳留导航搜索与跨页持久状态；455 微超 400 55 行＝处方明令不改的 Bar/SwitchRow 63 行与逐字头注释，已报备。拆出 settings/ 五 Tab 45~373 + 三 hook 69~264，全部达标） |
| 318 | 836 | `stores/useTranslationStore.ts` | ✅ **P2-8a 拆分完成**（壳 318 达标；translationStream.ts 492 微超 400＝处理器体+注释不可压缩、已报备；lookupStream.ts 147） |
| 166 | 807 | `components/Sidebar.tsx` | ✅ **P2-8d 拆分完成**（sidebar/ 四件 71~179 + useTreeMenus.tsx 312 + clipboard.ts 25，全部达标） |
| 188 | 715 | `components/PreviewView.tsx` | ✅ **P2-8e 拆分完成**（四 hook 83~216 + previewInject.ts 104，全部达标） |
| 435 | 666 | `stores/useDocStore.ts` | ✅ **P2-8b 拆分完成**（docTabs.ts 205 + sessionRestore.ts 147 达标；壳 435 微超 400 35 行＝21 个动作编排体不可压缩，已报备） |
| **640** | 640 | `stores/useWorkspaceStore.ts` | ✗ **未拆（遗留）**——批次三七个单元未含此项，留后续批次 |
| 539 | 539 | `styles/markdown.css` | —（CSS 线 ≤800 内，未动） |
| 已撤 | 486 | `lib/paletteSeeds.ts` | ✅ **P2-8g 拆分完成**（原文件删除，目录化为 paletteCss.ts 57 + paletteSeeds/{index 117, 六种子各 59}，全部达标；消费方经 `lib/paletteSeeds` 原路径零改动） |
| 264 | —（原 520，未超标） | `src/App.tsx` | ✅ **P2-8f 顺带拆分**（未超标但接近线；hooks 三件 17~105 + Panel 两件 49~64，壳留 refs 接线与 JSX） |

复测后生产（ts/tsx）超 400 的剩 4 个：`SettingsModal.tsx` 455 / `translationStream.ts` 492 /
`useDocStore.ts` 435——三者均为批次三逐项报备的偏差（超限部分为处方明令不改的复用件、
逐字头注释或不可压缩的编排体，拆分本体各自达标）；`useWorkspaceStore.ts` 640 为**唯一
未拆遗留**。前端**内联测试仍为 0**（全是独立 `*.test.ts(x)`，36 文件 4,999 行）。

---

## 四、拆分方案（按"是否挡在 2026-09-16 那五步的路上"排序）

### P0 — 立刻拆（挡在眼下这几步的路上）

#### P0-1 `translate/engine.rs`（1107 / 生产 634 / 测试 473）

**为什么是 P0**：Step 0（本 patch）正在改它；Step 1「方向参数化」的改动面**全在它里面**；Step 4「AI 核查」还会再回来（`EngineConfig` 复用）。

按**职责**切三块，边界天然：

| 新文件 | 迁入内容 | 说明 |
| --- | --- | --- |
| `translate/policy.rs` | `TargetLang` + `tag()` + `prompt_name()`、`has_cjk`、`needs_translation`、`UNTRUSTED_CONTEXT_RULE`、`system_prompt`、`cache_variant`、`PROMPT_VERSION` | **「怎么判定、怎么措辞、缓存怎么版本化」**——Step 1 唯一要碰的文件。它自己就该有一个"方向"的家 |
| `translate/packing.rs` | `EngineConfig` + `for_provider`、`pack_batches`、`order_batches`、`split_text`（含分片测试） | **「怎么切批、怎么排批」**——纯函数，零副作用，最好测 |
| `translate/engine.rs`（留） | `EngineEvent`、`EngineRequest`、`run`、`process_batch`、单串裸发路径 | **「怎么跑」**——只剩执行编排 |

**纪律**：`policy` / `packing` 的项原本是 `pub`，迁走后仍在 `translate` 模块内，可见性不变；`engine.rs` 用 `pub use` 把常用项再导出一次（`translate::engine::TargetLang` 这类旧路径**保留**），这样 `bridge.rs` / `units.rs` / `html.rs` 的 `use` 路径**一行都不用改**，拆分 diff 里出现的全是 `mod`/`use`。

#### P0-2 `markdown/html.rs` —— 先只做**测试外迁**（1201 → 约 559）

**为什么是 P0**：Step 2「译文另存为」要复用它的 walker；Step 3 的 issue 跳转要吃它写的 `data-ri` / `data-bi`。

**第一步（零风险，先做）**：642 行内联测试挪到 `markdown/html_tests.rs`，html.rs 里留：

```rust
#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;
```

私有项照旧可见（同 crate 同模块的子模块），测试能力一点不丢，html.rs 立刻降到 ~559。

**第二步（P1）**：生产 559 再按「块渲染 / 行内渲染 / 代码高亮包装 / 脚注」分。
⚠️ **硬约束**：`render_top_blocks` 是**单次遍历**同时推进 `sub_counter` / `bi_counter` / `ref_state`，拆成"先扫一遍再渲染"会**改变 walk 顺序 → 索引空间错位 → 译文贴错块**。所以只能**按"给谁 write"切函数**（把 write 目标变成子模块函数），**绝不能按"渲染阶段"切遍历轮次**。

### P1 — 紧随其后（下一步就要碰）

| # | 文件 | 行数 | 谁要碰它 | 拆法 |
| --- | --- | --- | --- | --- |
| P1-1 | `stores/useTranslationStore.ts` | 836 | Step 1 方向参数化、Step 3 核查面板 | `translateRun`（跑批/进度/打字机） / `translateSelection`（划词） / `reveal`（打字机节奏） 三块 |
| P1-2 | `src/styles/global.css` | 3590 | §9 要往里加 `.panel-slot` / `.panel-handle` / 状态栏 AI 钮 | 按关注面切：`layout-shell`（网格/栏） / `panels`（侧栏·大纲·拖宽条） / `editor`（工具栏/标签条） / `preview` / `overlays`（弹窗/菜单/toast）；**入口用一个 `@import` 列表固定顺序** |
| P1-3 | `stores/useDocStore.ts` | 666 | Step 1 的 `switchMode` 同级 reset | 快照恢复 / 文档生命周期 / 模式切换 三块 |
| P1-4 | `components/PreviewView.tsx` | 715 | Step 3 issue 跳转 + 锁窗 | 渲染与 patch 应用 / 分栏联动与滚动 / 选区与浮窗 三块 |
| P1-5 | `bridge.rs` | 886 / 生产 559 | Step 1（方向入参）、Step 2（导出命令） | 命令层（`#[tauri::command]`）/ 载荷组装（html payload、cached_done_evt）/ 事件发射 三块 |
| P1-6 | `markdown/html.rs` 生产二次拆 | 559 | 同 P0-2 | 见 P0-2 第二步 |

> **P1-2 的 CSS 拆分有一条容易翻车的点**：CSS 的**声明顺序决定同特异度规则的胜负**。拆文件时如果靠打包器/`@import` 的自然顺序去碰运气，会出现"某些样式突然被覆盖"。所以入口必须写**显式顺序列表**，且拆完要跑真引擎探针（`tools/css-probe.py`）比对关键元素的计算值，不能只看截图。

### P2 — 排期（不挡路，但债要还）

| # | 文件 | 行数 | 备注 |
| --- | --- | --- | --- |
| P2-1 | `src-tauri/src/lib.rs` | 999 / 生产 812 | Tauri 命令注册中枢。**Step 2 加导出命令之前**先拆（命令注册 / 全局状态 / 启动装配） |
| P2-2 | `capture/window.rs` | 781 / 生产 751 | 截图翻译窗口。生产占比 96%，没有测试兜底 → 拆之前**先补测试** |
| P2-3 | `markdown/model.rs` | 807 / 生产 599 | 解析器。改它风险高（牵扯全部索引空间）→ **放最后**，且拆分必须零逻辑改动 |
| P2-4 | `hibernate.rs` | 652 / 生产 429 | 休眠/会话快照 |
| P2-5 | `components/SettingsModal.tsx` | 1260 | 设置面板按 Tab 切子组件（外观 / 翻译 / LLM / 快捷键 / 关于） |
| P2-6 | `components/Sidebar.tsx` | 807 | 最近 / 收藏 / 工作区 三段本就是并列结构，最好像 P2-5 一样按段切 |
| P2-7 | `stores/useWorkspaceStore.ts` | 640 | 工作区树 / 文件操作 / 外部变更检测 |
| P2-8 | `lib/paletteSeeds.ts` | 486 | 纯数据种子；可拆成"种子表 + 生成算法" |

---

## 五、拆分纪律（**违反就等于白拆**）

1. **纯提取，零行为改动。** 拆分提交里不许顺手改名、不许顺手调逻辑、不许顺手加参数。要做到"把 diff 里的 `mod`/`use`/函数签名搬家忽略掉之后，`git diff` 是空的"。
2. **拆分提交独立于功能提交。** 同一 commit 里既有搬家又有行为改动 = 无法 review，也回滚不了。
3. **可见性不外扩。** Rust 为拆模块把私有项改成 `pub` 是**红线级**的错误（等于把封装卖给邻居）。同 crate 用 `pub(crate)`，同模块内子模块天然可见私有项。
4. **旧路径保留。** 用 `pub use` 再导出，避免一次性改遍全仓库的 `use` 语句——那样拆分 diff 会淹没在路径改动里。
5. **CSS 保序 + 真引擎校验。** 见 P1-2 注。
6. **每次拆完必过门禁**：`cargo check`（Rust）/ `tsc --noEmit` + `vitest run`（前端）。**构建走 PowerShell**。
7. **拆完复测行数并更新本表。** 表要能反映"还欠多少"。

---

## 六、当前执行状态

| 批次 | 项 | 状态 |
| --- | --- | --- |
| — | **Step 0 功能 patch（H3/H1/B4）** | ✅ **已完成**（`19364ee`）· 门禁全绿：cargo check 0/0、cargo test 261、`cargo build --release` 0、tsc 0、vitest 204 |
| P0-2 | `markdown/html.rs` 测试外迁 | ✅ **已完成**（`55e0900`）· 1201 → **562**（生产 559 一行未动） |
| P0-1 | `translate/engine.rs` 三分 | ✅ **已完成**（`a3dea26` + `eed0304`）· 1107 → **engine 678 / policy 244 / packing 226** |
| P1-2 | `src/styles/global.css` 按域拆分 | ✅ **已完成**· 3636 → 13 个 ≤ 800 行文件 + 52 行 manifest。`tools/css-probe.py` 固化源码+构建两层等价核对 |
| P1-1, P1-3, P1-4 | useTranslationStore / useDocStore / PreviewView | ✅ **已完成**（P2 批次三 2026-09-20，即《审查与整改》P2-8a / 8b / 8e）· 拆后壳 318 / 435 / 188，各自拆出流域/快照/四 hook 产物全部达标 |
| P1-5, P1-6 | bridge.rs / html.rs 生产二次拆 | ✅ **已完成**（P2 批次二，即《审查与整改》P2-7a / 7f） |
| P2-1..4 | `lib.rs` / `capture/window.rs` / `markdown/model.rs` / `hibernate.rs` | ✅ **已完成**（P2 批次二 2026-09-20，即《审查与整改》P2-7d / 7k1+7k2 / 7e / 7h）· 拆后全树生产 ≤ 371，Rust 生产超线清零 |
| P2-5 | SettingsModal | ✅ **已完成**（P2 批次三，即《审查与整改》P2-8c）· 1260 → 壳 455（报备偏差）+ settings/ 五 Tab + 三 hook |
| P2-6 | Sidebar | ✅ **已完成**（P2 批次三，即《审查与整改》P2-8d）· 807 → 壳 166 + sidebar/ 四件 + useTreeMenus + clipboard |
| P2-7 | useWorkspaceStore | ☐ **未拆（遗留）**——批次三未含此项，现 640 行仍超线，留后续批次 |
| P2-8 | paletteSeeds | ✅ **已完成**（P2 批次三，即《审查与整改》P2-8g）· 486 → 六种子 + index + paletteCss，生成物逐字节零漂移 |

> **P0 收尾事实（2026-09-16 晚）**
> - 三步拆分全部是**纯提取**：`cargo test` 261 passed、三次逐位一致、零 warning。
> - `html.rs` 的外迁用 `#[cfg(test)] #[path = "html_tests.rs"] mod tests;` —— **模块路径不变**
>   （仍是 `markdown::html::tests`）→ `use super::*` 与私有项照旧可用，测试能力一点没丢。
> - `engine.rs` 的拆分用 `pub use` 保留旧路径 → `units.rs` / `html.rs` / `bridge.rs` /
>   `dto.rs` / `lib.rs` 里的 `translate::engine::XXX` **一行都没改**。
>   唯一例外：`PROMPT_VERSION` 不转发（crate 内无人经 `engine::` 路径用它，转发会触发
>   `unused_imports`），替代路径 `translate::policy::PROMPT_VERSION` 已写在注释里。
> - **⚠️ 一处边界教训**：`oversized_unit_is_split_before_sending` 名字里带 split，实际是拿
>   `MockClient` / `EngineRequest` / `run` 做**端到端**验证 → 归属 `engine.rs`。
>   第一遍我按名字把它切进了 `packing.rs`，编译立刻报 `MockClient` / `EngineRequest` /
>   `run` / `ZH` / `Cache` 全部找不到。**测试归属要看它引用了谁，不能看名字。**
> - 行尾：新文件与编辑产生的行是 LF，已统一回 CRLF（脚本规范化 + 逐行复核 LF-only 为 0）。
>   顺带确认了仓库的 `core.autocrlf=true`、无 `.gitattributes` → blob 存 LF、工作区 CRLF。

> **下一步**：P0 已清完，可以开 Step 1 了。它要改的「方向模板 / 缓存 variant / prompt 措辞」
> 现在**全在 `policy.rs`（151 行）** 里，加上 `bridge.rs` 的入参透传与前端语言选择——
> 不再有千行文件挡在中间。

> **P1-2 收尾事实（2026-09-19 上午）**
> - `global.css` 3636 → **52 行 manifest**（仅 13 条 `@import`）+ **13 个 ≤ 800 行的域文件**
>   （最大 `04-sidebar.css` 694 行 / `10-settings.css` 691 行，均低于 800 红线）。
> - 拆分依据是 global.css 内已有的 13 段注释分隔（`/* ============ ... ============ */`），
>   加每段开头的职责说明注释。**没有一行逻辑改动**：把所有规则在 body 内顺序原样搬走，
>   只在每个文件顶部补了一段说明域的 `/* === */` 头。
> - 入口 manifest 用 **显式 `@import` 顺序列表**而非打包器碰运气：顺序决定同特异度规则
>   的胜负，把顺序写死是这一拆的关键。后续 T04「面板外壳」的 `.panel-slot` /
>   `.panel-handle` 应落在 `05-panels.css`（已经在 manifest 注释里点了名）。
> - **等价性两道门**都过：
>   1. **源码层**——13 域文件按 manifest 顺序拼接（去头） vs 拆分前快照
>      `.scratch/delivery-translation/baseline-global.css`（即原 `global.css`），
>      `normalize()`（去注释 + 折叠空白 + 已知 esbuild 保语义变换）后 sha256 一致
>      （`4a37edafe0d42606` / 48451 字符 / 463 规则 / 454 selector 块）。
>   2. **构建层**——`vite build` 产物 `dist/assets/index-*.css` 里 13 段头签名按
>      manifest 顺序出现在递增偏移，且每段内 `{` 数与源端逐位对齐（4/55/14/25/84/
>      40/19/15/26/25/109/22/25 = 463）。
> - **`tools/css-probe.py`** 把这两道门固化成 `python tools/css-probe.py [--build]`
>   ——任何后续对 `src/styles/*.css` 的改动都可以在提交前跑一遍自检。
> - 行尾：split 后用 `git add --renormalize .` 一并规范化（脚本 `tools/normalize-eol.sh`
>   等价步骤），blob 仍存 LF、工作区 CRLF。
>
> **下一步（CSS 视角）**：P1-1（useTranslationStore.ts 836 行）现在没挡路的样式问题，
> `06-views.css` / `08-popovers.css` 已经预留好「双栏预览 / 划词浮窗」的位置，T03
> 「确定性检查」（`.panel-slot` / `.panel-handle`）可以直接落到 `05-panels.css` 而不用
> 先建文件。

> **P2 批次二收尾事实（2026-09-20）**
> - 九个 Rust 超长文件全部归位为「薄根 + 子模块」形态：`bridge.rs` → bridge/{commands,payload,worker,events}+mod；
>   `lib.rs` → commands/{file,workspace_ops,dialogs,settings}+window_boot（lib.rs 留薄根）；
>   `markdown/model.rs` → model/{types,anchors,parse,inlines}+mod；`markdown/html.rs` → html/{inline,code,footnote}（根保留）；
>   `markdown/cmark.rs` → cmark/{escape,writer}+mod；`hibernate.rs` → hibernate/{state,window,session,handoff}+mod；
>   `translate/providers.rs` → providers/{mod,free,signed,llm}；`translate/engine.rs` → {events,runner}（根留转发与再导出）；
>   `capture/window.rs` → capture/window/{mod,session,pixels,encode}。
> - 12 个执行单元、14 个提交（P2-7e/7i 各一轮返工），逐项独立评审通过；拆分均为纯提取
>   （逐行审计期望 532~1504 行全命中），旧路径 `pub use` 保留、全仓 use 零改动，
>   Tauri IPC wire 命令名逐字不变。逐单元明细见《审查与整改》「执行记录（2026-09-20，P2 批次二）」。
> - 复测（工具与口径见第一节快照）：全树 75 个文件生产 ≤ **371**（capture/window/mod.rs），
>   **Rust 生产超线清零**；新发现存量债 `http.rs` 总量 748 / 测试块 378、`export.rs` 测试块 358
>   （均为功能/加固批次增厚测试所致，非拆分引入），已入 §3.1 复测表待后续批次。

> **P2 批次三收尾事实（2026-09-20）**
> - 前端拆分七个执行单元（P2-8a..g）全部落地、七个提交逐项独立评审**全部一次通过**（0 轮返工）：
>   useTranslationStore → translationStream/lookupStream + 薄 store（8a）；
>   useDocStore → docTabs/sessionRestore + 薄 store（8b）；SettingsModal → settings/ 五 Tab +
>   三 hook（8c）；Sidebar → sidebar/ 四件 + useTreeMenus + clipboard（8d）；
>   PreviewView → 四 hook + previewInject（8e）；App.tsx → 三 hook + Panel 两件（8f）；
>   paletteSeeds → 六种子 + index + paletteCss（8g）。逐单元明细见《审查与整改》
>   「执行记录（2026-09-20，P2 批次三：前端拆分）」。
> - 复测（工具与口径见第一节前端复测快照，**本批起 `-Encoding UTF8`**）：原七个超标文件中
>   六个归位（global.css 59 / SettingsModal 455 / useTranslationStore 318 / Sidebar 166 /
>   PreviewView 188 / useDocStore 435 / paletteSeeds 已目录化），全部 ≤ 400 的新文件 36 个；
>   生产 > 400 的 ts/tsx 剩 4 个（SettingsModal 455 / translationStream 492 / useDocStore 435
>   为逐项报备偏差，**useWorkspaceStore 640 为唯一未拆遗留**，见 §3.2 复测表）。
> - 三项行为红线经逐单元逐字审计保持：P0-5 代际守卫（8a）、P0-3 savedContent 写盘快照与
>   P0-6 discardChanges 收敛写路径（8b）、REL-12 关窗落盘（8c）、XSS 信任边界与 splitSync
>   总线（8e）、热键注册与休眠握手时序（8f）、种子数据与生成物逐字节（8g——gen:palettes
>   直跑输出「palettes.css 已是最新」）。公共 API 与消费方 import 面零改动（两处例外均为
>   同步性改动：reviewWiring.test 扫描目标随 APP_ACTIONS 迁移、gen-palettes.mjs 显式 .ts
>   路径随目录化）。
> - 遗留：`useWorkspaceStore.ts` 640 未拆；`SettingsModal.tsx` 455 / `translationStream.ts`
>   492 / `useDocStore.ts` 435 三处报备偏差；Rust 侧 `http.rs` / `export.rs` 内联测试块存量债
>   沿袭批次二记录。
