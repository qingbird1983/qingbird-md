# 翻译逐块流式回填（打字机效果）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点翻译后译文按文档序逐块流式上屏（打字机效果），替代现状"整篇跑完一次性回填"。引擎层零改动——Rust 侧 `translation-partial` 事件已在逐块下发，只是前端无人消费。

**Architecture:** 三段流水线。(1) Rust 渲染器在原文/done 渲染中输出块级与 run 级锚点（`data-bi`/`data-ri`），编号与翻译单元索引空间严格一致；(2) 前端 store 消费 `translation-partial` 事件，经打字机缓冲（游标 + pending 等位）把"按完成序到达"的块重排成"按文档序放行"；(3) PreviewView 用 DOM 后处理把放行的块 patch 进预览（bilingual 追加 tr-box / translation 替换 run 文本），done 到达时整树重建自然接管。网络吞吐不变，纯显示层重排。

**Tech Stack:** Tauri 2 + Rust（pulldown-cmark 自研 model/html 渲染器）+ React 19 + zustand v5 + vitest（新增，仅测纯函数）。

## Global Constraints

- **wire contract 逐字**：`translation-partial` 事件 payload 为 `{gen, index, text}`（lib.rs:386 `TranslationPartialEvt`，`r#gen` serde 输出 `"gen"`）。字段名不得改动。
- **索引空间语义**（两种模式不同，不得混淆）：
  - translation 模式 index = `units::collect_text_runs` 的 run 空间——**每个** `Inline::Text` 占号，仅可翻译 run 被收集；
  - bilingual 模式 index = `units::collect_translatable` 的块空间——仅 `needs_translation` 为真的块占号；
  - Task 1 的锚点编号必须与上述两空间一致，并有对齐测试证明。
- **XSS 信任边界**（PreviewView.tsx 文件头契约）：DOM patch 一律用 `createElement` + `textContent`，绝不向 HTML 字符串拼接任何文档/LLM 派生内容。
- **引擎零改动**：`src-tauri/src/translate/` 目录一行不动。
- 包管理 pnpm；Rust edition 2024；代码注释与 UI 文案用中文（匹配仓库风格）。
- commit 风格：`feat(preview):` / `feat(translate):` / `chore:` / `docs:` + 中文一行描述（对齐 git log 既有风格）。
- 验证命令：Rust 侧 `cargo test`（在 `src-tauri/` 下）；前端 `pnpm test`（本计划新增）、`pnpm build`（tsc + vite）。CI 仅 release.yml 发布流水线，测试为本地/任务级验证。

---

### Task 1: Rust 渲染锚点——`data-bi` / `data-ri`

**Files:**
- Modify: `src-tauri/src/markdown/html.rs`
- Test: `src-tauri/src/markdown/html.rs`（文件尾 `mod tests`）

**Interfaces:**
- Consumes: `crate::translate::engine::needs_translation`（html.rs:23 已导入）；`units::collect_text_runs` / `units::collect_translatable`（编号对齐的参照，只读不改）。
- Produces: 三种渲染形态（原文 parse / done translation / done bilingual）的 HTML 中：
  - 可翻译块的开标签携带 `data-bi="{n}"`（n = `collect_translatable` 块空间序号）；
  - 每个 `Inline::Text` run 包裹为 `<span data-ri="{m}">…</span>`（m = `collect_text_runs` run 空间序号，含不可翻译 run）。
  - Task 3 的前端 patch 依赖这两个属性名与编号语义，逐字使用。

- [ ] **Step 1: 写失败测试**

在 `html.rs` 的 `mod tests` 里追加（放在现有 `bilingual_heading_and_paragraph_indexes_align` 附近）：

