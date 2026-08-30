# 预览渲染档：Mermaid + KaTeX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 qingbird 预览渲染从「标准 CommonMark + 代码高亮」补到 mark2 / SuperMarkdown 那一档：预览视图渲染 ```mermaid 围栏为 SVG、$...$ / $$...$$ / ```math 渲染为 KaTeX；工具栏加 mermaid + 公式两个插入按钮。

**Architecture:** Rust 后端识别 ```mermaid / $...$ / $$...$$ / ```math 并 emit 占位符 DOM（`<div class="mermaid">` / `<span class="math inline">` / `<div class="math block">`，`data-source` 走 escape_html）；前端 `src/lib/previewExtensions.ts` 新模块用 mermaid/katex 库替换占位符内容，`PreviewView` 注入管线追加两行调用 + 主题切换订阅。markdown 文本始终是标准 markdown，不绑内部格式。

**Tech Stack:** Rust（pulldown-cmark 0.13 + syntect，新增 `katex` / `mermaid` npm 依赖）+ React 18 + CodeMirror 6。

**Spec:** `docs/superpowers/specs/2026-08-30-preview-rendering-mermaid-katex-design.md`

## Global Constraints

- **XSS 不破口**：后端 `escape_html` 包 `data-source` 属性值；前端 mermaid 走 `securityLevel: 'strict'`（不执行源码脚本）；KaTeX 走 `katex.render`（纯排版不 eval）。
- **零 IPC 改动**：占位符走现有 `parseResult.html` 通道（前后端职责边界保持）。
- **零翻译流水线改动**：mermaid / math 块不进 `sub_counter`（`Block::Code` 与 `Block::Math` 不在 `collect_runs_inline` 计数路径里）。
- **pnpm 包管理**：本仓用 `pnpm`，新依赖走 `pnpm add katex mermaid`。
- **XSS 边界回归**：后端新加 `mermaid_data_source_escapes_html` 测试必须存在并通过。
- **验证命令**：Rust 侧 `cd src-tauri && cargo test --workspace`；前端 `pnpm build`（tsc 严格编译 + vite）。两条全绿才算完成。
- **提交风格**：`feat(render): …` / `feat(ui): …` / `docs: …` 中文描述，匹配仓库历史。
- **字体分发**：KaTeX woff2 字体走 vite 静态资源（npm 自带，~200KB），不 base64 嵌、不走 CDN。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/markdown/model.rs` | 修改 | `Inline::Math(String)` + `Block::Math { display, tex }` 枚举变体；处理 `Event::InlineMath` / `Event::DisplayMath` |
| `src-tauri/src/markdown/units.rs` | 修改 | `inline_plain_text` / `collect_runs_inline` / `walk_collect` 跳过 math（math 不进翻译 run 空间） |
| `src-tauri/src/markdown/html.rs` | 修改 | mermaid / math lang 分支 + `Inline::Math` / `Block::Math` emit 占位符 + 5 个单测 |
| `package.json` | 修改 | 新增 `katex` + `mermaid` 依赖 |
| `src/lib/previewExtensions.ts` | 新建 | `renderMathPlaceholders` / `renderMermaidPlaceholders` / `clearMermaidCache` |
| `src/components/PreviewView.tsx` | 修改 | 注入管线加两行调用 + 主题订阅 |
| `src/components/EditorToolbar.tsx` | 修改 | mermaid + 公式两个插入按钮 |
| `src/styles/markdown.css` | 修改 | `.mermaid` / `.math.inline` / `.math.block` / `.mermaid-error` 样式 |
| `docs/regression-checklist.md` | 修改 | 追加 10 条手工回归条目 |

---

### Task 1: 后端 model.rs — 加 Math 枚举变体 + 识别 InlineMath/DisplayMath

**Files:**
- Modify: `src-tauri/src/markdown/model.rs`

**Interfaces:**
- Consumes: pulldown-cmark `Event::InlineMath` / `Event::DisplayMath`（0.13 已 emit，参见 model.rs 第 62-63 行被丢弃的 catch-all）
- Produces: `Inline::Math(String)` 与 `Block::Math { display: bool, tex: String }` 公开变体；现有 pattern match 需补全分支

- [ ] **Step 1: 加 `Inline::Math(String)` 与 `Block::Math { display: bool, tex: String }` 枚举**

在 `src-tauri/src/markdown/model.rs` 第 11-20 行的 `Inline` enum 末尾追加：

```rust
    Math(String),
