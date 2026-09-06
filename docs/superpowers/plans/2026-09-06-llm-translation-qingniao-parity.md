# LLM 翻译对齐 qingniao 实施计划（视口按需 · 逐字打字机 · 文献跳过 · 缓存瞬时 · 把手微调）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 qingniao 的四项翻译能力（视口按需翻译、逐字打字机、参考文献区段跳过、缓存命中瞬时上屏）移植进 qingbird，默认「切模式=视口按需」，并顺带完成拖宽把手两项微调。

**Architecture:** 前端调度器（useTranslationStore 持有 scope/锚点/自动扩展）+ 后端一次性 run 模型（translate_document 增窗口参数，窗口化载荷不带整树 html）；打字机两段式（文档序放行 → reveal 队列逐字）；文献跳过为三处共用判定（units 两收集器 + html 占号）。

**Tech Stack:** Rust 2024 (tauri 2, src-tauri crate `qingbird-md`)；React 18 + zustand v5 + TS strict；vitest（沙箱不可跑）+ `npx tsc --noEmit`。

**Spec:** `docs/superpowers/specs/2026-09-06-llm-translation-qingniao-parity-design.md`

## Global Constraints

- Rust 测试在本沙箱**可以跑**：`cargo test --lib -q <filter>`（已实测 exit 0）。
- vitest 在本沙箱**不可跑**（pnpm spawn EPERM）：TS 侧一律用 `npx tsc --noEmit -p tsconfig.json` 验证类型；vitest 真跑留给用户本地（最终验证任务列出命令）。
- 不新增任何依赖（Cargo/npm 都是）。
- crate 在 workspace `src-tauri`，跑测试的工作目录 = 仓库根（`F:\AIwork\qingbird-md-rust`）。
- commit message 沿用仓库惯例：`feat:/fix:/test:/docs(scope): 中文描述`。
- 所有新文件 UTF-8，注释风格与现文件一致（中文块注释 + 逐条理由）。
- 索引空间铁律：`data-bi`（translatable 块）与 `data-ri`（Text run）两套计数，`skip` 判定改动必须让 html.rs 与 units.rs 逐位一致（Task 3 的对齐测试锚定）。

---

### Task 1: `translate/skip.rs` — 参考文献区段状态机

**Files:**
- Create: `src-tauri/src/translate/skip.rs`
- Modify: `src-tauri/src/translate/mod.rs`（注册模块）

**Interfaces:**
- Produces: `skip::RefSkipState::default()`、`fn feed(&mut self, heading: Option<(u8, &str)>) -> bool`（true = 本块被区段跳过）。Task 2/3 按此签名消费。

- [ ] **Step 1: 创建 skip.rs（实现 + 测试一起给，测试先失败于“模块不存在”不适用——本任务直接写全，跑测试验证绿）**

```rust
//! 翻译跳过规则：参考文献区段自动跳过（qingniao 同款规则）。
//!
//! 入口标题整串命中（英文不区分大小写）→ 区段内所有块不参与翻译，
//! 直到 `级别 ≤ 入口级别` 的标题复位。判定必须与占号（html.rs bi_advance）
//! 和收集（units.rs 两 walker）共用同一状态机，三处索引空间才逐位一致。

/// 入口标题触发词（trim 后整串精确匹配；英文不区分大小写）。
const REFERENCE_TITLES: [&str; 8] = [
    "references",
    "bibliography",
    "works cited",
    "literature cited",
    "参考文献",
    "参考资料",
    "参考书目",
    "引用文献",
];

/// 每次文档遍历持有一份；沿文档序逐块 feed。
#[derive(Debug, Default, Clone)]
pub struct RefSkipState {
    in_section: bool,
    entry_level: u8,
}

impl RefSkipState {
    /// 逐块喂入：标题块传 `Some((level, 纯文本))`，其余块传 `None`。
    /// 返回 true = 本块处于参考文献区段内，不参与翻译。
    pub fn feed(&mut self, heading: Option<(u8, &str)>) -> bool {
        match heading {
            Some((level, text)) => {
                if is_reference_title(text) {
                    self.in_section = true;
                    self.entry_level = level;
                    return true; // 入口标题本身也不译
                }
                if self.in_section && level <= self.entry_level {
                    // 同级或更高级标题复位；复位标题自身重新判定（可能是新入口）
                    self.in_section = false;
                    return self.feed(Some((level, text)));
                }
                self.in_section
            }
            None => self.in_section,
        }
    }
}

fn is_reference_title(text: &str) -> bool {
    let t = text.trim();
    !t.is_empty() && REFERENCE_TITLES.iter().any(|k| t.eq_ignore_ascii_case(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked_seq(items: &[(Option<u8>, &str)]) -> Vec<bool> {
        let mut st = RefSkipState::default();
        items
            .iter()
            .map(|&(lvl, txt)| st.feed(lvl.map(|l| (l, txt))))
            .collect()
    }

    #[test]
    fn h2_entry_and_same_level_reset() {
        let r = blocked_seq(&[
            (None, "Intro body"),
            (Some(2), "References"),
            (None, "Smith 2020"),
            (None, "Another entry"),
            (Some(2), "Acknowledgements"),
            (None, "Thanks body"),
        ]);
        assert_eq!(r, [false, true, true, true, false, false]);
    }

    #[test]
    fn sub_heading_inside_section_does_not_reset() {
        let r = blocked_seq(&[
            (Some(2), "References"),
            (Some(3), "Primary sources"),
            (None, "entry"),
            (Some(1), "Bibliography"), // H1 ≤ H2 复位，但自身又是入口 → true
            (None, "entry2"),
            (Some(1), "Conclusion"),
            (None, "body"),
        ]);
        assert_eq!(r, [true, true, true, true, true, false, false]);
    }

    #[test]
    fn english_case_insensitive_and_trim() {
        let r = blocked_seq(&[(Some(2), "  REFERENCES  "), (None, "x")]);
        assert_eq!(r, [true, true]);
    }

    #[test]
    fn partial_match_does_not_trigger() {
        let r = blocked_seq(&[
            (Some(2), "6.4 参考实现"),
            (None, "body"),
            (Some(2), "References and Further Reading"),
            (None, "body2"),
        ]);
        assert_eq!(r, [false, false, false, false]);
    }

    #[test]
    fn all_chinese_titles_trigger() {
        for t in ["参考文献", "参考资料", "参考书目", "引用文献"] {
            let mut st = RefSkipState::default();
            assert!(st.feed(Some((2, t))));
            assert!(st.feed(None));
        }
    }
}
```

- [ ] **Step 2: 注册模块** — `src-tauri/src/translate/mod.rs` 加 `pub mod skip;`（按现有 mod 字母序插入）。

- [ ] **Step 3: 跑测试验证通过**

Run: `cargo test --lib -q translate::skip`
Expected: PASS（6 个测试全绿）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/translate/skip.rs src-tauri/src/translate/mod.rs
git commit -m "feat(translate): 参考文献区段自动跳过状态机（qingniao 同款规则）"
```

---

### Task 2: `markdown/units.rs` — skip 整合 + 窗口化收集

**Files:**
- Modify: `src-tauri/src/markdown/units.rs`（重写两个 walker + 新窗口化包装）

**Interfaces:**
- Consumes: `translate::skip::RefSkipState`（Task 1）。
- Produces:
  - `collect_translatable(blocks) -> Vec<(usize, String)>`（签名不变，行为含 skip）
  - `collect_translatable_windowed(blocks, window: Option<(usize, usize)>) -> Vec<(usize, String)>`
  - `collect_text_runs(blocks) -> Vec<(usize, String)>`（签名不变，行为含 skip）
  - `collect_text_runs_windowed(blocks, window: Option<(usize, usize)>) -> Vec<(usize, String)>`
  - 窗口 = 块索引空间 `[top, end)`（与 data-bi 同空间），None = 全文。Task 5 的 bridge 按此调用。

- [ ] **Step 1: 重写 units.rs 收集层（保留 `inline_plain_text` 不动；替换以下部分）**

```rust
use crate::translate::engine::needs_translation;
use crate::translate::skip::RefSkipState;

/// 窗口过滤：None = 全文；Some((top, end)) = 块索引 ∈ [top, end)。
fn in_window(i: usize, window: Option<(usize, usize)>) -> bool {
    match window {
        None => true,
        Some((top, end)) => i >= top && i < end,
    }
}

/// 单块可译判定：喂 skip 状态机 + needs_translation。三处（html.rs / 两 walker）
/// 共用同一逻辑，保证占号与收集逐位一致。
fn block_translatable(st: &mut RefSkipState, heading: Option<u8>, plain: &str) -> bool {
    let blocked = st.feed(heading.map(|l| (l, plain)));
    needs_translation(plain) && !blocked
}

/// Collect translatable inline text *runs* in document order (full document).
pub fn collect_text_runs(blocks: &[Block]) -> Vec<(usize, String)> {
    collect_text_runs_windowed(blocks, None)
}

/// 窗口化 run 收集：只收集所属块（data-bi 空间）在窗口内的 run；
/// run 自身索引仍按全文推进（data-ri 空间全局），窗口外/不可译块的 run
/// 占号不收集（与 html.rs push_inlines 的恒占号一致）。
pub fn collect_text_runs_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut bi = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    walk_run_collect(blocks, &mut counter, &mut bi, &mut st, window, &mut out);
    out
}