```rust
#[test]
fn anchors_mark_bi_blocks_and_ri_runs_in_original_render() {
    // 原文渲染（trans 空）也输出锚点：data-bi 与 collect_translatable 的块
    // 空间一致，data-ri 与 collect_text_runs 的 run 空间一致——partial 流式
    // 回填靠这两个属性定位 DOM。
    let md = "# Hello\n\nA **B** C\n\n```rust\nfn x() {}\n```\n\n中文段落\n\nDone doc\n";
    let r = render_html(md, &HashMap::new(), false);
    // 块空间：Hello(0)、A B C(1)、中文段落(无 ASCII 不占号)、Done doc(2)
    assert!(r.html.contains(r#"<h1 id="h-1" data-bi="0">"#));
    assert!(r.html.contains(r#"<p data-bi="1">"#));
    assert!(r.html.contains(r#"<p data-bi="2">"#));
    assert_eq!(r.html.matches("data-bi=").count(), 3);
    // run 空间：每个 Text run 占号（含不可翻译的中文段落）：
    // Hello(0) A..(1) B(2) ..C(3) 中文段落(4) Done doc(5)
    for i in 0..6 {
        assert!(r.html.contains(&format!(r#"data-ri="{}""#, i)));
    }
    assert_eq!(r.html.matches("data-ri=").count(), 6);
}

#[test]
fn substituted_render_keeps_run_anchors() {
    // translation 形态（run 替换）里 span 恒在——替换发生在 span 内部，
    // 属性数量不变，done 后锚点仍然可寻址。
    let md = "A **B** C\n";
    let mut trans = HashMap::new();
    trans.insert(1usize, "乙".to_string()); // run 1 = "A ..." 之外的 Text run
    let r = render_html(md, &trans, false);
    assert_eq!(r.html.matches("data-ri=").count(), 3);
    assert!(r.html.contains(r#"<span data-ri="1">乙</span>"#));
}
```