```

把第 31-40 行的 `Block` enum 末尾的 `Table { … }` 之后追加：

```rust
    Math { display: bool, tex: String },
```

- [ ] **Step 2: 把 `Event::InlineMath` 与 `Event::DisplayMath` 从 catch-all 里拆出来处理**

修改 `src-tauri/src/markdown/model.rs` 第 52-72 行 `parse_blocks` 的顶层 match：把第 62-63 行的 `Event::InlineMath(_) | Event::DisplayMath(_)` 从 catch-all 移除，对 `Event::DisplayMath(tex)` 单独分支：

```rust
        Event::DisplayMath(tex) => blocks.push(Block::Math {
            display: true,
            tex: tex.into_string(),
        }),
```

`Event::InlineMath` 不在顶层出现（它在 paragraph 内），所以这里只处理 DisplayMath。

- [ ] **Step 3: 在 `push_inline` 里加 `Event::InlineMath` 处理**

修改 `src-tauri/src/markdown/model.rs` 第 153-191 行 `push_inline`，在 `Event::Code(c)` 之后插入：

```rust
        Event::InlineMath(tex) => {
            out.push(Inline::Math(tex.into_string()));
            true
        }
```

- [ ] **Step 4: 补 `units.rs` 对 `Inline::Math` 与 `Block::Math` 的跳过分支**

修改 `src-tauri/src/markdown/units.rs`：

1. `inline_plain_text`（第 5-18 行）的 match 末尾追加：
```rust
            Inline::Math(_) => {} // LaTeX 不进翻译 plain text
```

2. `collect_runs_inline`（第 58-73 行）的 match 末尾追加：
```rust
            Inline::Math(_) => {}
```

3. `walk_collect`（第 86-127 行）的 match 末尾 `_ => {}` 之前追加：
```rust
            Block::Math { .. } => {}
```

4. `walk_run_collect`（第 31-56 行）的 match 末尾 `_ => {}` 之前追加：
```rust
            Block::Math { .. } => {}
```

- [ ] **Step 5: 编译验证**

```bash
cd src-tauri && cargo build
```

预期：编译通过，零警告（已存在 warnings 不能新增）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/markdown/model.rs src-tauri/src/markdown/units.rs
git commit -m "feat(render): 识别 InlineMath/DisplayMath 事件 — Math 模型变体"
```

---

### Task 2: 后端 html.rs — emit 占位符 DOM

**Files:**
- Modify: `src-tauri/src/markdown/html.rs`

**Interfaces:**
- Consumes: `model::Block::Code { lang: Some("mermaid"), .. }` / `lang: Some("math"), .. }` / `model::Block::Math { display, tex }` / `model::Inline::Math(String)`
- Produces: HTML 字符串含 `<div class="mermaid" data-source="…"></div>` / `<div class="math block" data-source="…"></div>` / `<span class="math inline" data-source="…"></span>` 占位符

- [ ] **Step 1: 修改 `Block::Code` 分支，看 lang 分发**

修改 `src-tauri/src/markdown/html.rs` 第 119 行 `Block::Code { lang, code } => self.push_code_block(out, lang.as_deref(), code)` 替换为：

```rust
            Block::Code { lang, code } => match lang.as_deref() {
                Some("mermaid") => {
                    out.push_str(r#"<div class="mermaid" data-source=""#);
                    out.push_str(&escape_html(code));
                    out.push_str(r#""></div>"#);
                }
                Some("math") => {
                    out.push_str(r#"<div class="math block" data-source=""#);
                    out.push_str(&escape_html(code));
                    out.push_str(r#""></div>"#);
                }
                _ => self.push_code_block(out, lang.as_deref(), code),
            },
```

