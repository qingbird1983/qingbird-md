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

**总量基线（2026-09-16 实测；**已于 Step 0 `19364ee` 之后复测**）**

| 树 | 文件数 | 生产行 | 测试行 | 合计 |
| --- | --- | --- | --- | --- |
| `src-tauri/src`（Rust） | 37 | 8,135 | 4,052 | 12,187 |
| `src`（TS/TSX/CSS） | 83 | 15,664 | 2,311 | 17,975 |
| **合计** | **120** | **23,799** | **6,363** | **30,162** |

> **Step 0 带来的增量**：Rust 生产 +39 / 测试 **+138** / 合计 +177。其中 `html.rs` 测试块
> **548 → 642（+94）**——加的是 `render_html` 的测试本地薄包装（`render_html_dir`）与
> 「zh→en 锁步」守卫测试。**功能扩展推高测试体量是必然的**，这也是 P0-2「测试先外迁」
> 排在最前面的原因：先腾出空间，后面几步（Step 1/2/3）往里加测试就不会把文件顶爆。

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

| 生产 | 总量 | 内联测试 | 文件 | 超标项 |
| --- | --- | --- | --- | --- |
| **812** | 999 | 187 | `src-tauri/src/lib.rs` | 生产 ✗ 总量 ✗ |
| **751** | 781 | 30 | `capture/window.rs` | 生产 ✗ 总量 ✗ |
| **634** | **1107** | **473** | `translate/engine.rs` | 生产 ✗ 总量 ✗ 测试 ✗ |
| **599** | 807 | 208 | `markdown/model.rs` | 生产 ✗ 总量 ✗ |
| **559** | **1201** | **642** | `markdown/html.rs` | 生产 ✗ 总量 ✗ 测试 ✗✗ |
| **559** | 886 | 327 | `bridge.rs` | 生产 ✗ 总量 ✗ |
| **429** | 652 | 223 | `hibernate.rs` | 生产 ✗ |
| 397 | 525 | 128 | `translate/providers.rs` | — |
| 366 | 605 | 239 | `translate/lookup.rs` | — |
| 288 | 451 | 163 | `markdown/units.rs` | — |

其余 27 个文件生产均 < 300 行，健康。

> **Step 0 后的变化（相对上一版）**：`engine.rs` 生产 620→634、`bridge.rs` 546→559、
> `lib.rs` 806→812（都是逐点透传方向参数的净增）；**`html.rs` 生产未变（559），但内联测试
> 548→642**。三条 + 一条说明同一件事：**不先做 P0-2，Step 1/2/3 每往 `html.rs` 加一个守卫
> 测试就多 50~100 行测试代码压在同一个文件里**。

### 3.2 前端

| 行数 | 文件 | 超标项 |
| --- | --- | --- |
| **3590** | `src/styles/global.css` | CSS ✗✗（是 CSS 线的 4.5 倍） |
| **1260** | `components/SettingsModal.tsx` | 组件/模块 ✗✗ |
| **836** | `stores/useTranslationStore.ts` | 模块 ✗✗ |
| **807** | `components/Sidebar.tsx` | ✗✗ |
| **715** | `components/PreviewView.tsx` | ✗ |
| **666** | `stores/useDocStore.ts` | ✗ |
| **640** | `stores/useWorkspaceStore.ts` | ✗ |
| **539** | `styles/markdown.css` | — |
| **486** | `lib/paletteSeeds.ts` | ✗ |

其余 74 个文件均 < 400 行，健康。前端**内联测试为 0**（全是独立 `*.test.ts(x)`），这点比 Rust 侧好。

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
| P0-1 | `translate/engine.rs` 三分 | ☐ 待做（**前置条件已满足**，可立刻做） |
| P0-2 | `markdown/html.rs` 测试外迁 | ☐ 待做 |
| P1-1..6 | 见上 | ☐ 待排期 |
| P2-1..8 | 见上 | ☐ 待排期 |

> **顺序原因**：绝不在红灯树上重构。Step 0 已把 H3/H1/B4 改完、两侧门禁全绿 → **P0 的两个前置条件现在都满足了**。
>
> **P0 与 Step 1 的先后，建议这样定**：
> - **P0-2（html.rs 测试外迁）建议排在 Step 1 之前**——它是纯搬家、零风险，且 `html.rs` 的测试块已经 642 行（超线 2 倍），Step 1~3 每加一个守卫测试都会往上堆。
> - **P0-1（engine.rs 三分）排在 Step 1 之前收益最大**——Step 1 要改的「方向模板 / 缓存 variant / prompt 措辞」**全部落在将要迁出的 `policy.rs` 里**，先拆完再改，Step 1 的 diff 就只落在一个 100 多行的新文件上，而不是在 1107 行的文件里翻找。
> - 若想先要用户可感知的功能，也可**反过来**：先做 Step 1 的 UI 面（语言选择），但那时 `engine.rs`/`html.rs` 会各再胖一圈，**拆分的成本只增不减**。