注意：`trans.insert(1, …)` 假设 "A **B** C" 的 Text run 切分为 3 个（A…/B/…C）。若实现中发现 model 解析的 run 边界不同（例如空格归属），以 `units::collect_text_runs` 的实际输出为准调整断言——契约是**属性数量与编号**，不是 span 内文本。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test` （workdir: `src-tauri/`）
Expected: 两个新测试 FAIL（现有 HTML 无 data-bi/data-ri）。

- [ ] **Step 3: 实现**

`html.rs` 三处改动：

(a) 把 `maybe_tr_box`（html.rs:203）重构为"占号"与"追加"两半——占号恒发生（三形态编号一致），tr-box 只在 bi 模式追加：

```rust
    /// Assign the block-space index for this block/cell if it is translatable.
    /// 恒占号（与 units::collect_translatable 逐块一致），无论当前渲染形态——
    /// 原文/done 渲染的 data-bi 锚点编号因此与 partial 事件的 index 同空间。
    /// 返回 None 表示本块不占号（不开 data-bi、不追加 tr-box）。
    fn bi_advance(&mut self, plain: &str) -> Option<usize> {
        if !needs_translation(plain) {
            return None;
        }
        let idx = self.bi_counter;
        self.bi_counter += 1;
        Some(idx)
    }

    /// Append `<div class="tr-box">…</div>` in bilingual mode, using the
    /// index already assigned by [`Self::bi_advance`].
    fn maybe_tr_box(&mut self, out: &mut String, plain: &str, bi_idx: Option<usize>) {
        let Some(idx) = bi_idx else { return };
        let Some(map) = self.bi else { return };
        if let Some(tr) = map.get(&idx) {
            let _ = write!(out, r#"<div class="tr-box">{}</div>"#, escape_html(tr));
        }
    }
```

(b) 块分支改为"先算 plain → bi_advance → 开标签带 data-bi → 尾部 maybe_tr_box(plain, bi_idx)"。Heading（html.rs:95）：

```rust
            Block::Heading { level, text } => {
                self.heading_id += 1;
                let id = format!("h-{}", self.heading_id);
                let plain = inline_plain_text(text);
                self.outline.push(OutlineItem {
                    level: *level,
                    text: plain.clone(),
                    id: id.clone(),
                });
                let bi_idx = self.bi_advance(&plain);
                match bi_idx {
                    Some(i) => write!(out, r#"<h{} id="{}" data-bi="{}">"#, level, id, i),
                    None => write!(out, "<h{} id=\"{}\">", level, id),
                }
                .unwrap();
                self.push_inlines(out, text);
                let _ = writeln!(out, "</h{}>", level);
                self.maybe_tr_box(out, &plain, bi_idx);
            }
```

Paragraph（html.rs:111）：

```rust
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                let bi_idx = self.bi_advance(&plain);
                match bi_idx {
                    Some(i) => write!(out, r#"<p data-bi="{}">"#, i),
                    None => out.push_str("<p>"),
                }
                .unwrap();
                self.push_inlines(out, text);
                out.push_str("</p>");
                self.maybe_tr_box(out, &plain, bi_idx);
            }
```

Table（html.rs:166）——每个 th/td 同构处理：

```rust
            Block::Table { headers, rows } => {
                out.push_str("<table><thead><tr>");
                for h in headers {
                    let plain = inline_plain_text(h);
                    let bi_idx = self.bi_advance(&plain);
                    match bi_idx {
                        Some(i) => write!(out, r#"<th data-bi="{}">"#, i),
                        None => out.push_str("<th>"),
                    }
                    .unwrap();
                    self.push_inlines(out, h);
                    self.maybe_tr_box(out, &plain, bi_idx);
                    out.push_str("</th>");
                }
                out.push_str("</tr></thead><tbody>");
                for row in rows {
                    out.push_str("<tr>");
                    for cell in row {
                        let plain = inline_plain_text(cell);
                        let bi_idx = self.bi_advance(&plain);
                        match bi_idx {
                            Some(i) => write!(out, r#"<td data-bi="{}">"#, i),
                            None => out.push_str("<td>"),
                        }
                        .unwrap();
                        self.push_inlines(out, cell);
                        self.maybe_tr_box(out, &plain, bi_idx);
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
            }
```

(c) `push_inlines` 的 `Inline::Text` 分支（html.rs:221）包裹 span：

```rust
                Inline::Text(t) => {
                    let idx = self.sub_counter;
                    self.sub_counter += 1;
                    let tr = self.sub.and_then(|m| m.get(&idx)).map(String::as_str);
                    let _ = write!(out, r#"<span data-ri="{}">"#, idx);
                    match tr {
                        Some(tr) => out.push_str(&escape_html(tr)),
                        None => out.push_str(&escape_html(t)),
                    }
                    out.push_str("</span>");
                }
```

- [ ] **Step 4: 跑全部测试确认通过**

Run: `cargo test`（workdir: `src-tauri/`）
Expected: 全部 PASS，含既有 `bilingual_appends_tr_box_below_paragraph`（tr-box HTML 形态不变，`</h1>` 后紧跟 tr-box 的断言不受开标签影响）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/markdown/html.rs
git commit -m "feat(translate): 渲染锚点 data-bi/data-ri——三形态编号与翻译单元索引空间一致，供前端逐块流式回填定位"
```

---

### Task 2: 打字机缓冲纯函数 + vitest 设施

**Files:**
- Modify: `package.json`（scripts.test + devDependency vitest）
- Create: `src/lib/typewriter.ts`
- Test: `src/lib/typewriter.test.ts`

**Interfaces:**
- Produces: `typewriterStart(): TypewriterState`、`typewriterPush(s, index, text): { state: TypewriterState; released: Array<{index: number; text: string}> }`。Task 3 的 store 只依赖这两个函数与 `TypewriterState` 结构（`cursor: number`、`pending: Map<number, string>`）。

- [ ] **Step 1: 引入 vitest**

```bash
pnpm add -D vitest
```

在 `package.json` 的 `scripts` 里加一行（与现有 dev/build/preview/tauri 并列）：

```json
"test": "vitest run"
```

- [ ] **Step 2: 写实现**

`src/lib/typewriter.ts`（完整文件）：

```ts
// 打字机缓冲：把"按完成序到达"的译文块重排成"按文档序放行"。
//
// 引擎并发 worker 先完成先发事件，直接上屏会出现"哪块先译完哪块先出现"。
// 这里用游标 + 等位缓冲实现严格文档序：index === cursor 的块立即放行并把
// 连续命中的后续块一并放行；index 超前（缺口未填）的块在 pending 等位。
// 网络吞吐不变，纯显示层重排。全部不可变更新（zustand setState 惯例）。
export interface Released {
  index: number;
  text: string;
}

export interface TypewriterState {
  /** 已放行的连续前缀上界（exclusive）：0..cursor 全部已放行 */
  cursor: number;
  /** 序号 ≥ cursor 的到货块，等位中（序号 < cursor 的已放行即删） */
  pending: Map<number, string>;
}

export function typewriterStart(): TypewriterState {
  return { cursor: 0, pending: new Map() };
}

export function typewriterPush(
  s: TypewriterState,
  index: number,
  text: string,
): { state: TypewriterState; released: Released[] } {
  const pending = new Map(s.pending);
  pending.set(index, text);
  const released: Released[] = [];
  let cursor = s.cursor;
  while (pending.has(cursor)) {
    released.push({ index: cursor, text: pending.get(cursor)! });
    pending.delete(cursor);
    cursor += 1;
  }
  return { state: { cursor, pending }, released };
}
```

- [ ] **Step 3: 写测试**

`src/lib/typewriter.test.ts`（完整文件）：

```ts
import { describe, expect, it } from "vitest";
import { typewriterPush, typewriterStart } from "./typewriter";

describe("typewriterPush", () => {
  it("顺序到达立即逐块放行", () => {
    let s = typewriterStart();
    for (const [i, txt] of ["甲", "乙", "丙"].entries()) {
      const r = typewriterPush(s, i, txt);
      s = r.state;
      expect(r.released).toEqual([{ index: i, text: txt }]);
    }
    expect(s.cursor).toBe(3);
    expect(s.pending.size).toBe(0);
  });

  it("乱序到达先缓冲，缺口填上后连续放行", () => {
    let s = typewriterStart();
    // 2 先到：等位，不放行
    const r2 = typewriterPush(s, 2, "丙");
    s = r2.state;
    expect(r2.released).toEqual([]);
    // 0 到：只放行 0（1 仍缺）
    const r0 = typewriterPush(s, 0, "甲");
    s = r0.state;
    expect(r0.released).toEqual([{ index: 0, text: "甲" }]);
    // 1 到：放行 1、2（连带等位中的 2）
    const r1 = typewriterPush(s, 1, "乙");
    s = r1.state;
    expect(r1.released).toEqual([
      { index: 1, text: "乙" },
      { index: 2, text: "丙" },
    ]);
    expect(s.cursor).toBe(3);
  });

  it("index 0 迟到时全部卡住等位（严格文档序的代价，done 事件兜底）", () => {
    let s = typewriterStart();
    const r = typewriterPush(s, 1, "乙");
    s = r.state;
    expect(r.released).toEqual([]);
    expect(s.cursor).toBe(0);
    expect(s.pending.get(1)).toBe("乙");
  });

  it("放行后 pending 中同序号条目被删除，不重复放行", () => {
    let s = typewriterStart();
    s = typewriterPush(s, 0, "甲").state;
    s = typewriterPush(s, 1, "乙").state;
    const again = typewriterPush(s, 1, "乙"); // 引擎不会重复 emit；防御性用例
    expect(again.released).toEqual([]); // cursor 已过 1，重复条目留在 pending 不放行
    expect(again.state.cursor).toBe(2);
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test`
Expected: 4 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/typewriter.ts src/lib/typewriter.test.ts
git commit -m "feat(translate): 打字机缓冲纯函数（游标+等位，完成序→文档序）+ vitest 设施"
```

---

### Task 3: 事件接线——store 消费 partial + PreviewView 流式 patch

**Files:**
- Modify: `src/types/ipc.ts`、`src/lib/ipc.ts`、`src/stores/useTranslationStore.ts`、`src/App.tsx`、`src/components/PreviewView.tsx`
- Test: `pnpm test`（回归 Task 2）+ 手动冒烟（本任务步骤 6）

**Interfaces:**
- Consumes: `translation-partial` 事件 `{gen, index, text}`（Rust lib.rs:721 已在发，不改）；Task 1 的 `data-bi`/`data-ri` 锚点；Task 2 的 `typewriterPush`/`typewriterStart`。
- Produces: store 新状态 `partialBlocks: Map<number, string>`（已按文档序放行的块译文）、`partialCursor: number`（已放行连续前缀上界）、`partialGen: number`（流所属轮次，0=无流）；`api.listenPartial(cb)`。

- [ ] **Step 1: 类型与 IPC 门面**

`src/types/ipc.ts`——在 `ProgressPayload`（:86）之后追加：

```ts
/** lib.rs TranslationPartialEvt：{gen, index, text}（r#gen → "gen"）。
 * index 与 translation-done 的 pair 首元素同一索引空间：
 * translation 模式 = text runs（data-ri），bilingual 模式 = translatable 块（data-bi）。 */
export interface TranslationPartialPayload {
  gen: number;
  index: number;
  text: string;
}
```

`src/lib/ipc.ts`——import 列表加 `TranslationPartialPayload`；`api` 的事件区（`listenProgress` 旁，:85）加：

```ts
  listenPartial: (cb: (p: TranslationPartialPayload) => void) =>
    listen<TranslationPartialPayload>("translation-partial", (e) => cb(e.payload)),
```

- [ ] **Step 2: store 消费 partial**

`src/stores/useTranslationStore.ts`：

(a) import 区加：

```ts
import type { TranslationPartialPayload } from "../types/ipc";
import { typewriterPush, typewriterStart, type TypewriterState } from "../lib/typewriter";
```

(b) 模块级（现有 `let selTimer` 附近）加打字机状态与防重标记：

```ts
// 打字机缓冲（不进 React state：pending 不驱动渲染，只有放行结果才 set）
let twState: TypewriterState = typewriterStart();
let partialRegistered = false;
```

(c) `TranslationState` 接口加字段与方法声明（与现有 listenProgress 声明 :32 并列）：

```ts
  /** 已按文档序放行的块/run 译文（index 语义随当前 run 模式：runs 或 块） */
  partialBlocks: Map<number, string>;
  /** 已放行的连续前缀上界（exclusive）；PreviewView 的 patch 水位参照 */
  partialCursor: number;
  /** partial 流所属轮次；0 = 无流 */
  partialGen: number;
  listenPartial(): void;
```

(d) 模块级 handler（`handleProgress` :119 旁）加：

```ts
/** translation-partial → 打字机缓冲 → 放行结果落 store（PreviewView patch 消费）。 */
function handlePartial(p: TranslationPartialPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与当前内容错位，宁缺勿错
  // （与 handleDone 的 runContent 护栏同一口径）。
  if (useDocStore.getState().doc?.content !== st.runContent) return;
  const next = typewriterPush(twState, p.index, p.text);
  twState = next.state;
  if (next.released.length === 0) return;
  const blocks = new Map(st.partialBlocks);
  for (const r of next.released) blocks.set(r.index, r.text);
  useTranslationStore.setState({
    partialBlocks: blocks,
    partialCursor: twState.cursor,
    partialGen: p.gen,
  });
}

/** 清空 partial 流（起跑/收尾共用）：React 状态 + 模块级打字机缓冲。 */
function clearPartial() {
  twState = typewriterStart();
  useTranslationStore.setState({
    partialBlocks: new Map(),
    partialCursor: 0,
    partialGen: 0,
  });
}
```

(e) store 实现体内：

- 初始 state（`status: "idle",` 附近）加 `partialBlocks: new Map(), partialCursor: 0, partialGen: 0,`；
- `translateDocument` 的 `set({ gen: r.gen, status: "running", … })`（:191）**之前**调用 `clearPartial()`（新一轮起跑清残留）；
- `handleDone` 两个出口（`!d.ok` 的 early return 前 :142、正常落库后 :146）都调用 `clearPartial()`——done 整树重建接管显示，partial 状态使命结束；
- 监听注册（`listenDone` 实现旁 :217）加：

```ts
  listenPartial: () => {
    if (partialRegistered) return;
    partialRegistered = true;
    void api.listenPartial(handlePartial);
  },
```

- [ ] **Step 3: App.tsx 注册**

找到现有 `useTranslationStore` 的三个 listen 注册调用（`listenProgress`/`listenDone`/`listenLookupDelta`），同处追加一行：

```ts
    void useTranslationStore.getState().listenPartial();
```

- [ ] **Step 4: PreviewView 流式 patch**

`src/components/PreviewView.tsx`：

(a) 文件头注释"前端在此层只做三件 DOM 后处理"更新为四件，补一句：

```
// 四：翻译进行中的流式回填（patchPartial）——partial 事件放行的块经
// textContent / createElement 写入，绝不拼 HTML 字符串（XSS 边界同上）。
```

(b) 组件内订阅（`const doneHtml = …` :111 附近）加：

```tsx
  const partialBlocks = useTranslationStore((s) => s.partialBlocks);
  const partialCursor = useTranslationStore((s) => s.partialCursor);
  const partialGen = useTranslationStore((s) => s.partialGen);
```

(c) 注入管线 effect（:131-140）之后加 patch effect 与 patch 函数：

```tsx
  /** 把一个已放行的译文块 patch 进预览 DOM。锚点缺失/形态不符静默跳过：
   * done 事件随后整树重建兜底，不在此层重试。 */
  function patchPartial(el: HTMLElement, mode: Mode, index: number, text: string) {
    if (mode === "bilingual") {
      const host = el.querySelector(`[data-bi="${index}"]`);
      if (!host) return;
      if (host.nextElementSibling?.classList.contains("tr-box")) return; // StrictMode 双跑防重
      const box = document.createElement("div");
      box.className = "tr-box";
      box.textContent = text; // textContent 赋值：LLM 译文永不解析为 HTML
      host.after(box);
    } else if (mode === "translation") {
      const run = el.querySelector(`[data-ri="${index}"]`);
      if (!run) return;
      run.textContent = text;
    }
  }

  // 流式回填：只处理上次水位之后新放行的区间，逐块查锚点 patch。
  // gen 变化（新轮次/清空）即重置水位；innerHTML 重建 effect（上方）在
  // done 时整树重渲，本 effect 因 partialGen=0 不再动作——两管线无缝交接。
  const patchedRef = useRef<{ gen: number; upto: number }>({ gen: 0, upto: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || partialGen === 0) return;
    if (patchedRef.current.gen !== partialGen) {
      patchedRef.current = { gen: partialGen, upto: 0 };
    }
    for (let i = patchedRef.current.upto; i < partialCursor; i++) {
      const text = partialBlocks.get(i);
      if (text !== undefined) patchPartial(el, mode, i, text);
    }
    patchedRef.current.upto = Math.max(patchedRef.current.upto, partialCursor);
  }, [partialGen, partialCursor, partialBlocks, mode]);
```

`Mode` 类型已随 types/ipc 导入（若未导入则补 `import type { Mode } from "../types/ipc"`——以现有 import 为准）。

(d) tsconfig 严格模式下组件内定义 `patchPartial` 若触发 exhaustive-deps 告警，将其移到组件外并显式传参（mode/index/text/el 均为参数，无闭包捕获）——优先组件外定义。

- [ ] **Step 5: 静态检查与构建**

Run: `pnpm test`（typewriter 回归）与 `pnpm build`（tsc 严格检查 + vite 构建均须零错误）

- [ ] **Step 6: 手动冒烟（真机 `pnpm tauri dev`，配置真实 LLM）**

1. bilingual 模式点翻译：译文块**自上而下**逐块出现（多 worker 并发下也严格有序）；进度条同时推进
2. translation 模式：段落文本逐 run 替换浮现，行内粗体/链接结构在 done 后恢复完整
3. done 到达：整树重建后形态与 partial 期间一致，无重复 tr-box、无闪烁
4. 跑批中切换模式 / 编辑文档：partial 被护栏丢弃、无错位残留；done 提示正常（既有护栏语义）
5. 缓存全命中重跑：不出进度条直接显示（无 partial 流，回归无损）
6. 中途停止翻译：无残留 partial；再次翻译新轮次正常
7. 回归：划词查词浮窗、代码复制按钮、标题折叠、表格 th/td 内 tr-box（既有 done 渲染）均正常
8. 含表格/引用/列表/中英混排文档：tr-box 与译文位置正确（锚点编号穿透嵌套容器）

- [ ] **Step 7: Commit**

```bash
git add src/types/ipc.ts src/lib/ipc.ts src/stores/useTranslationStore.ts src/App.tsx src/components/PreviewView.tsx
git commit -m "feat(preview): 翻译逐块流式回填——消费 translation-partial，打字机缓冲保证文档序上屏"
```

---

### Task 4: CHANGELOG 与收尾验证

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CHANGELOG 条目**

`CHANGELOG.md` 的 `## [Unreleased]` 下（若无 `### Added` 小节则创建）：

```markdown
### Added

- 翻译逐块流式回填（打字机效果）：点翻译后译文按文档序逐块上屏，不再等整篇完成；
  bilingual 逐块追加译文框，translation 逐 run 替换浮现。渲染层新增 data-bi/data-ri
  锚点（与翻译单元索引空间一致），前端打字机缓冲把完成序重排为文档序，网络吞吐不变。
```

- [ ] **Step 2: 全量验证**

```bash
cargo test        # workdir: src-tauri/ —— 全绿
pnpm test         # typewriter 全绿
pnpm build        # tsc + vite 零错误
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG——翻译逐块流式回填（打字机效果）归位 Unreleased/Added"
```

---

## 已记录的取舍（实施者不必另行决策）

- **index 0 迟到时全卡**：严格文档序意味着最前面的块缺口会卡住后续所有已到块，直到 done 事件整树兜底。缺口重试通常秒级返回，不加显示超时（YAGNI；真卡再议）。
- **partial 不节流**：事件速率 = 块闭合速率（批 8 / 并发 3），远低于 webview 事件队列压力阈值；Progress 的 80ms 节流不适用（partial 是内容不是计数）。
- **运行中编辑的中间态**：跑批中用户编辑 → innerHTML 重建使已 patch 块丢失、runContent 护栏拦掉后续 partial 与 done 落库——与现状"编辑中断翻译"语义一致，只是中间态曾可见。不额外补偿。
- **span 包裹的体积/CSS 影响**：每个 Text run 多一个 `<span>`，千 run 文档多千节点（WebView2 无压力）；`:first-child` 类选择器不受影响（text node 本就不参与 first-child 判定）。冒烟步骤 7 覆盖回归。