- [ ] **Step 2: 在 `render_block` 加 `Block::Math` 分支**

修改 `src-tauri/src/markdown/html.rs` 第 93-176 行 `render_block` 的 match，在 `Block::Rule` 之后插入：

```rust
            Block::Math { display, tex } => {
                let cls = if *display { "math block" } else { "math inline" };
                let _ = write!(
                    out,
                    r#"<div class="{}" data-source="{}"></div>"#,
                    cls,
                    escape_html(tex)
                );
            }
```

注意：`Block::Math { display: false, tex }` 实际几乎不出现（DisplayMath 总是 `display: true`），但保留语义完整性——`Inline::Math` 才是真正的行内。

- [ ] **Step 3: 在 `push_inlines` 加 `Inline::Math` 分支**

修改 `src-tauri/src/markdown/html.rs` 第 197-239 行 `push_inlines`，在 `Inline::Code(c)` 分支之后插入：

```rust
                Inline::Math(tex) => {
                    let _ = write!(
                        out,
                        r#"<span class="math inline" data-source="{}"></span>"#,
                        escape_html(tex)
                    );
                }
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo build
```

预期：通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/markdown/html.rs
git commit -m "feat(render): mermaid/math 占位符 emit — 后端输出 placeholder DOM"
```

---

### Task 3: 后端 html.rs — 5 个单元测试

**Files:**
- Modify: `src-tauri/src/markdown/html.rs`（`mod tests` 末尾追加）

- [ ] **Step 1: 加 5 个单测**

在 `src-tauri/src/markdown/html.rs` 第 425 行 `}` 结尾的最后一个测试之后、`}` 闭合 mod tests 之前追加：

```rust
    #[test]
    fn code_block_mermaid_emits_placeholder() {
        let r = render_html("```mermaid\ngraph TD\nA-->B\n```", &HashMap::new(), false);
        assert!(
            r.html.contains(r#"<div class="mermaid" data-source="graph TD
A--&gt;B"></div>"#),
            "mermaid block must emit data-source placeholder: {}",
            r.html
        );
    }

    #[test]
    fn inline_dollar_math_emits_placeholder() {
        let r = render_html("Hello $x^2$ world", &HashMap::new(), false);
        assert!(
            r.html.contains(r#"<span class="math inline" data-source="x^2"></span>"#),
            "inline math must emit inline placeholder: {}",
            r.html
        );
    }

    #[test]
    fn block_math_fenced_or_dollar_pair() {
        let r1 = render_html("```math\n\\sum_i\n```", &HashMap::new(), false);
        assert!(
            r1.html.contains(r#"<div class="math block" data-source="\sum_i"></div>"#),
            "math fenced must emit block placeholder: {}",
            r1.html
        );
        let r2 = render_html("$$\n\\sum_i\n$$", &HashMap::new(), false);
        assert!(
            r2.html.contains(r#"<div class="math block" data-source="\sum_i"></div>"#),
            "math dollar-pair must emit block placeholder: {}",
            r2.html
        );
    }

    #[test]
    fn mermaid_data_source_escapes_html() {
        let r = render_html(
            "```mermaid\n<script>alert(1)</script>\n```",
            &HashMap::new(),
            false,
        );
        // XSS：<script> 必须转义为 &lt;script&gt;
        assert!(
            r.html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "mermaid source must escape HTML: {}",
            r.html
        );
        // 整段 HTML 不能含裸 <script>
        assert!(!r.html.contains("<script>"), "raw <script> must not appear");
    }

    #[test]
    fn mermaid_block_does_not_consume_sub_counter() {
        // 双语模式下 mermaid 块不消耗 sub_counter，Hello 段仍翻译
        let mut m = HashMap::new();
        m.insert(0usize, "你好".into());
        let r = render_html("```mermaid\ngraph TD\nA-->B\n```\n\nHello", &m, false);
        assert!(
            r.html.contains("你好"),
            "substituted translation must apply to Hello: {}",
            r.html
        );
    }
```

> 注意：上面 `\sum_i` 在 Rust 字符串字面量里要写为 `\\sum_i`（一个反斜杠转义为两个）。第一与第三个测试就是这种写法。

- [ ] **Step 2: 运行 cargo test 验证**

```bash
cd src-tauri && cargo test --workspace
```

预期：5 个新测试全过 + 旧测试不回归。如某条失败，按错误信息修整断言字符串里的转义。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/markdown/html.rs
git commit -m "test(render): mermaid/math 占位符与 XSS 边界测试"
```

---

### Task 4: 前端依赖 + `src/lib/previewExtensions.ts`

**Files:**
- Modify: `package.json`
- Create: `src/lib/previewExtensions.ts`

- [ ] **Step 1: 安装依赖**

```bash
cd F:\AIwork\qingbird-md-rust
pnpm add katex@^0.16.11 mermaid@^11.4.1
```

预期：`package.json` 的 `dependencies` 多了两项，`pnpm-lock.yaml` 同步更新。

- [ ] **Step 2: 创建 `src/lib/previewExtensions.ts`**

新建 `src/lib/previewExtensions.ts`：

```ts
// 前端预览扩展：mermaid 图表渲染 + KaTeX 数学公式渲染。
//
// 数据契约：后端 html.rs 在 render_html 时已识别 ```mermaid / $...$ / $$...$$
// / ```math 并 emit 占位符 DOM（见 spec 2026-08-30 §5.1）；本模块只替换占位符
// 内容，XSS 边界由后端 escape_html + 本模块不向 innerHTML 拼任何文档派生字符串
// 共同维护。

import katex from "katex";
import { isDarkTheme } from "../stores/useSettingsStore";

// ── mermaid 懒加载单例（dynamic import，不入首屏） ────────────────────────────

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
async function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import("mermaid").then((m) => {
    const mermaid = m.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // 关键：不执行 mermaid 源码里的脚本
      theme: isDarkTheme() ? "dark" : "default",
    });
    return mermaid;
  });
  return mermaidPromise;
}

// 主题重配（外部调用：PreviewView 在 isDarkTheme 变化时触发）
export function reconfigureMermaidTheme() {
  // 重新初始化并清缓存（renderMermaidPlaceholders 会再次触发 initialize 也行，
  // 这里显式重配以避免「先 await loadMermaid 再 initialize」的时序坑）
  mermaidPromise = import("mermaid").then((m) => {
    const mermaid = m.default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDarkTheme() ? "dark" : "default",
    });
    return mermaid;
  });
}

