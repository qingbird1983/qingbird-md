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
| **599** | 807 | 208 | `markdown/model.rs` | 生产 ✗ 总量 ✗ |
| **559** | 886 | 327 | `bridge.rs` | 生产 ✗ 总量 ✗ |
| **429** | 652 | 223 | `hibernate.rs` | 生产 ✗ |
| 397 | 525 | 128 | `translate/providers.rs` | — |
| 366 | 605 | 239 | `translate/lookup.rs` | — |
| 366 | 678 | 312 | `translate/engine.rs` | ✅ **P0-1 已达标**（原 634 / 1107） |
| 288 | 451 | 163 | `markdown/units.rs` | — |
| 151 | 244 | 93 | `translate/policy.rs` | ✅ P0-1 新建 |
| 145 | 226 | 81 | `translate/packing.rs` | ✅ P0-1 新建 |
| 559 | 562 | 3 | `markdown/html.rs` | ✅ **P0-2 已达标**（原 559 / 1201，测试已外迁） |
| — | 639 | 639 | `markdown/html_tests.rs` | 纯测试文件（生产 0） |

其余 28 个文件生产均 < 300 行，健康。

> **P0 之后还剩什么**：生产超线（> 400）的 Rust 文件**从 7 个降到 5 个**——
> `lib.rs` 812 / `capture/window.rs` 751 / `model.rs` 599 / `bridge.rs` 559 / `hibernate.rs` 429。
> 其中 `bridge.rs` 是 P1-5（Step 1 的方向入参、Step 2 的导出命令都要碰它），
> `lib.rs` 是 P2-1（计划里就写明「Step 2 加导出命令**之前**先拆」）——都已在排期里，现在不必动。
>
> **`translate/` 目录现在是三个各司其职的文件**：`engine.rs` 只管「怎么跑」、
> `policy.rs` 管「怎么判定 / 怎么措辞 / 缓存怎么版本化」、`packing.rs` 管「怎么切批 / 怎么排批 /
> 怎么分片」。Step 1 要改的东西**全在 `policy.rs` 里**，改动面从"上千行文件里翻找"变成"改一个 151 行的文件"。

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
| P0-2 | `markdown/html.rs` 测试外迁 | ✅ **已完成**（`55e0900`）· 1201 → **562**（生产 559 一行未动） |
| P0-1 | `translate/engine.rs` 三分 | ✅ **已完成**（`a3dea26` + `eed0304`）· 1107 → **engine 678 / policy 244 / packing 226** |
| P1-2 | `src/styles/global.css` 按域拆分 | ✅ **已完成**· 3636 → 13 个 ≤ 800 行文件 + 52 行 manifest。`tools/css-probe.py` 固化源码+构建两层等价核对 |
| P1-1, P1-3..6 | 见上 | ☐ 待排期 |
| P2-1..8 | 见上 | ☐ 待排期 |

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