fn walk_run_collect(
    blocks: &[Block],
    counter: &mut usize,
    bi: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, Some(*level), &plain);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline(text, counter, out, in_window(b_idx, window));
                } else {
                    collect_runs_inline(text, counter, out, false);
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                let trans = block_translatable(st, None, &plain);
                if trans {
                    let b_idx = *bi;
                    *bi += 1;
                    collect_runs_inline(text, counter, out, in_window(b_idx, window));
                } else {
                    collect_runs_inline(text, counter, out, false);
                }
            }
            Block::Quote { blocks } => walk_run_collect(blocks, counter, bi, st, window, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_run_collect(&it.blocks, counter, bi, st, window, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    let plain = inline_plain_text(h);
                    let trans = block_translatable(st, None, &plain);
                    if trans {
                        let b_idx = *bi;
                        *bi += 1;
                        collect_runs_inline(h, counter, out, in_window(b_idx, window));
                    } else {
                        collect_runs_inline(h, counter, out, false);
                    }
                }
                for row in rows {
                    for cell in row {
                        let plain = inline_plain_text(cell);
                        let trans = block_translatable(st, None, &plain);
                        if trans {
                            let b_idx = *bi;
                            *bi += 1;
                            collect_runs_inline(cell, counter, out, in_window(b_idx, window));
                        } else {
                            collect_runs_inline(cell, counter, out, false);
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}

/// `collect` = false 时仍推进 run 计数（恒占号）但不收集。
fn collect_runs_inline(
    inlines: &[Inline],
    counter: &mut usize,
    out: &mut Vec<(usize, String)>,
    collect: bool,
) {
    for il in inlines {
        match il {
            Inline::Text(t) => {
                let idx = *counter;
                *counter += 1;
                if collect && !t.trim().is_empty() && needs_translation(t) {
                    out.push((idx, t.clone()));
                }
            }
            Inline::Strong(x) | Inline::Emph(x) | Inline::Del(x) => {
                collect_runs_inline(x, counter, out, collect)
            }
            Inline::Link { text, .. } => collect_runs_inline(text, counter, out, collect),
            Inline::Math(_) => {}
            _ => {}
        }
    }
}

/// Collect translatable text units in document order (full document).
pub fn collect_translatable(blocks: &[Block]) -> Vec<(usize, String)> {
    collect_translatable_windowed(blocks, None)
}

/// 窗口化块收集：只收集块索引 ∈ 窗口的单元（索引空间 = data-bi）。
pub fn collect_translatable_windowed(
    blocks: &[Block],
    window: Option<(usize, usize)>,
) -> Vec<(usize, String)> {
    let mut counter = 0usize;
    let mut st = RefSkipState::default();
    let mut out = Vec::new();
    walk_collect(blocks, &mut counter, &mut st, window, &mut out);
    out
}

fn walk_collect(
    blocks: &[Block],
    counter: &mut usize,
    st: &mut RefSkipState,
    window: Option<(usize, usize)>,
    out: &mut Vec<(usize, String)>,
) {
    for b in blocks {
        match b {
            Block::Heading { level, text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, Some(*level), &plain) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Paragraph { text } => {
                let plain = inline_plain_text(text);
                if block_translatable(st, None, &plain) {
                    if in_window(*counter, window) {
                        out.push((*counter, plain.clone()));
                    }
                    *counter += 1;
                }
            }
            Block::Quote { blocks } => walk_collect(blocks, counter, st, window, out),
            Block::List { items, .. } => {
                for it in items {
                    walk_collect(&it.blocks, counter, st, window, out);
                }
            }
            Block::Table { headers, rows } => {
                for h in headers {
                    let p = inline_plain_text(h);
                    if block_translatable(st, None, &p) {
                        if in_window(*counter, window) {
                            out.push((*counter, p.clone()));
                        }
                        *counter += 1;
                    }
                }
                for row in rows {
                    for cell in row {
                        let p = inline_plain_text(cell);
                        if block_translatable(st, None, &p) {
                            if in_window(*counter, window) {
                                out.push((*counter, p.clone()));
                            }
                            *counter += 1;
                        }
                    }
                }
            }
            Block::Math { .. } => {}
            _ => {}
        }
    }
}
```

注意：原 `collect_runs_inline` 的 `Inline::Math(_)` 分支保留，`Inline::DisplayMath` 等其余走 `_ => {}`。

- [ ] **Step 2: 追加测试（units.rs `mod tests` 内，保留既有两条）**

```rust
    #[test]
    fn windowed_translatable_filters_by_block_index() {
        let blocks = parse_blocks("One\n\nTwo\n\nThree\n\nFour\n\nFive");
        let all = collect_translatable(&blocks);
        assert_eq!(all.len(), 5);
        let w = collect_translatable_windowed(&blocks, Some((1, 3)));
        assert_eq!(w, vec![(1usize, "Two".into()), (2usize, "Three".into())]);
        assert_eq!(collect_translatable_windowed(&blocks, Some((4, 99))).len(), 1);
    }

    #[test]
    fn windowed_runs_filter_by_owning_block() {
        // 两段各两个 run；窗口只含第二段 → 只收集第二段的 run，
        // 但 run 索引保持全局（第二段首 run = 2）。
        let blocks = parse_blocks("Alpha beta\n\nGamma delta");
        let w = collect_text_runs_windowed(&blocks, Some((1, 2)));
        assert_eq!(w, vec![(2usize, "Gamma".into()), (3usize, "delta".into())]);
    }

    #[test]
    fn reference_section_skipped_in_collectors() {
        let blocks = parse_blocks(
            "# Intro\n\n## References\n\nSmith 2020.\n\n## Acknowledgements\n\nThanks to all.",
        );
        let u = collect_translatable(&blocks);
        assert_eq!(
            u,
            vec![
                (0usize, "Intro".into()),
                (1usize, "Acknowledgements".into()),
                (2usize, "Thanks to all.".into()),
            ]
        );
        // 区段内 run 不收集，但 run 计数照常推进（Smith 2020. 是 idx1）
        let r = collect_text_runs(&blocks);
        assert_eq!(
            r,
            vec![
                (0usize, "Intro".into()),
                (4usize, "Acknowledgements".into()),
                (5usize, "Thanks to all.".into()),
            ]
        );
    }

    #[test]
    fn chinese_only_blocks_still_feed_skip_state() {
        // 纯中文块在区段内/外都不收集，但不影响后续复位判定
        let blocks = parse_blocks("## References\n\n纯中文\n\n## Conclusion\n\nResult text");
        let u = collect_translatable(&blocks);
        assert_eq!(u, vec![(0usize, "Result text".into())]);
    }
```

- [ ] **Step 3: 跑测试**

Run: `cargo test --lib -q markdown::units`
Expected: PASS（新旧测试全绿）

- [ ] **Step 4: 全库编译确认无其他调用点破坏**

Run: `cargo check --lib -q`
Expected: 无错误（collect_* 签名未变，bridge 调用点不受影响）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/markdown/units.rs
git commit -m "feat(markdown): 单元收集整合文献区段跳过 + 窗口化收集（run/块双空间）"
```

---

### Task 3: `markdown/html.rs` — 占号接入 skip（对齐锚定）

**Files:**
- Modify: `src-tauri/src/markdown/html.rs`（Ctx 增 ref_state；bi_advance 喂状态机；4 个调用点传 heading）

**Interfaces:**
- Consumes: `translate::skip::RefSkipState`（Task 1）。
- Produces: 行为变化——区段块无 data-bi、无 tr-box；data-bi 空间与 `collect_translatable_windowed(blocks, None)` 逐位一致（测试锚定）。render_html 对外签名不变。

- [ ] **Step 1: 修改 Ctx 与 bi_advance**

`struct Ctx` 增字段（`outline: Vec<OutlineItem>,` 之后）：

```rust
    /// 参考文献区段状态机：与 units.rs 收集器同源判定（Task: skip.rs）
    ref_state: crate::translate::skip::RefSkipState,
```

`render_html` 初始化处（`outline: Vec::new(),` 后）：

```rust
        ref_state: crate::translate::skip::RefSkipState::default(),
```

`bi_advance` 改为（heading 参数：Heading 块传 `Some(level)`，Paragraph/table 单元格传 `None`）：

```rust
    /// Assign the block-space index for this block/cell if it is translatable.
    /// 恒占号（与 units::collect_translatable 逐块一致），无论当前渲染形态——
    /// 原文/done 渲染的 data-bi 锚点编号因此与 partial 事件的 index 同空间。
    /// 参考文献区段内的块不占号（skip 判定与收集器同源，Task skip.rs）。
    /// 返回 None 表示本块不占号（不开 data-bi、不追加 tr-box）。
    fn bi_advance(&mut self, plain: &str, heading: Option<u8>) -> Option<usize> {
        let blocked = self
            .ref_state
            .feed(heading.map(|l| (l, plain)));
        if !needs_translation(plain) || blocked {
            return None;
        }
        let idx = self.bi_counter;
        self.bi_counter += 1;
        Some(idx)
    }
```

4 个调用点：Heading（`html.rs:104`）→ `self.bi_advance(&plain, Some(*level))`；Paragraph（`html.rs:115`）、表头单元格（`html.rs:175`）、表体单元格（`html.rs:189`）→ `self.bi_advance(&plain, None)`。

- [ ] **Step 2: 追加对齐测试（html.rs `mod tests` 内）**

```rust
    #[test]
    fn reference_section_blocks_have_no_bi_anchor() {
        let md = "# Intro\n\n## References\n\nSmith 2020.\n\n## Acknowledgements\n\nThanks.";
        let r = render_html(md, &HashMap::new(), false);
        assert!(r.html.contains(r#"<h2 id="h-2">References</h2>"#), "区段入口无 data-bi");
        assert!(!r.html.contains(r#"Smith 2020"#.replace("Smith 2020", "").as_str()) || true);
        assert!(r.html.contains("<p>Smith 2020.</p>"), "区段内段落无 data-bi 无 tr-box");
        assert!(r.html.contains(r#"<h2 id="h-4" data-bi="1">Acknowledgements</h2>"#), "复位后标题重新占号");
        assert!(r.html.contains(r#"<p data-bi="2">Thanks.</p>"#));
    }

    #[test]
    fn data_bi_sequence_matches_collect_translatable_with_skip() {
        // 对齐铁律：渲染占号序列 == 收集索引序列（含 quote/list/table 混合 + 文献区段）
        let md = concat!(
            "# Eng Title\n\n",
            "Hello **world**.\n\n",
            "> quoted eng\n\n",
            "- list eng\n- 中文跳过\n\n",
            "| Hcol | 中文 |\n|---|---|\n| Cell eng | 中文格 |\n\n",
            "## References\n\nSmith 2020.\n\n",
            "## Next\n\nTail eng\n",
        );
        let r = render_html(md, &HashMap::new(), false);
        // 从 html 依序抠出 data-bi 编号
        let mut rendered = Vec::new();
        let mut rest = r.html.as_str();
        while let Some(p) = rest.find("data-bi=\"") {
            let after = &rest[p + 9..];
            let end = after.find('"').unwrap();
            rendered.push(after[..end].parse::<usize>().unwrap());
            rest = &after[end + 1..];
        }
        let blocks = crate::markdown::parse_blocks(md);
        let collected: Vec<usize> =
            crate::markdown::units::collect_translatable(&blocks).iter().map(|&(i, _)| i).collect();
        assert_eq!(rendered, collected, "渲染占号与收集索引必须逐位一致");
    }
```

（第一步里 `assert!(!r.html...|| true)` 那行是噪音，直接删掉，只留后三条断言。）

- [ ] **Step 3: 跑测试**

Run: `cargo test --lib -q markdown::html`
Expected: PASS（对齐测试是本任务的验收锚点）

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/markdown/html.rs
git commit -m "feat(markdown): html 占号接入文献区段跳过——与收集器逐位对齐（回归锚定）"
```

---

### Task 4: `translate/engine.rs` — Unit 事件携带 from_cache

**Files:**
- Modify: `src-tauri/src/translate/engine.rs`（enum + 2 个 emit 点 + 测试模式匹配）

**Interfaces:**
- Produces: `EngineEvent::Unit { index, text, from_cache: bool }`（缓存命中=true）。Task 5 的 bridge 据此填 partial 事件。

- [ ] **Step 1: 改枚举与两个 emit 点**

```rust
pub enum EngineEvent {
    /// One unit's translation is ready. `from_cache` = 缓存命中（前端据此
    /// 跳过打字动画直接上屏，qingniao round2 #5 语义）。
    Unit { index: usize, text: String, from_cache: bool },
    Progress { done: usize, total: usize },
    #[allow(dead_code)]
    Failed { index: usize, error: String },
}
```

缓存命中路径（`engine.rs:187`）：`emit(EngineEvent::Unit { index: req.units[i].0, text: v.to_string(), from_cache: true });`
commit 路径（`engine.rs:225`）：`emit(EngineEvent::Unit { index: doc_index, text: t.clone(), from_cache: false });`

- [ ] **Step 2: 更新既有测试的模式匹配（`engine.rs:563`、`engine.rs:628`）**

`if let EngineEvent::Unit { index, .. } = e` 不用动；`if let EngineEvent::Unit { index, text } = e` 改为 `if let EngineEvent::Unit { index, text, .. } = e`。

- [ ] **Step 3: 追加测试（engine.rs mod tests）**

```rust
    #[test]
    fn unit_events_carry_from_cache_flag() {
        // 预置缓存 → 命中单元 from_cache=true；网络单元 false
        let (http, _mock) = {
            let m = crate::translate::http::test_mock::MockClient::new();
            m.put("https://llm.test/v1/chat/completions", 200, r#"{"choices":[{"message":{"content":"<<<B0>>>你好<<<END>>>"}}]}"#);
            (m.clone(), m)
        };
        let mut cache = Cache::new();
        cache.set(Cache::key("llm", "m@v1", "Hello"), "你好缓存".into());
        let creds = Creds(HashMap::from([("baseUrl".into(), "https://llm.test/v1".into()), ("apiKey".into(), "k".into()), ("model".into(), "m".into())]));
        let units = vec![(0usize, "Hello".to_string()), (1usize, "World".to_string())];
        let req = EngineRequest {
            provider: "llm",
            creds: &creds,
            units: &units,
            http: &http,
            config: EngineConfig { units_per_batch: 8, max_batch_chars: 4000, concurrency: 1, timeout_ms: 1000 },
            cache_variant: "m@v1",
        };
        let mut flags = Vec::new();
        let _ = run(&req, &mut cache, &|ev| if let EngineEvent::Unit { index, from_cache, .. } = ev {
            flags.push((index, from_cache));
        });
        assert_eq!(flags, vec![(0usize, true), (1usize, false)], "缓存命中=true，网络=false");
    }
```

（MockClient 的 API 以 `src-tauri/src/translate/http.rs` 的 `test_mock` 实际方法名为准——先读该文件确认 `put`/注册方法签名再写；若方法名不同，按实际调整这几行。）

- [ ] **Step 4: 跑测试**

Run: `cargo test --lib -q translate::engine`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/translate/engine.rs
git commit -m "feat(translate): EngineEvent::Unit 携带 from_cache——缓存命中瞬时上屏的地基"
```

---

### Task 5: `bridge.rs` — 窗口参数 · 窗口化载荷 · render_translated · first_index

**Files:**
- Modify: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`（generate_handler 注册 `render_translated`）

**Interfaces:**
- Consumes: Task 2 的 `collect_*_windowed`、Task 4 的 from_cache。
- Produces（前端 TS 侧 Task 6 对应）:
  - `translate_document(content, mode, provider, creds, window: Option<[usize;2]>) -> TranslateStart`
  - `TranslateStart::Started { r#gen, first_index }`（窗口化 run 的最小全局索引；全文=收集器首索引）
  - `TranslateStart::Cached { done }`——窗口化时 done **不含** html_original/html_translation/html_bilingual/outline
  - `TranslationPartialEvt { gen, index, text, from_cache }`
  - 窗口化 run 的 done 同样省略 html 字段（translations 照旧）
  - 新命令 `render_translated(content, mode, translations: Vec<(usize,String)>) -> ParseResult`

- [ ] **Step 1: 修改 translate_document**

```rust
#[tauri::command]
pub fn translate_document(
    app: AppHandle,
    content: String,
    mode: String,
    provider: String,
    creds: HashMap<String, String>,
    window: Option<[usize; 2]>,
    state: tauri::State<AppTxn>,
) -> Result<TranslateStart, String> {
    note_translate_activity();
    let meta = translate::providers_meta::get(&provider)
        .ok_or_else(|| format!("未知翻译源：{provider}"))?;
    let blocks = markdown::parse_blocks(&content);
    let win_range = window.map(|[top, end]| (top, end));
    let units = match mode.as_str() {
        "translation" => markdown::units::collect_text_runs_windowed(&blocks, win_range),
        "bilingual" => markdown::units::collect_translatable_windowed(&blocks, win_range),
        other => return Err(format!("不支持的模式：{other}")),
    };
    let snapshot = state.cache.lock().expect("cache mutex poisoned").clone();
    let (indices, texts): (Vec<usize>, Vec<String>) = units.into_iter().unzip();
    let bilingual = mode == "bilingual";
    let variant = translate::engine::cache_variant(
        &provider,
        creds.get("model").map(|s| s.as_str()).unwrap_or_default(),
    );
    if let Some(done) = cached_done_evt(
        &provider,
        &variant,
        &snapshot,
        &indices,
        &texts,
        &content,
        bilingual,
        window.is_some(),
    ) {
        return Ok(TranslateStart::Cached { done });
    }
    state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "已有翻译在进行".to_string())?;
    let r#gen = state.r#gen.fetch_add(1, Ordering::SeqCst) + 1;
    state.cancel.store(false, Ordering::SeqCst);
    let first_index = indices.first().copied().unwrap_or(0);

    let st = WorkerState {
        cache: Arc::clone(&state.cache),
        cancel: Arc::clone(&state.cancel),
        running: Arc::clone(&state.running),
    };
    spawn_translation(
        app,
        r#gen,
        texts,
        indices,
        provider,
        creds,
        meta,
        st,
        snapshot,
        content,
        bilingual,
        window.is_some(),
    );
    Ok(TranslateStart::Started { r#gen, first_index })
}
```

- [ ] **Step 2: cached_done_evt 增 windowed 参数（省略 html 字段）**

签名加 `windowed: bool`；构造 evt 处：

```rust
    let (html_original, html_translation, html_bilingual, outline) = if windowed {
        // 窗口化载荷不携带整树 html：后端只有窗口 pairs，整树渲染会把
        // 窗口外已译块打回原文。显示由前端 patch 承担。
        (None, None, None, None)
    } else {
        let (html_original, html_translation, html_bilingual, outline) =
            html_payload_parts(content, &map, bilingual);
        (Some(html_original), html_translation, html_bilingual, Some(outline))
    };
```

- [ ] **Step 3: spawn_translation 增 windowed 参数 + partial 事件带 from_cache + done 载荷省略 html**

签名加 `windowed: bool`（放 `bilingual: bool,` 后）。emit 的 Unit 分支：

```rust
            translate::engine::EngineEvent::Unit { index, text, from_cache } => {
                let _ = app_evt.emit(
                    "translation-partial",
                    TranslationPartialEvt { r#gen, index, text, from_cache },
                );
            }
```

`TranslationPartialEvt` 增字段：

```rust
#[derive(Clone, serde::Serialize)]
pub struct TranslationPartialEvt {
    pub r#gen: u64,
    pub index: usize,
    pub text: String,
    pub from_cache: bool,
}
```

done 载荷构造：

```rust
        let payload = if ok {
            let map: HashMap<usize, String> = pairs.iter().cloned().collect();
            if windowed {
                TranslationDoneEvt {
                    r#gen,
                    ok: true,
                    translations: Some(pairs),
                    error: None,
                    html_original: None,
                    html_translation: None,
                    html_bilingual: None,
                    outline: None,
                }
            } else {
                let (html_original, html_translation, html_bilingual, outline) =
                    html_payload_parts(&content, &map, bilingual);
                TranslationDoneEvt {
                    r#gen,
                    ok: true,
                    translations: Some(pairs),
                    error: None,
                    html_original: Some(html_original),
                    html_translation,
                    html_bilingual,
                    outline: Some(outline),
                }
            }
        } else { /* 原失败分支不动 */ };
```

- [ ] **Step 4: 新命令 render_translated**

```rust
/// 会话收口重建：用前端累积的完整 translations 表渲染整树 canonical html。
/// 与 parse_markdown 同返回形态（ParseResult）；mode 决定替换形态。
#[tauri::command(async)]
pub fn render_translated(
    content: String,
    mode: String,
    translations: Vec<(usize, String)>,
) -> Result<markdown::html::ParseResult, String> {
    let bilingual = match mode.as_str() {
        "translation" => false,
        "bilingual" => true,
        other => return Err(format!("不支持的模式：{other}")),
    };
    let map: HashMap<usize, String> = translations.into_iter().collect();
    Ok(markdown::html::render_html(&content, &map, bilingual))
}
```

`lib.rs` 的 `generate_handler!` 列表（`bridge::translate_document` 附近）加 `bridge::render_translated,`。

- [ ] **Step 5: 更新/追加测试（bridge.rs mod tests）**

`translation_partial_evt_wire_shape` 增 from_cache：

```rust
    #[test]
    fn translation_partial_evt_wire_shape() {
        let e = TranslationPartialEvt {
            r#gen: 4,
            index: 12,
            text: "译文".into(),
            from_cache: true,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["gen"], 4);
        assert_eq!(v["index"], 12);
        assert_eq!(v["text"], "译文");
        assert_eq!(v["from_cache"], true);
    }
```

`cached_precheck_returns_payload_only_on_full_hit`：所有 `cached_done_evt(...)` 调用补尾参 `false`；末尾追加窗口化断言：

```rust
        let evt_w = cached_done_evt("p", "", &c, &[0, 1], &["a".into(), "b".into()], "# t\n\na b", false, true)
            .expect("窗口化全命中");
        assert!(evt_w.html_original.is_none());
        assert!(evt_w.html_translation.is_none());
        assert!(evt_w.html_bilingual.is_none());
        assert!(evt_w.outline.is_none());
        assert_eq!(evt_w.translations, Some(vec![(0usize, "甲".into()), (1usize, "乙".into())]));
```

追加 wire 形状测试：

```rust
    #[test]
    fn windowed_done_evt_omits_html_fields() {
        let e = TranslationDoneEvt {
            r#gen: 9,
            ok: true,
            translations: Some(vec![(3, "窗".into())]),
            error: None,
            html_original: None,
            html_translation: None,
            html_bilingual: None,
            outline: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("html_original").is_none());
        assert!(v.get("html_translation").is_none());
        assert!(v.get("html_bilingual").is_none());
        assert!(v.get("outline").is_none());
        assert_eq!(v["translations"], serde_json::json!([[3, "窗"]]));
    }

    #[test]
    fn render_translated_builds_canonical_html() {
        let r = render_translated(
            "# Ti\n\nHello world".into(),
            "bilingual".into(),
            vec![(0usize, "中文标题".into()), (1usize, "你好世界".into())],
        )
        .unwrap();
        assert!(r.html.contains(r#"<div class="tr-box">中文标题</div>"#));
        assert!(r.html.contains(r#"<div class="tr-box">你好世界</div>"#));
        let r2 = render_translated("Hi".into(), "original".into(), vec![]).unwrap_err();
        assert!(r2.contains("不支持的模式"));
    }
```

- [ ] **Step 6: 跑测试 + 编译**

Run: `cargo test --lib -q bridge` 然后 `cargo check --lib -q`
Expected: PASS / 无错误

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/bridge.rs src-tauri/src/lib.rs
git commit -m "feat(bridge): translate_document 窗口参数 + 窗口化载荷省略整树 html + render_translated 收口命令"
```

---

### Task 6: 前端 IPC 类型与命令（types/ipc.ts + ipc.ts）

**Files:**
- Modify: `src/types/ipc.ts`
- Modify: `src/lib/ipc.ts`

**Interfaces:**
- Consumes: Task 5 的 wire 形状。
- Produces（Task 8/9/11 消费）:
  - `TranslationPartialPayload { gen; index; text; from_cache: boolean }`
  - `TranslateStart = { kind: "started"; gen: number; first_index: number } | { kind: "cached"; done: DonePayload }`
  - `api.translateDocument(c, m, p, creds, window: [number, number] | null)`
  - `api.renderTranslated(content, mode: "translation" | "bilingual", translations: Array<[number, string]>) => Promise<ParseResult>`

- [ ] **Step 1: types/ipc.ts 改动**

`TranslationPartialPayload` 加注释与字段：

```ts
/** lib.rs TranslationPartialEvt：{gen, index, text, from_cache}。
 * index 与 translation-done 的 pair 首元素同一索引空间：
 * translation 模式 = text runs（data-ri），bilingual 模式 = translatable 块（data-bi）。
 * from_cache = 缓存命中（前端跳过打字动画直接上屏）。 */
export interface TranslationPartialPayload {
  gen: number;
  index: number;
  text: string;
  from_cache: boolean;
}
```

`TranslateStart`：

```ts
export type TranslateStart =
  | { kind: "started"; gen: number; first_index: number }
  | { kind: "cached"; done: DonePayload };
```

`DonePayload` 注释补一句「窗口化 run 的 done 不携带 html_*/outline 字段」。

- [ ] **Step 2: ipc.ts 改动**

```ts
  translateDocument: (
    c: string,
    m: Mode,
    p: string,
    creds: Record<string, string>,
    window: [number, number] | null,
  ) =>
    invoke<TranslateStart>("translate_document", {
      content: c,
      mode: m,
      provider: p,
      creds,
      window,
    }),
  /** 会话收口重建：用累积 translations 渲染整树 canonical html（Task: 收口） */
  renderTranslated: (
    c: string,
    m: "translation" | "bilingual",
    translations: Array<[number, string]>,
  ) => invoke<ParseResult>("render_translated", { content: c, mode: m, translations }),
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 报 `useTranslationStore.ts` 里 translateDocument 调用参数不匹配（预期 RED——Task 9 修）；**除该调用点外无其他错误**。若出现别的错误先修再继续。

- [ ] **Step 4: Commit**

```bash
git add src/types/ipc.ts src/lib/ipc.ts
git commit -m "feat(ipc): 窗口化 translate_document 参数 + from_cache 载荷 + renderTranslated 命令类型"
```

---

### Task 7: `lib/typewriter.ts` — pending 携带 fromCache + 起点基址

**Files:**
- Modify: `src/lib/typewriter.ts`
- Modify: `src/lib/typewriter.test.ts`（补用例）

**Interfaces:**
- Produces（Task 9 消费）:
  - `typewriterStart(base = 0): TypewriterState`
  - `typewriterPush(s, index, text, fromCache): { state, released: Released[] }`
  - `Released { index; text; fromCache: boolean }`

- [ ] **Step 1: 重写 typewriter.ts**

```ts
// 打字机缓冲：把"按完成序到达"的译文块重排成"按文档序放行"。
//
// 引擎并发 worker 先完成先发事件，直接上屏会出现"哪块先译完哪块先出现"。
// 这里用游标 + 等位缓冲实现严格文档序：index === cursor 的块立即放行并把
// 连续命中的后续块一并放行；index 超前（缺口未填）的块在 pending 等位。
// 网络吞吐不变，纯显示层重排。全部不可变更新（zustand setState 惯例）。
//
// 窗口化 run（视口按需）的索引不从 0 开始：typewriterStart(base) 携带本轮
// 最小索引（后端 TranslateStart.first_index），游标从基址起算。
// fromCache 随条目走放行链路（放行批次可能混着缓存/网络单元），由 reveal
// 层决定是否跳过打字动画。
export interface Released {
  index: number;
  text: string;
  fromCache: boolean;
}

export interface TypewriterState {
  /** 已放行的连续前缀上界（exclusive）：base..cursor 全部已放行 */
  cursor: number;
  /** 序号 ≥ cursor 的到货块，等位中 */
  pending: Map<number, Released>;
}

export function typewriterStart(base = 0): TypewriterState {
  return { cursor: base, pending: new Map() };
}

export function typewriterPush(
  s: TypewriterState,
  index: number,
  text: string,
  fromCache: boolean,
): { state: TypewriterState; released: Released[] } {
  const pending = new Map(s.pending);
  pending.set(index, { index, text, fromCache });
  const released: Released[] = [];
  let cursor = s.cursor;
  while (pending.has(cursor)) {
    released.push(pending.get(cursor)!);
    pending.delete(cursor);
    cursor += 1;
  }
  return { state: { cursor, pending }, released };
}
```

- [ ] **Step 2: 更新 typewriter.test.ts（现有用例的 push 调用补第三参 false；追加用例）**

```ts
describe("窗口化基址", () => {
  it("cursor 从 base 起算，乱序到达按序放行", () => {
    let s = typewriterStart(37);
    const r1 = typewriterPush(s, 38, "乙", false);
    expect(r1.released).toHaveLength(0);
    s = r1.state;
    const r2 = typewriterPush(s, 37, "甲", true);
    expect(r2.released.map((r) => [r.index, r.text, r.fromCache])).toEqual([
      [37, "甲", true],
      [38, "乙", false],
    ]);
  });
});
```

- [ ] **Step 3: 类型检查（vitest 沙箱不可跑，tsc 验证；测试真跑留给用户本地）**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 除 Task 6 已知的 useTranslationStore 调用点错误外无新错误

- [ ] **Step 4: Commit**

```bash
git add src/lib/typewriter.ts src/lib/typewriter.test.ts
git commit -m "feat(typewriter): 窗口化基址 + 放行条目携带 fromCache"
```

---

### Task 8: `lib/reveal.ts` — 逐字 reveal 队列（纯逻辑）

**Files:**
- Create: `src/lib/reveal.ts`
- Create: `src/lib/reveal.test.ts`

**Interfaces:**
- Produces（Task 9 消费）:
  - `TYPE_SPEED = 200`、`TICK_MS = 30`、`CHARS_PER_TICK = 6`
  - `RevealCommit = { kind: "start"; index } | { kind: "tick"; index; text } | { kind: "done"; index; text } | { kind: "instant"; index; text }`
  - `revealStart(regionStart = 0, regionEnd = Infinity): RevealState`
  - `revealPush(s, index, text, instant) => { state, commits }`
  - `revealTick(s) => { state, commits }`（空转返回 commits: []）
  - `revealSetRegion(s, start, end) => { state, commits }`（区域外缓冲/打字瞬时 flush）
  - `revealDrain(s) => { state, commits }`（全部瞬时 flush，用于 resetDisplay）
  - `revealIdle(s) => boolean`

- [ ] **Step 1: 写实现**

```ts
// 逐字 reveal 队列（qingniao reveal.rs 的 TS 移植，纯逻辑、无 React/DOM 依赖）。
//
// 输入：已按文档序放行的块（typewriterPush 产物）+ 是否跳过动画（缓存命中）。
// 输出：commit 流——start（开始打字，UI 锁行高）/ tick（切片上屏）/
// done（完整定格）/ instant（跳过动画直接完整上屏）。
// tick 由 store 的 30ms 定时器驱动；DOM 写入由 PreviewView 的 patcher 承担，
// 本模块只做状态推进，可离线注入 tick 测试。
export const TYPE_SPEED = 200; // 字/秒（qingniao round2 定值：整行 ≈0.3s）
export const TICK_MS = 30;
/** 每 tick 推进字符数 = 200 × 0.03 = 6。 */
export const CHARS_PER_TICK = Math.round((TYPE_SPEED * TICK_MS) / 1000);

export type RevealCommit =
  | { kind: "start"; index: number }
  | { kind: "tick"; index: number; text: string }
  | { kind: "done"; index: number; text: string }
  | { kind: "instant"; index: number; text: string };

interface RevealEntry {
  index: number;
  chars: string[]; // Array.from 切分：UTF-16 代理对安全（emoji/CJK 不劈半）
}

export interface RevealState {
  /** 当前波次区域 [regionStart, regionEnd)：区域内按序打字，区域外瞬时上屏 */
  regionStart: number;
  regionEnd: number;
  queue: RevealEntry[];
  typing: (RevealEntry & { shown: number }) | null;
}

export function revealStart(regionStart = 0, regionEnd = Number.POSITIVE_INFINITY): RevealState {
  return { regionStart, regionEnd, queue: [], typing: null };
}

export function revealIdle(s: RevealState): boolean {
  return s.queue.length === 0 && s.typing === null;
}

export function revealPush(
  s: RevealState,
  index: number,
  text: string,
  instant: boolean,
): { state: RevealState; commits: RevealCommit[] } {
  if (instant) {
    return { state: s, commits: [{ kind: "instant", index, text }] };
  }
  const queue = [...s.queue, { index, chars: Array.from(text) }];
  return { state: { ...s, queue }, commits: [] };
}

/** 推进一个 tick：空闲则尝试从队首起块（须在区域内），否则打字切片推进。 */
export function revealTick(s: RevealState): { state: RevealState; commits: RevealCommit[] } {
  let typing = s.typing;
  let queue = s.queue;
  if (typing === null) {
    const head = queue[0];
    if (!head || head.index < s.regionStart || head.index >= s.regionEnd) {
      return { state: s, commits: [] }; // 空转：队列空或队首在区域外
    }
    queue = queue.slice(1);
    typing = { ...head, shown: 0 };
    // 首个 tick 即吐出第一批字符（start + tick 合并发送，节奏更顺）
    const shown = Math.min(CHARS_PER_TICK, typing.chars.length);
    const text = typing.chars.slice(0, shown).join("");
    if (shown >= typing.chars.length) {
      return {
        state: { ...s, queue, typing: null },
        commits: [
          { kind: "start", index: typing.index },
          { kind: "done", index: typing.index, text: typing.chars.join("") },
        ],
      };
    }
    return {
      state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: { ...typing, shown } },
      commits: [
        { kind: "start", index: typing.index },
        { kind: "tick", index: typing.index, text },
      ],
    };
  }
  const shown = Math.min(typing.shown + CHARS_PER_TICK, typing.chars.length);
  const text = typing.chars.slice(0, shown).join("");
  if (shown >= typing.chars.length) {
    return {
      state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: null },
      commits: [{ kind: "done", index: typing.index, text: typing.chars.join("") }],
    };
  }
  return {
    state: { regionStart: s.regionStart, regionEnd: s.regionEnd, queue, typing: { ...typing, shown } },
    commits: [{ kind: "tick", index: typing.index, text }],
  };
}

/** 重锚：新区域外的打字/缓冲全部瞬时上屏，区域内保留继续按序。 */
export function revealSetRegion(
  s: RevealState,
  start: number,
  end: number,
): { state: RevealState; commits: RevealCommit[] } {
  const commits: RevealCommit[] = [];
  let typing = s.typing;
  if (typing && (typing.index < start || typing.index >= end)) {
    commits.push({ kind: "done", index: typing.index, text: typing.chars.join("") });
    typing = null;
  }
  const keep: RevealEntry[] = [];
  for (const e of s.queue) {
    if (e.index < start || e.index >= end) {
      commits.push({ kind: "instant", index: e.index, text: e.chars.join("") });
    } else {
      keep.push(e);
    }
  }
  return { state: { regionStart: start, regionEnd: end, queue: keep, typing }, commits };
}

/** 全部排空为瞬时上屏（resetDisplay / 会话清理用）。 */
export function revealDrain(s: RevealState): { state: RevealState; commits: RevealCommit[] } {
  const commits: RevealCommit[] = [];
  if (s.typing) {
    commits.push({ kind: "done", index: s.typing.index, text: s.typing.chars.join("") });
  }
  for (const e of s.queue) {
    commits.push({ kind: "instant", index: e.index, text: e.chars.join("") });
  }
  return { state: revealStart(s.regionStart, s.regionEnd), commits };
}
```

- [ ] **Step 2: 写测试 reveal.test.ts**

```ts
import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TICK,
  revealDrain,
  revealIdle,
  revealPush,
  revealSetRegion,
  revealStart,
  revealTick,
  type RevealCommit,
} from "./reveal";

const textsOf = (cs: RevealCommit[]) => cs.map((c) => c.kind === "start" ? (`start:${c.index}`) : `${c.kind}:${c.index}:${"text" in c ? c.text : ""}`);

describe("reveal 队列", () => {
  it("按序打字：start → tick×N → done → 自动起下一块", () => {
    let s = revealStart(0, 100);
    s = revealPush(s, 0, "abcd", false).state;
    s = revealPush(s, 1, "efgh", false).state;
    const t1 = revealTick(s);
    expect(textsOf(t1.commits)).toEqual(["start:0", `tick:0:abc`].map((x) => x.replace("abc", "abcd".slice(0, CHARS_PER_TICK))));
    s = t1.state;
    // 连续 tick 直到 done
    let seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = revealTick(s);
      s = t.state;
      seen = seen.concat(textsOf(t.commits));
      if (t.commits.some((c) => c.kind === "done" && c.index === 0)) break;
    }
    expect(seen).toContain("done:0:abcd");
    expect(s.typing).toBeNull();
    // 下一 tick 起块 1
    const t2 = revealTick(s);
    expect(t2.commits[0]).toMatchObject({ kind: "start", index: 1 });
  });

  it("instant 不进队列直接 commit", () => {
    const s0 = revealStart();
    const r = revealPush(s0, 5, "缓存译文", true);
    expect(r.commits).toEqual([{ kind: "instant", index: 5, text: "缓存译文" }]);
    expect(revealIdle(r.state)).toBe(true);
  });

  it("队首在区域外不启动打字", () => {
    let s = revealStart(0, 4);
    s = revealPush(s, 10, "远离", false).state;
    const t = revealTick(s);
    expect(t.commits).toHaveLength(0);
  });

  it("setRegion：区域外打字与缓冲瞬时 flush，区域内保留", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 1, "打字中", false).state;
    s = revealPush(s, 2, "区域内", false).state;
    s = revealPush(s, 3, "区域外", false).state;
    // 推进让 1 进入 typing
    s = revealTick(s).state;
    expect(s.typing?.index).toBe(1);
    const r = revealSetRegion(s, 2, 6);
    const kinds = r.commits.map((c) => c.kind);
    expect(kinds).toContain("done"); // 打字中的 1 在区域外 → done 瞬时
    expect(kinds).toContain("instant"); // 3 在区域外 → instant
    expect(r.state.queue.map((e) => e.index)).toEqual([2]); // 2 保留
    expect(r.state.typing).toBeNull();
  });

  it("字节安全：代理对不被劈半", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "a😀b", false).state;
    let out = "";
    for (let i = 0; i < 10; i++) {
      const t = revealTick(s);
      s = t.state;
      for (const c of t.commits) if (c.kind === "tick" || c.kind === "done") out = c.text;
      if (revealIdle(s)) break;
    }
    expect(out).toBe("a😀b");
  });

  it("drain 排空一切为瞬时", () => {
    let s = revealStart(0, 10);
    s = revealPush(s, 0, "甲", false).state;
    s = revealPush(s, 1, "乙", false).state;
    s = revealTick(s).state; // 0 进入 typing
    const r = revealDrain(s);
    expect(r.commits.map((c) => c.kind).sort()).toEqual(["done", "instant"]);
    expect(revealIdle(r.state)).toBe(true);
  });
});
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无新增错误（reveal.ts 自身零错误）

- [ ] **Step 4: Commit**

```bash
git add src/lib/reveal.ts src/lib/reveal.test.ts
git commit -m "feat(reveal): 逐字 reveal 队列纯逻辑（200字/s + 区域重锚 flush + instant 直通）"
```

---

### Task 9: `useTranslationStore` — scope 状态机 + 窗口化调度 + reveal 驱动

**Files:**
- Modify: `src/stores/useTranslationStore.ts`（大改）

**Interfaces:**
- Consumes: Task 6/7/8 的 API。
- Produces（Task 10/11 消费）:
  - state 增：`scope: "off" | "viewport" | "full"`、`viewport: { top; bottom } | null`、`lastWindow: [number, number] | null`
  - actions：`setViewport(top, bottom)`、`translateDocument(scope?)`、`translateFull()`、`registerPatcher(fn | null)`、`resetDisplay()`、`resetDisplayIfStale(content)`
  - patcher 回调类型 = `RevealCommit`（PreviewView 据此落 DOM）
  - `partialBlocks`/`partialCursor` 语义改为「已定格（done/instant）的完整译文」；打字 tick 不进 React state

- [ ] **Step 1: 修改 store（完整给出新增/改动代码；未提及的现有逻辑保持）**

imports 增：

```ts
import {
  typewriterPush,
  typewriterStart,
  type TypewriterState,
} from "../lib/typewriter";
import {
  revealDrain,
  revealIdle,
  revealPush,
  revealSetRegion,
  revealStart,
  revealTick,
  TICK_MS,
  type RevealCommit,
  type RevealState,
} from "../lib/reveal";
```

模块级状态（替换现有 `twState` 一段）：

```ts
// 打字机缓冲 + reveal 队列（不进 React state：tick 不驱动渲染，只有放行结果才 set）
let twState: TypewriterState = typewriterStart();
let revealState: RevealState = revealStart();
let revealTimer: ReturnType<typeof setInterval> | undefined;
let revealPatcher: ((c: RevealCommit) => void) | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
// 视口窗口下界超出视口底的预取块数（qingniao round2 定值）
const WINDOW_PREFETCH = 4;

export type TranslateScope = "off" | "viewport" | "full";

interface TranslationState {
  // ……现有字段保持……
  /** 按需翻译作用域：off=未激活（滚动绝不触发）；viewport=滚到哪译到哪；full=整篇 */
  scope: TranslateScope;
  /** 最近上报视口（data-bi 块索引空间） */
  viewport: { top: number; bottom: number } | null;
  /** 当前/上轮 run 的窗口（null=全文）——done 后自动扩展评估用 */
  lastWindow: [number, number] | null;

  setViewport(top: number, bottom: number): void;
  translateDocument(scope?: TranslateScope): Promise<void>;
  translateFull(): void;
  registerPatcher(fn: ((c: RevealCommit) => void) | null): void;
  /** 彻底清显示（切原文/换内容时）：committed + 打字流 + reveal 全清 */
  resetDisplay(): void;
  /** 内容已变且与上轮 run 不符 → 清显示（applyEdit/换档调用，幂等廉价） */
  resetDisplayIfStale(content: string): void;
  // ……其余现有 action 保持……
}
```

模块级辅助（store 定义之前）：

```ts
function dispatchReveal(commits: RevealCommit[]) {
  if (commits.length === 0) return;
  const st = useTranslationStore.getState();
  const blocks = new Map(st.partialBlocks);
  let cursor = st.partialCursor;
  for (const c of commits) {
    revealPatcher?.(c);
    if (c.kind === "done" || c.kind === "instant") {
      blocks.set(c.index, c.text);
      cursor = Math.max(cursor, c.index + 1);
    }
  }
  useTranslationStore.setState({ partialBlocks: blocks, partialCursor: cursor });
}

function pumpReveal() {
  if (revealTimer !== undefined) return;
  if (revealIdle(revealState)) return;
  revealTimer = setInterval(() => {
    const out = revealTick(revealState);
    revealState = out.state;
    dispatchReveal(out.commits);
    if (revealIdle(revealState) && revealTimer !== undefined) {
      clearInterval(revealTimer);
      revealTimer = undefined;
    }
  }, TICK_MS);
}

function sameWindow(a: [number, number] | null, b: [number, number] | null): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
}

/** 会话静默后用累积 translations 重建整树 canonical html（切视图/重渲兜底）。 */
function scheduleCanonicalRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    const st = useTranslationStore.getState();
    const dd = useDocStore.getState();
    if (st.status === "running" || st.gen === 0) return;
    if (!dd.doc || dd.doc.content !== st.runContent) return;
    if (dd.mode === "original" || dd.translations.size === 0) return;
    if (!revealIdle(revealState)) {
      scheduleCanonicalRebuild(); // 还在打字：稍后再试
      return;
    }
    try {
      const r = await api.renderTranslated(
        dd.doc.content,
        dd.mode as "translation" | "bilingual",
        Array.from(dd.translations.entries()) as Array<[number, string]>,
      );
      const dd2 = useDocStore.getState();
      if (!dd2.doc || dd2.doc.content !== st.runContent) return; // 内容已变，丢弃
      useDocStore.getState().applyTranslationResult(new Map(dd2.translations), {
        contentKey: st.runContent!,
        mode: dd2.mode as Exclude<Mode, "original">,
        html: r.html,
      });
    } catch {
      /* 静默：patch DOM 已是显示真源 */
    }
  }, 400);
}
```

`handlePartial` 改（加 fromCache 直通 + reveal 驱动；内容/模式护栏保持）：

```ts
function handlePartial(p: TranslationPartialPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  if (useDocStore.getState().doc?.content !== st.runContent) return;
  if (useDocStore.getState().mode !== st.lastRunMode) return;
  const next = typewriterPush(twState, p.index, p.text, p.from_cache);
  twState = next.state;
  if (next.released.length === 0) return;
  for (const r of next.released) {
    const out = revealPush(revealState, r.index, r.text, r.fromCache);
    revealState = out.state;
    dispatchReveal(out.commits);
  }
  pumpReveal();
}
```

`clearPartial` 拆两用：

```ts
/** 起跑时重置打字流（committed 保留——已定格译文跨窗口持续显示）。 */
function resetStream(base: number) {
  twState = typewriterStart(base);
}

/** 彻底清显示（全文 done 落整树 / 切原文 / 内容过期）。 */
function clearAll() {
  twState = typewriterStart();
  const out = revealDrain(revealState);
  revealState = out.state;
  dispatchReveal(out.commits);
  useTranslationStore.setState({
    partialBlocks: new Map(),
    partialCursor: 0,
    partialGen: 0,
  });
}
```

`handleDone` 改（窗口化分支：merge + 评估扩展；全文分支保持原行为用 clearAll）：

```ts
function handleDone(d: DonePayload) {
  const st = useTranslationStore.getState();
  if (d.gen !== st.gen) return;
  const ui = useUiStore.getState();
  const dd = useDocStore.getState();
  if (!d.ok) {
    clearAll();
    useTranslationStore.setState({ status: "error", progress: null, scope: "off" });
    ui.addToast("error", d.error ? `翻译失败：${d.error}` : "翻译失败");
    return;
  }
  const windowed = st.lastWindow !== null;
  if (windowed) {
    // 窗口化：merge 累积（不整表 replace）；显示层继续走 committed/打字
    useDocStore.getState().mergeTranslations(d.translations ?? []);
    useTranslationStore.setState({ status: "idle", progress: null });
    // RunDone 边界评估：当前视口窗口 ≠ 上轮 → 接着译新窗口；相同 → 收口
    const cur = currentWindow(useTranslationStore.getState());
    if (!sameWindow(cur, st.lastWindow)) {
      void useTranslationStore.getState().translateDocument();
    } else {
      scheduleCanonicalRebuild();
    }
    return;
  }
  clearAll();
  useTranslationStore.setState({ status: "idle", progress: null });
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (contentFresh) {
    const translations = d.translations ? new Map(d.translations) : new Map<number, string>();
    useDocStore.getState().applyTranslationResult(translations, doneHtmlOf(d, st.runContent!));
  }
  ui.addToast("success", `翻译完成（${dd.doc?.name ?? ""}）`);
  if (dd.mode !== "original" && st.lastRunMode !== dd.mode) {
    useTranslationStore.getState().startIfFresh();
  }
}

/** 当前视口 → 窗口（块索引空间，含预取）；无上报回退 [0, PREFETCH)。 */
function currentWindow(st: { viewport: { top: number; bottom: number } | null }): [number, number] {
  const v = st.viewport;
  return v ? [v.top, v.bottom + WINDOW_PREFETCH] : [0, WINDOW_PREFETCH];
}
```

`translateDocument` 改（scope 化 + 窗口参数 + cached 分支分流）：

```ts
  translateDocument: async (scope) => {
    const dd = useDocStore.getState();
    const sp = useSettingsStore.getState().settings;
    if (!dd.doc || !sp || dd.mode === "original") return;
    if (get().status === "running") return;
    const sc: TranslateScope = scope ?? (get().scope === "off" ? "viewport" : get().scope);
    const win = sc === "viewport" ? currentWindow(get()) : null;
    try {
      const r = await api.translateDocument(
        dd.doc.content,
        dd.mode,
        sp.provider,
        useSettingsStore.getState().credsFor(sp.provider),
        win,
      );
      if (r.kind === "cached") {
        const d = r.done;
        if (win) {
          // 窗口化缓存全命中：merge + 瞬时上屏（载荷无整树 html）
          useDocStore.getState().mergeTranslations(d.translations ?? []);
          dispatchReveal(
            (d.translations ?? []).map(([index, text]) => ({ kind: "instant", index, text }) as RevealCommit),
          );
          set({ scope: sc, lastWindow: win });
          scheduleCanonicalRebuild();
          return; // 无 toast：窗口化不打扰（进度语义由后续 run 承担）
        }
        useDocStore.getState().applyTranslationResult(new Map(d.translations ?? []), doneHtmlOf(d, dd.doc.content));
        useUiStore.getState().addToast("success", `翻译完成（${dd.doc.name}·缓存）`);
        return;
      }
      resetStream(r.first_index); // 新打字流基点（窗口化索引非 0 起）
      if (win) {
        const out = revealSetRegion(revealState, win[0], win[1]);
        revealState = out.state;
        dispatchReveal(out.commits);
      }
      set({
        gen: r.gen,
        status: "running",
        progress: null,
        lastRunMode: dd.mode,
        runContent: dd.doc.content,
        scope: sc,
        lastWindow: win,
      });
      pumpReveal();
    } catch (e) {
      set({ status: "error" });
      useUiStore.getState().addToast("error", `发起翻译失败：${errText(e)}`);
    }
  },

  translateFull: () => {
    void get().translateDocument("full");
  },

  setViewport: (top, bottom) => {
    const st = get();
    if (st.viewport && st.viewport.top === top && st.viewport.bottom === bottom) return;
    set({ viewport: { top, bottom } });
    // 会话门：off/running 只记锚点；空闲且按需激活 → 立即评估起跑
    if (st.scope === "viewport" && st.status !== "running") void get().translateDocument();
  },

  registerPatcher: (fn) => {
    revealPatcher = fn;
  },

  resetDisplay: () => {
    clearAll();
    set({ scope: "off", viewport: null, lastWindow: null });
  },

  resetDisplayIfStale: (content) => {
    const st = get();
    if (st.runContent !== null && st.runContent !== content && (st.partialGen !== 0 || st.partialBlocks.size > 0)) {
      clearAll();
      set({ scope: "off", lastWindow: null });
    }
  },
```

`stop()` 改（scope 置 off；保留已定格显示；正在打的块让 ticker 打完——ticker 自会排空）：

```ts
  stop: () => {
    set((s) => ({ gen: s.gen + 1, status: "idle", progress: null, scope: "off", lastWindow: null }));
    // 打字流等位丢弃（缺口永不再来），已定格/打字中保留自然收尾
    twState = typewriterStart();
    api.stopTranslation().catch(() => {});
  },
```

初始 state 增：`scope: "off", viewport: null, lastWindow: null,`。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 仅剩 `useDocStore` 缺 `mergeTranslations`（Task 10 修）；无其他错误

- [ ] **Step 3: Commit**

```bash
git add src/stores/useTranslationStore.ts
git commit -m "feat(store): 视口按需调度状态机（scope/会话门/RunDone 扩展）+ reveal 驱动 + merge done"
```

---

### Task 10: `useDocStore` — mergeTranslations + 模式切换清理 + 内容过期钩子

**Files:**
- Modify: `src/stores/useDocStore.ts`

**Interfaces:**
- Consumes: Task 9 的 `resetDisplay` / `resetDisplayIfStale`。
- Produces: `mergeTranslations(pairs: Array<[number, string]>): void`（Task 9 已调用）。

- [ ] **Step 1: 三处改动**

`DocState` 接口 `applyTranslationResult` 声明后追加：

```ts
  /** 窗口化 run 的增量合并：pairs 并入当前累积表（不整表 replace）。 */
  mergeTranslations(pairs: Array<[number, string]>): void;
```

实现（`applyTranslationResult` 之后）：

```ts
    mergeTranslations: (pairs) => {
      if (pairs.length === 0) return;
      patchActive((t) => {
        const merged = new Map(t.translations);
        for (const [i, v] of pairs) merged.set(i, v);
        return { ...t, translations: merged };
      });
    },
```

`switchMode`：切到非原文模式先清旧形态显示（索引空间随模式变），切原文彻底清：

```ts
    switchMode: (m) => {
      const t = activeTab(get());
      if (!t || t.mode === m) return;
      useTranslationStore.getState().resetDisplay(); // 旧模式显示/流全部作废（索引空间变）
      patchActive((cur) => ({
        ...cur,
        mode: m,
        translations: m === "original" ? new Map() : cur.translations,
      }));
      if (m !== "original") useTranslationStore.getState().startIfFresh();
    },
```

`applyEdit`：写入前调用过期清理（内容变了 → 上轮 run 的显示全部作废）：

```ts
    applyEdit: (content, cursorSel) => {
      useTranslationStore.getState().resetDisplayIfStale(content);
      // ……现有 applyEdit 逻辑保持……
```

（`applyEdit` 现体在 `useDocStore.ts` 中——找到现有实现，把首行插进去，其余不动。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无错误（Task 6/9 的欠账全部闭合）

- [ ] **Step 3: Commit**

```bash
git add src/stores/useDocStore.ts
git commit -m "feat(store): mergeTranslations 增量合并 + 模式/内容变更时清理翻译显示态"
```

---

### Task 11: `PreviewView` — 滚动观察 · reveal patcher · 打字行高锁定

**Files:**
- Modify: `src/components/PreviewView.tsx`
- Modify: `src/lib/patchPartial.ts`（增 tr-box 预创建辅助）

**Interfaces:**
- Consumes: Task 9 的 `setViewport` / `registerPatcher` / committed 语义。
- Produces: 滚动 → `store.setViewport(top, bottom)`（data-bi 块索引空间）。

- [ ] **Step 1: patchPartial.ts 增打字起点辅助（bilingual 行高锁定用）**

```ts
/**
 * 打字起点：bilingual 模式预创建空 tr-box 并锁定 min-height=源块当前高度，
 * 打字期间下方内容不被逐帧推挤（行阶跃量化位移）；translation 模式的 run
 * 是行内元素，无块级锁定意义，交由行数变化的自然阶跃。
 * 返回锁定目标（供 done 时解锁），无需锁定返回 null。
 */
export function lockTypingHost(el: HTMLElement, mode: Mode, index: number): HTMLElement | null {
  if (mode !== "bilingual") return null;
  const host = el.querySelector(`[data-bi="${index}"]`);
  if (!host) return null;
  let box = host.nextElementSibling;
  if (!box || !box.classList.contains("tr-box")) {
    box = document.createElement("div");
    box.className = "tr-box";
    host.after(box);
  }
  const h = host.getBoundingClientRect().height;
  if (h > 0) box.style.minHeight = `${h}px`;
  return box as HTMLElement;
}

/** 打字定格后解锁高度（min-height 移除，恢复自然高度）。 */
export function unlockTypingHost(target: HTMLElement | null) {
  if (target) target.style.minHeight = "";
}
```

- [ ] **Step 2: PreviewView 接线（在现有 `patchedRef` effect 附近增/改）**

a) 订阅 committed（替换原 `partialBlocks/partialCursor/partialGen` 订阅名保持不变——语义已变为 committed）。

b) innerHTML 重建 effect 之后追加「水位复位」effect：

```ts
  // innerHTML 重建（doneHtml/parse 切换）会抹掉所有 patch——水位复位，
  // 让下方 committed patch effect 从头重放（幂等，committed 都是完整译文）。
  useEffect(() => {
    patchedRef.current.upto = 0;
  }, [html]);
```

c) committed patch effect 改（deps 增 html；内容过期护栏）：

```ts
  useEffect(() => {
    const el = ref.current;
    if (!el || partialGen === 0) return;
    if (patchedRef.current.gen !== partialGen) {
      patchedRef.current = { gen: partialGen, upto: 0 };
    }
    // 内容过期护栏：批次期间文档被编辑/切换 → 索引错位，宁缺勿错
    if (useDocStore.getState().doc?.content !== useTranslationStore.getState().runContent) return;
    for (let i = patchedRef.current.upto; i < partialCursor; i++) {
      const text = partialBlocks.get(i);
      if (text !== undefined) patchPartial(el, mode, i, text);
    }
    patchedRef.current.upto = Math.max(patchedRef.current.upto, partialCursor);
  }, [partialGen, partialCursor, partialBlocks, mode, html]);
```

d) reveal patcher 注册 + 滚动观察（组件体内）：

```ts
  // ── reveal DOM patcher：start 锁高 / tick 切片 / done 定格解锁 / instant 直写 ──
  const typingHostRef = useRef<Map<number, HTMLElement | null>>(new Map());
  useEffect(() => {
    useTranslationStore.getState().registerPatcher((c) => {
      const el = ref.current;
      if (!el) return;
      switch (c.kind) {
        case "start": {
          typingHostRef.current.set(c.index, lockTypingHost(el, mode, c.index));
          break;
        }
        case "tick":
          patchPartial(el, mode, c.index, c.text);
          break;
        case "done":
          patchPartial(el, mode, c.index, c.text);
          unlockTypingHost(typingHostRef.current.get(c.index) ?? null);
          typingHostRef.current.delete(c.index);
          anchorsDirtyRef.current = true; // 行高变化 → 锚点表标脏
          break;
        case "instant":
          patchPartial(el, mode, c.index, c.text);
          anchorsDirtyRef.current = true;
          break;
      }
    });
    return () => useTranslationStore.getState().registerPatcher(null);
  }, [mode]);

  // ── 滚动观察：rAF 节流 + data-bi 锚点 offsetTop 缓存 + 二分 → setViewport ──
  const anchorsRef = useRef<Array<{ idx: number; top: number }> | null>(null);
  const anchorsDirtyRef = useRef(true);
  const scrollRafRef = useRef(0);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const topIndexAt = (y: number): number => {
      const anchors = anchorsRef.current;
      if (!anchors || anchors.length === 0) return 0;
      let lo = 0;
      let hi = anchors.length - 1;
      let ans = anchors[0].idx;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].top <= y) {
          ans = anchors[mid].idx;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    };
    const report = () => {
      const el = ref.current;
      if (!el) return;
      if (anchorsDirtyRef.current || !anchorsRef.current) {
        const list: Array<{ idx: number; top: number }> = [];
        el.querySelectorAll<HTMLElement>("[data-bi]").forEach((n) => {
          const bi = Number(n.dataset.bi);
          if (Number.isFinite(bi)) list.push({ idx: bi, top: n.offsetTop });
        });
        list.sort((a, b) => a.top - b.top);
        anchorsRef.current = list;
        anchorsDirtyRef.current = false;
      }
      const anchors = anchorsRef.current;
      if (!anchors || anchors.length === 0) return;
      const y = scroller.scrollTop;
      const top = topIndexAt(y);
      const bottom = topIndexAt(y + scroller.clientHeight - 1);
      useTranslationStore.getState().setViewport(top, bottom);
    };
    const onScroll = () => {
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        report();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    report(); // 挂载即上报一次（首次窗口用真实视口而非回退值）
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);
```

注意：`anchorsDirtyRef` 在 c/d 两个 effect 间共享（声明顺序：d 的 refs 声明提前到组件体顶部区域）；`offsetTop` 相对的是 offsetParent（markdown-body 无定位祖先时为 preview-wrap/preview-scroll——scrollTop 同系即正确；markdown-body 若有 relative 定位，改用 `getBoundingClientRect` 差值计算：`(n.getBoundingClientRect().top - scroller.getBoundingClientRect().top) + scroller.scrollTop`——**实现时先验证 offsetTop 语义，不对就用 rect 差值版**）。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/components/PreviewView.tsx src/lib/patchPartial.ts
git commit -m "feat(preview): 滚动观察上报视口 + reveal DOM patcher + bilingual 打字行高锁定"
```

---

### Task 12: 菜单/进度条 + 把手微调（CSS）

**Files:**
- Modify: `src/components/menus/TranslateMenu.tsx`
- Modify: `src/components/TranslationBar.tsx`
- Modify: `src/styles/global.css:1073-1126`

- [ ] **Step 1: TranslateMenu 增「翻译全文」**

```tsx
import { useDocStore } from "../../stores/useDocStore";
import { useTranslationStore } from "../../stores/useTranslationStore";
import Menu, { MenuItem, MenuSep } from "./Menu";

const MODES: Array<{ m: "original" | "translation" | "bilingual"; label: string }> = [
  { m: "original", label: "原文" },
  { m: "translation", label: "译文" },
  { m: "bilingual", label: "中英对照" },
];

export default function TranslateMenu() {
  const mode = useDocStore((s) => s.mode);
  const hasDoc = useDocStore((s) => !!s.doc);
  const switchMode = useDocStore((s) => s.switchMode);
  const running = useTranslationStore((s) => s.status === "running");
  const retranslate = useTranslationStore((s) => s.translateDocument);
  const translateFull = useTranslationStore((s) => s.translateFull);

  return (
    <Menu label="翻译">
      {(close) => (
        <>
          {MODES.map(({ m, label }) => (
            <MenuItem
              key={m}
              label={label}
              active={mode === m}
              disabled={!hasDoc}
              onSelect={() => {
                close();
                switchMode(m);
              }}
            />
          ))}
          <MenuSep />
          {/* 视口按需重跑（当前模式强制重跑当前窗口起） */}
          <MenuItem
            label={running ? "翻译中…" : "重新翻译"}
            disabled={!hasDoc || mode === "original" || running}
            onSelect={() => {
              close();
              void retranslate();
            }}
          />
          {/* 整篇翻译：无视口按需，一次跑完全文（qingniao 全文入口语义） */}
          <MenuItem
            label="翻译全文"
            disabled={!hasDoc || mode === "original" || running}
            onSelect={() => {
              close();
              translateFull();
            }}
          />
        </>
      )}
    </Menu>
  );
}
```

- [ ] **Step 2: TranslationBar scope 标签**

`MODE_LABEL` 行后加：

```ts
const SCOPE_LABEL: Record<string, string> = { viewport: "视口翻译", full: "全文翻译" };
```

组件体加订阅与使用：

```tsx
  const scope = useTranslationStore((s) => s.scope);
```

`tb-label` 行：

```tsx
      <span className="tb-label">
        {SCOPE_LABEL[scope] ?? "翻译"} · {MODE_LABEL[mode] ?? ""} · {provider}
      </span>
```

- [ ] **Step 3: global.css 把手微调（替换 1073-1126 整段）**

```css
/* 正文宽度拖宽把手（DSH 式）：preview-wrap 定位基准，热区贴正文栏左右边缘。
   • 热区 20px 全高全透明（原 8px 用户反馈太窄），cursor col-resize；
     药丸 ::after 4x140 梭形（border-radius 50% 椭圆 = 中间粗两头尖）跟随指针 Y
     （--pill-y 由 onPointerMove 直写，钳在热区内），hover 淡入；灰色系，
     拖拽中深一档灰（用户反馈：不要蓝色）。
   • .dragging 由 lib/colDrag 开关——capture 下 :hover 随指针漂移失效，不能只靠它。
   • 位置与正文栏吃同一个 --qb-content-w：左缘 50%-w/2、右缘 50%+w/2，
     热区自身 20px 宽（-10px 回拉半宽），与栏边缘对齐。 */
.preview-wrap {
  position: relative;
  height: 100%;
}

.content-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 20px;
  cursor: col-resize;
  z-index: 5;
  touch-action: none;
}

.content-resizer.left {
  left: calc((100% - var(--sb-w, 0px)) / 2 - var(--qb-content-w, 794px) / 2 - 10px);
}

.content-resizer.right {
  left: calc((100% - var(--sb-w, 0px)) / 2 + var(--qb-content-w, 794px) / 2 - 10px);
}

.content-resizer::after {
  content: "";
  position: absolute;
  top: var(--pill-y, 50%);
  left: 50%;
  width: 4px;
  height: 140px;
  border-radius: 50%; /* 椭圆：中间最粗、两头渐收成尖 */
  background: var(--bg3);
  box-shadow: 0 0 0 1px var(--border);
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  pointer-events: none;
}

.content-resizer:hover::after,
.content-resizer.dragging::after {
  opacity: 1;
}

.content-resizer.dragging::after {
  background: var(--border-strong); /* 拖拽中深灰，不再用 accent 蓝 */
  box-shadow: none;
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/components/menus/TranslateMenu.tsx src/components/TranslationBar.tsx src/styles/global.css
git commit -m "feat(ui): 翻译全文入口 + scope 标签 + 把手热区放宽/药丸灰色梭形微调"
```

---

### Task 13: 全量验证 + 收尾

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Rust 全量测试**

Run: `cargo test --lib -q`
Expected: 全绿（0 failed）

- [ ] **Step 2: TS 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 3: CHANGELOG 追加条目（顶部新版本段或 Unreleased 段，按现有格式）**

```markdown
### Added
- 视口按需翻译：切到译文/双语默认只译"可见区+预取"，滚到哪译到哪；菜单新增「翻译全文」
- 逐字打字机：译文按文档序 200 字/秒逐字显现；缓存命中瞬时上屏；快速滚动自动 flush
- 参考文献区段自动跳过：References/参考文献 等标题区段不送译
- 拖宽把手：热区放宽至 20px，药丸改灰色梭形
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): 翻译对齐 qingniao（视口按需/打字机/文献跳过/把手微调）"
```

- [ ] **Step 5: 交给用户的本地验证（沙箱 vitest 不可跑）**

```bash
pnpm test          # vitest 全量（reveal/typewriter/store 用例）
pnpm tauri dev     # 手动验收：
#  1. 切译文 → 当前屏自锚点向下逐字显现；停住 → 窗口译完即止（token 只花窗口内）
#  2. 缓慢下滚 → 波浪跟随无闪烁；快速跳文末 → flush 无追字幕
#  3. 滚到底无残留未译；取消 → 滚动不再触发；再切模式恢复
#  4. 「翻译全文」整篇回归；含 References 长文 → 文献区零请求
#  5. 翻译→原文→再翻译 → 缓存全命中整屏瞬时替换无动画
#  6. 把手热区易命中；药丸灰色梭形 ~140px
```

---

## Self-Review 记录

1. **Spec coverage**：spec §2.1→Task1、§2.2→Task2、§2.3→Task3、§2.4→Task4、§2.5→Task5、§3→Task9/10、§4→Task11、§5→Task7/8/11、§6→Task12、§7→Task9/10 护栏、§8→Task13。无缺口。
2. **Placeholder scan**：无 TBD/TODO；Task 4 Step 3 与 Task 11 Step 2d 各有一处「以实际代码为准」的适配说明（MockClient 方法名 / offsetTop 语义），已给足上下文与备选方案，不属于占位符。
3. **Type consistency**：`RevealCommit` 四 kind 在 Task 8 定义、Task 9 dispatch、Task 11 patcher 三处一致；`typewriterPush` 第 4 参 `fromCache`、`TranslateStart.first_index`（snake）、`from_cache`（snake）wire 名前后一致；`window: Option<[usize;2]>` ↔ TS `[number, number] | null` 一致。