// ── SVG 缓存：source hash → svg string（同 source 重复 render 短路） ──────────

const svgCache = new Map<string, string>();

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export function clearMermaidCache() {
  svgCache.clear();
}

// ── KaTeX 渲染（同步、幂等） ──────────────────────────────────────────────────

export function renderMathPlaceholders(scope: HTMLElement) {
  const els = scope.querySelectorAll<HTMLElement>(".math[data-source]");
  for (const el of Array.from(els)) {
    const src = el.getAttribute("data-source") ?? "";
    if (el.dataset.rendered === src) continue; // 幂等：同 source 不重渲
    const display = el.classList.contains("block");
    try {
      katex.render(src, el, {
        displayMode: display,
        throwOnError: false, // 走 KaTeX 自带红色错误，不抛
      });
      el.dataset.rendered = src;
    } catch {
      // throwOnError: false 已兜底绝大多数 LaTeX 错误；此 catch 是极小概率的
      // 库内部异常，置空占位符回退显示源码
      el.textContent = src;
    }
  }
}

// ── mermaid 渲染（异步、幂等、带缓存与错误降级） ──────────────────────────────

export async function renderMermaidPlaceholders(scope: HTMLElement) {
  const mermaid = await loadMermaid();
  const els = scope.querySelectorAll<HTMLElement>(".mermaid[data-source]");
  await Promise.all(
    Array.from(els).map(async (el) => {
      const src = el.getAttribute("data-source") ?? "";
      if (el.dataset.rendered === src) return; // 幂等
      const key = hashStr(src);
      const cached = svgCache.get(key);
      if (cached) {
        el.innerHTML = cached;
        el.dataset.rendered = src;
        return;
      }
      try {
        const { svg } = await mermaid.render(`m-${key}`, src);
        svgCache.set(key, svg);
        el.innerHTML = svg;
        el.dataset.rendered = src;
      } catch (e) {
        // 错误降级：占位符内显示错误信息，不抛全局
        const err = document.createElement("pre");
        err.className = "mermaid-error";
        err.textContent = `[mermaid 解析失败]\n${String(e)}`;
        el.replaceChildren(err);
        el.dataset.rendered = src;
      }
    })
  );
}
```

- [ ] **Step 3: tsc 严格编译验证**

```bash
cd F:\AIwork\qingbird-md-rust
pnpm build
```

预期：通过（tsc 严格 + vite 打包都过）。如果 katex 没有内置 `import "katex/dist/katex.min.css"` 的副作用导入，CSS 不会自动打包——CSS import 步骤见 Task 5。

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/previewExtensions.ts
git commit -m "feat(ui): previewExtensions — mermaid/KaTeX 渲染模块"
```

---

### Task 5: 前端 PreviewView 接线 + 主题订阅 + KaTeX CSS

**Files:**
- Modify: `src/components/PreviewView.tsx`
- Modify: `src/main.tsx`（加一行 `import "katex/dist/katex.min.css"`）
- Modify: `src/styles/markdown.css`（占位符样式）

- [ ] **Step 1: 在 main.tsx 加 KaTeX CSS import**

打开 `src/main.tsx`，在现有 import 末尾加一行：

```ts
import "katex/dist/katex.min.css";
```

> KaTeX CSS 必须在首次 `katex.render` 调用前导入；放 main.tsx 是最简单的全局保障。

- [ ] **Step 2: 修改 PreviewView 注入管线**

打开 `src/components/PreviewView.tsx`，第 14-22 行 import 块末尾追加：

```ts
import { renderMathPlaceholders, renderMermaidPlaceholders, clearMermaidCache, reconfigureMermaidTheme } from "../lib/previewExtensions";
```

定位到第 130-137 行的 `useEffect`，在 `addHeadingToggles(el);` 之后追加：

```ts
    renderMathPlaceholders(el);
    void renderMermaidPlaceholders(el);
```

- [ ] **Step 3: 新增主题订阅 useEffect**

在 PreviewView.tsx 末尾、`return (...)` 之前，定位到第 158 行 `if (content === null) return …` 之前的位置，**新增**一个 `useEffect`（与 EditorView.tsx 的 theme compartment 同款双订阅模式）：

```tsx
  // mermaid 主题切换：清缓存 + 重渲当前 scope 的 mermaid 占位符。
  // KaTeX 主题跟随 CSS 变量（markdown.css `[data-theme="dark"]` 选择器），
  // 不需重渲。订阅方式与 EditorView.tsx 同款（settings + matchMedia）。
  useEffect(() => {
    let lastDark = isDarkTheme();
    const apply = () => {
      const dark = isDarkTheme();
      if (dark === lastDark) return;
      lastDark = dark;
      reconfigureMermaidTheme();
      clearMermaidCache();
      const el = ref.current;
      if (el) {
        // 抹掉 dataset.rendered 强制重渲
        el.querySelectorAll<HTMLElement>(".mermaid[data-source]").forEach((node) => {
          delete node.dataset.rendered;
          node.replaceChildren(); // 清空旧 SVG
        });
        void renderMermaidPlaceholders(el);
      }
    };
    const unsub = useSettingsStore.subscribe(apply);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => {
      unsub();
      mq.removeEventListener("change", apply);
    };
  }, []);
```

- [ ] **Step 4: 添加 markdown.css 占位符样式**

打开 `src/styles/markdown.css`，在文件末尾追加：

```css
/* mermaid / KaTeX 占位符样式（spec 2026-08-30 §7.5） */
.markdown-body .mermaid {
  text-align: center;
  margin: 1em 0;
}
.markdown-body .mermaid-error {
  background: #fef2f2;
  color: #b91c1c;
  padding: 0.5em;
  border-radius: 4px;
  font-size: 0.9em;
  white-space: pre-wrap;
  text-align: left;
}
[data-theme="dark"] .markdown-body .mermaid-error {
  background: #450a0a;
  color: #fecaca;
}
.markdown-body .math.inline {
  display: inline-block;
}
.markdown-body .math.block {
  display: block;
  text-align: center;
  margin: 1em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
```

- [ ] **Step 5: tsc + vite 编译验证**

```bash
cd F:\AIwork\qingbird-md-rust
pnpm build
```

预期：通过；产物 `dist/assets/katex-*.woff2` 自动出现（vite 静态资源）。

- [ ] **Step 6: Commit**

```bash
git add src/main.tsx src/components/PreviewView.tsx src/styles/markdown.css
git commit -m "feat(ui): PreviewView 接线 mermaid/KaTeX + 主题切换重渲"
```

---

### Task 6: 前端 EditorToolbar 插入按钮

**Files:**
- Modify: `src/components/EditorToolbar.tsx`

- [ ] **Step 1: 在 lucide-react import 块加 `Sigma` 与 `Workflow`**

打开 `src/components/EditorToolbar.tsx`，第 8-43 行的 lucide-react import 块，**在 SquareCode 之后**追加：

```ts
  Workflow,
  Sigma,
```

- [ ] **Step 2: 在文件顶部（imports 之后、export default 之前）加两个工具函数**

定位到第 50 行 `// ── 分隔线 ──` 之前，插入：

```ts
// ── 插入工具：mermaid 围栏 / $...$ 公式 ──
function insertMermaid() {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return;
  const from = v.state.selection.main.from;
  // 模板：\n```mermaid\n\n```\n（光标落在中间空行开头）
  const template = "\n```mermaid\n\n```\n";
  v.dispatch({
    changes: { from, insert: template },
    selection: { anchor: from + "\n```mermaid\n".length },
  });
  v.focus();
}

function insertFormula() {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return;
  const [from, to] = v.state.selection.main;
  const sel = v.state.sliceDoc(from, to);
  if (sel) {
    // wrap 选区为 $...$；新光标落在 $ 之后（即 sel 末尾 + 1）
    v.dispatch({
      changes: { from, to, insert: `$${sel}$` },
      selection: { anchor: from + sel.length + 1 },
    });
  } else {
    // 无选区：插入 $$$ 光标留中间
    v.dispatch({
      changes: { from, insert: "$$$" },
      selection: { anchor: from + 1 },
    });
  }
  v.focus();
}
```

- [ ] **Step 3: 在工具栏现有 CodeBlock 按钮（第 179-182 行）之后插入两个按钮**

定位到第 182 行 `<SquareCode size={15} />` 按钮之后、`</button>` 闭合之后的下一个 `<button>`（Link 按钮）之前，**插入**：

```tsx
      <button type="button" className="menu-btn tool-btn" title="Mermaid 图表（插入 ```mermaid 围栏）" disabled={disabled}
        onClick={insertMermaid}>
        <Workflow size={15} />
      </button>
      <button type="button" className="menu-btn tool-btn" title="公式（$…$ 包裹选区或插入空占位）" disabled={disabled}
        onClick={insertFormula}>
        <Sigma size={15} />
      </button>
```

- [ ] **Step 4: 编译验证**

```bash
cd F:\AIwork\qingbird-md-rust
pnpm build
```

预期：通过。

- [ ] **Step 5: Commit**

```bash
git add src/components/EditorToolbar.tsx
git commit -m "feat(ui): 工具栏 mermaid + 公式插入按钮"
```

---

### Task 7: 手工回归清单 + docs 更新

**Files:**
- Modify: `docs/regression-checklist.md`

- [ ] **Step 1: 追加 10 条手工回归条目**

打开 `docs/regression-checklist.md`，在文件末尾追加：

```markdown
## 预览渲染：Mermaid + KaTeX（2026-08-30 spec）

- [ ] ```mermaid flowchart 块渲染为 SVG 节点（flowchart 默认带超链接行为）。
- [ ] `$x^2$` 行内渲染为 KaTeX 上下标。
- [ ] `$$\n\sum\n$$` 块状渲染为 display 模式（独占一行）。
- [ ] ` ```math\n\sum\n``` ` 同样渲染为 display（兼容旧写法）。
- [ ] 切 dark 主题，mermaid 重渲（颜色变了），KaTeX 字体颜色跟随主题。
- [ ] 故意写错 mermaid 语法 → 占位符内显示错误信息，页面其他内容正常。
- [ ] 工具栏 mermaid 按钮：插入空围栏并把光标落在中间空行。
- [ ] 工具栏公式按钮：选区 "hello" → `$hello$` 光标落在第二个 `$` 之后；无选区 → `$|$` 光标在中间。
- [ ] XSS：```mermaid 含 `<script>alert(1)</script>` 源码 → 渲染成纯文本不弹窗。
- [ ] 双语模式下 mermaid 块不消耗 sub_counter（Hello 段翻译正常，mermaid 段不变化）。
```

- [ ] **Step 2: 跑全量 cargo test + pnpm build**

```bash
cd src-tauri && cargo test --workspace
cd ../.. && pnpm build
```

预期：cargo test 全绿（含 5 个新单测），pnpm build 通过。

- [ ] **Step 3: dev 跑一遍 10 条手工回归**

```bash
pnpm tauri dev
```

逐条对照上面的清单验。任意一条失败即修，修完再走一遍。

- [ ] **Step 4: Commit**

```bash
git add docs/regression-checklist.md
git commit -m "docs: 预览渲染档 mermaid/KaTeX 回归清单"
```

---

### Task 8: CHANGELOG.md 更新（仓库历史惯例）

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 追加变更条目**

打开 `CHANGELOG.md`，在最新版本块下追加一条（保持现有格式）：

```markdown
- **预览渲染**：新增 Mermaid 图表与 KaTeX 数学公式在预览视图中的渲染支持；工具栏加 mermaid 与公式两个插入按钮。
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 增补 mermaid/KaTeX 渲染条目"
```

---

## Self-Review Checklist（plan 作者自查）

- [x] **Spec 覆盖**：
  - §2.Goals 1（mermaid 渲染）→ Task 2 Step 1 + Task 5 Step 2
  - §2.Goals 2（math 渲染）→ Task 1 + Task 2 Step 3 + Task 5 Step 2
  - §2.Goals 3（主题切换）→ Task 5 Step 3
  - §2.Goals 4（工具栏按钮）→ Task 6
  - §2.Goals 5（错误降级）→ Task 4 Step 2 (`renderMermaidPlaceholders` catch 分支)
  - §2.Goals 6（幂等）→ Task 4 Step 2 (`dataset.rendered` 短路 + svgCache)
  - §2.Goals 7（XSS）→ Task 1-2 escape_html + Task 4 Step 2 (`securityLevel: 'strict'`) + Task 3 Step 1 (escape 测试)
  - §3.Non-goals（导出/缩放/自定义主题等）→ 不在 plan 里，与 spec 一致
- [x] **占位符扫描**：零 "TBD" / "TODO" / "later"。
- [x] **类型一致性**：`previewExtensions.ts` 的 `reconfigureMermaidTheme` / `clearMermaidCache` / `renderMathPlaceholders` / `renderMermaidPlaceholders` 在 Task 4 定义、在 Task 5 引用，签名一致。`isDarkTheme` 在 Task 4 引用，需确认其从 `useSettingsStore` 导出——参考 `EditorView.tsx` 第 27 行 import 路径。
- [x] **命令可执行**：所有 `pnpm build` / `cargo test --workspace` / `git commit` 命令都给出明确预期。
- [x] **TDD 顺序**：后端先写实现（Task 1-2）、再写测试（Task 3）；前端依赖安装 + 模块创建在前（Task 4）、接线在后（Task 5-6）。任务粒度按 spec 节切分，符合"小到独立可审"。
- [x] **提交粒度**：每个 Task 一个 commit，零 commit 含多个 Task 的内容。
