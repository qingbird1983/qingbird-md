# qingbird-md-rust — 预览渲染档：Mermaid + KaTeX — Design

**Date:** 2026-08-30 · **Status:** Draft for review · **Author:** agent

## 1. Summary

把 qingbird 的预览渲染从「标准 CommonMark + 代码高亮」补到 mark2 / SuperMarkdown 那一档：增加 **mermaid 图表** 与 **KaTeX 数学公式** 在预览视图中的渲染能力，同时工具栏加两个插入按钮（mermaid 围栏、$...$ 包裹）。

设计蓝本：mark2 `src/utils/mermaidRenderer.js`（渲染管线与缓存模式）、mark2 `src/extensions/MathBlock.js`（math 块挂载）、SuperMarkdown `src/renderer/editor/katexEmbedded.css`（KaTeX 集成做法）。本设计已确认的三个决策：

- **职责边界** = 后端占位符 + 前端渲染：Rust 只识别 ```mermaid / `$...$` / `$$...$$` 并 emit 占位符 DOM，前端 PreviewView 注入管线调 mermaid/katex 库替换占位符内容。markdown 文本始终是标准 markdown，不绑内部格式。
- **字体分发** = npm 打包 + vite 静态资源（woff2 文件），不走 base64 内嵌、也不走 CDN——Tauri 自带本地资源分发，~200KB 增量可接受，离线即用。
- **插入 UX** = 仅工具栏两个按钮：mermaid 按钮在光标处插入空围栏，公式按钮 wrap 选区或插入空 `$...$` 留光标中间。不引入 slash command / 浮窗气泡菜单。

## 2. Goals

1. 预览视图渲染 ```mermaid 围栏代码块为 SVG 图表（支持 flowchart / sequence / gantt / pie 等常见图）。
2. 预览视图渲染 `$...$` 行内公式与 `$$...$$` 块状公式（KaTeX）。
3. mermaid / KaTeX 渲染跟随应用亮/暗主题自动切换。
4. 工具栏加 mermaid、公式两个插入按钮；mermaid 按钮插入空围栏并把光标落在中间空行，公式按钮有选区时 wrap、无选区时插入空占位符。
5. mermaid 渲染失败降级为占位符内错误信息，不破坏页面、不抛全局。
6. 渲染做幂等：同一份文档重新进入预览（切 tab 切回）不重复调用 mermaid.render；同 source 的 mermaid SVG 走前端 cache 短路。
7. XSS 边界保持：mermaid/math 源码里嵌入的 `<script>` / `</script>` 永远不可能执行（后端 escape + 前端 textContent 写入）。

## 3. Non-goals

- mermaid 导出 SVG/PNG（mark2 有，非核心；放后续 spec）。
- mermaid 编辑器内实时预览（只做预览视图渲染）。
- mermaid 自定义主题色板（首版跟随亮/暗自动；不暴露 UI 切换）。
- 多窗格 / 缩放查看大图（YAGNI）。
- 修改翻译流水线（mermaid 块本身不进双语 sub 流程，详见 §6.2）。
- mermaid `click` 事件交互（mark2 有节点点击；非核心）。
- 改 pulldown-cmark 解析器（仍走 model.rs + html.rs 自有层）。

## 4. 现状与改动面

现有基础（本次复用，不改契约）：

- `html.rs::render_html(content, trans, bilingual)` 输出 `ParseResult { html, outline }`，前端 `PreviewView` 接 `useDocStore.parseResult.html` 并 `innerHTML = html` 整树重建。
- `PreviewView.tsx` 注入管线（按顺序）：`addCopyButtons` → `addHeadingToggles` → `rewriteImages`（异步）。错误显示走 `<pre class="mermaid-error">` 同款形式。
- `EditorView.tsx` CodeMirror 6：`@codemirror/lang-markdown` + `codemirror-lang-math`（行内/块状 math 已有源码高亮）+ `cmRef.current.dispatch` 支持外部命令改文。
- `EditorToolbar.tsx`：B/I/S/H1/H2/H3/UL/OL/Task/Quote/Code/CodeBlock/Link/Image/Table/HR 共 16 个格式按钮 + 文件操作 + 视图切换。CodeBlock 按钮已存在（`SquareCode` 图标），本次在它旁边新增 mermaid / 公式两个按钮。

新增改动面：

- 后端：`model.rs`（inline `Math(String)` 加枚举变体）、`html.rs`（mermaid / math emit 占位符 + XSS 测试）。
- 前端：`package.json`（新增 `katex` + `mermaid`）、`src/lib/previewExtensions.ts`（新文件）、`src/components/PreviewView.tsx`（注入管线加两行）、`src/components/EditorToolbar.tsx`（两个按钮）、`src/styles/markdown.css`（占位符样式）。
- 不动：`docStore`、`useSettingsStore`、`EditorView.tsx` 的 keymap（除 mermaid/math 走工具栏不占键位）、翻译流水线任何文件。

## 5. 数据契约

### 5.1 后端 emit 的占位符 DOM

mermaid 围栏代码块：

```html
<div class="mermaid" data-source="graph TD\nA--&gt;B"></div>
```

inline math：

```html
<span class="math inline" data-source="x^2"></span>
```

block math（围栏 ` ```math ` 或 `$$...$$`）：

```html
<div class="math block" data-source="\sum_i x_i"></div>
```

约定：

- `data-source` 内容走 `escape_html`（已存在），保证 `<` / `>` / `&` 转义。
- mermaid 占位符为空 div，前端 `renderMermaidPlaceholders` 写入 SVG；math 占位符前端 `katex.render` 原地替换。
- 错误降级：mermaid 解析失败时占位符内写入 `<pre class="mermaid-error">{错误信息}</pre>`；KaTeX 走 `throwOnError: false` 自带红色 error。

### 5.2 双语/译文模式

mermaid 块本身不可翻译（视觉块不是文本），但要走 `sub_counter` 占位避免索引漂移——具体处理：

- `needs_translation` 判定（pipeline.rs 已有）对 mermaid 块返回 false，`collect_text_runs` 不会为它分配 index。
- 但 `html.rs` 现有的 `sub_counter` 推进规则是「每个 `Inline::Text` 推进一次」。mermaid 块走 `Block::Code` 分支不增加 sub_counter，自然与 units 收集器一致——零额外处理，零索引漂移风险。

math 块同理：KaTeX 渲染完的输出是排版后的字符（含上下标等），不送翻译——与 mermaid 同处理。

## 6. Rust 侧

### 6.1 model.rs

加 `Inline::Math(String)` 变体。`Block::Code` 不动——mermaid / math 都走 `Block::Code { lang, code }`，由 html.rs 看 lang 分支。

model.rs 的 `collect_inlines` 加识别 `$...$`（行内，不跨行）与 `$$...$$`（块状，可跨行）。识别规则：

- inline `$...$`：单行内，美元符两侧非空白（避免误匹配 `$ 100$`），且不在代码围栏内。
- block `$$...$$`：跨行形式（`$$\n...\n$$`）。
- 代码围栏 `lang == "math"` 也走 block math 路径（兼容旧写法）。

> ponytail：优先复用 `pulldown-cmark` 0.13 自带的 InlineMath / DisplayMath 事件（model.rs 的 `Parser` 迭代时已能取到）；识别失败兜底方案留作 follow-up，本期 spec 不写手写识别——避免一次性扩大 model.rs 改动面。若实测发现 0.13 不 emit 这两类事件，本期 fallback 为「仅支持 ` ```math ` 围栏形式」，行内 `$...$` / 块状 `$$...$$` 暂不识别；spec 失败模式清单（§8）显式记录。

### 6.2 html.rs

`Block::Code` 分支：

```rust
match lang.as_deref() {
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
}
```

`Inline::Math` 分支：

```rust
Inline::Math(tex) => {
    let display = /* 块状 vs 行内 */;
    if display {
        let _ = write!(
            out,
            r#"<div class="math block" data-source="{}"></div>"#,
            escape_html(tex)
        );
    } else {
        let _ = write!(
            out,
            r#"<span class="math inline" data-source="{}"></span>"#,
            escape_html(tex)
        );
    }
}
```

> ponytail：inline 与 block 都 emit `data-source`，前端靠 `.math.inline` / `.math.block` 区分 `katex.render` 的 `displayMode` 参数。

### 6.3 单元测试（`html.rs` 末尾追加）

1. `code_block_mermaid_emits_placeholder`：输入 ```mermaid\ngraph TD\nA-->B\n```，输出含 `<div class="mermaid" data-source="graph TD\nA--&gt;B"></div>`。
2. `inline_dollar_math_emits_placeholder`：输入 `Hello $x^2$ world`，输出含 `<span class="math inline" data-source="x^2"></span>`。
3. `block_math_fenced_or_dollar_pair`：输入 ` ```math\n\sum_i\n``` ` 与 `$$\n\sum_i\n$$` 都输出 `<div class="math block" data-source="\\sum_i"></div>`。
4. `mermaid_data_source_escapes_html`：输入含 `<script>alert(1)</script>` 的 mermaid 块，输出 `data-source` 内 `&lt;script&gt;`，且整段 HTML 不含原始 `<script>` 字符串。
5. `mermaid_block_does_not_consume_sub_counter`：构造双语模式下文档 `\`\`\`mermaid\nA\n\`\`\`\n\nHello`，sub map `{0: "你好"}` 应只让 Hello 段翻译，不影响 mermaid 块。

## 7. 前端

### 7.1 依赖与静态资源

`package.json`：

```json
"dependencies": {
  "katex": "^0.16.11",
  "mermaid": "^11.4.1"
}
```

`main.tsx`（或新建 `src/lib/katex.ts`）：

```ts
import "katex/dist/katex.min.css";
```

字体由 vite 自动打包到 `dist/assets/katex-*.woff2`（KaTeX 自带 `fontPath` 默认相对路径），无需额外配置。

### 7.2 新文件 `src/lib/previewExtensions.ts`

```ts
import katex from "katex";

// mermaid 懒加载单例（dynamic import，不入首屏）
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

// SVG 缓存：source hash → svg string（避免同 source 重复 render）
const svgCache = new Map<string, string>();
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export function renderMathPlaceholders(scope: HTMLElement) {
  const els = scope.querySelectorAll<HTMLElement>(".math[data-source]");
  for (const el of Array.from(els)) {
    const src = el.getAttribute("data-source") ?? "";
    if (el.dataset.rendered === src) continue; // 幂等
    const display = el.classList.contains("block");
    try {
      katex.render(src, el, {
        displayMode: display,
        throwOnError: false, // 走 KaTeX 自带红色错误，不抛
      });
      el.dataset.rendered = src;
    } catch {
      // throwOnError: false 兜底仍兜不住的极小概率：置空占位符
      el.textContent = src;
    }
  }
}

export async function renderMermaidPlaceholders(scope: HTMLElement) {
  const mermaid = await loadMermaid();
  const els = scope.querySelectorAll<HTMLElement>(".mermaid[data-source]");
  await Promise.all(
    Array.from(els).map(async (el) => {
      const src = el.getAttribute("data-source") ?? "";
      if (el.dataset.rendered === src) return;
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

// 主题切换时清缓存 + 重渲（PreviewView 订阅 isDarkTheme）
export function clearMermaidCache() {
  svgCache.clear();
}
```

### 7.3 PreviewView.tsx 接线

在 `useEffect([html, baseDir])` 末尾追加：

```ts
renderMathPlaceholders(el);
void renderMermaidPlaceholders(el);
```

新建一个 `useEffect` 监听主题变化（与 `EditorView.tsx` 同款双订阅：`useSettingsStore.subscribe(applyTheme)` + `matchMedia("(prefers-color-scheme: dark)").addEventListener`），切换时：

1. 重配 mermaid 主题：`mermaid.initialize({ theme: isDarkTheme() ? "dark" : "default" })`；
2. `clearMermaidCache()` 清 SVG 缓存；
3. 重扫当前 scope 的 mermaid 占位符（dataset.rendered 置空 + 调 `renderMermaidPlaceholders`）。

KaTeX 主题跟随 CSS 变量，无需重渲——KaTeX CSS 自带 `[data-theme="dark"]` 选择器（与现有 markdown.css 行号 gutter 同模式）。

> ponytail：监听方案取最简——双订阅与 EditorView 同款实现，避免引入新的全局主题总线。

### 7.4 EditorToolbar.tsx 插入按钮

新增两个按钮（紧邻现有 CodeBlock 按钮右侧）：

- **mermaid**：插入 `\n\`\`\`mermaid\n\n\`\`\`\n` 在光标处，并把光标移到中间空行。
- **公式（ƒ）**：有选区时 `wrap` 为 `$...$`；无选区时插入 `$...$` 光标留中间。

实现：

```ts
function insertAtCursor(view: EditorView, text: string, sel?: [number, number]) {
  // sel 为新选区（行内 wrap 时用）；不传则末尾 + 1（光标居中场景）
}

function insertMermaid() {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return;
  const ins = "\n```mermaid\n\n```\n";
  // CM6 dispatch：insert + selection 落在中间空行开头
  const from = v.state.selection.main.from;
  v.dispatch({
    changes: { from, insert: ins },
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
    // wrap 选区
    v.dispatch({
      changes: { from, to, insert: `$${sel}$` },
      selection: { anchor: from + sel.length + 2 },
    });
  } else {
    const ins = "$$$";
    v.dispatch({
      changes: { from, insert: ins },
      selection: { anchor: from + 1 },
    });
  }
  v.focus();
}
```

图标：用 `Sigma`（公式按钮）+ `Workflow` 或 `GitBranch`（mermaid 按钮），都已在 lucide-react 里。

### 7.5 markdown.css 占位符样式

```css
.markdown-body .mermaid {
  text-align: center;
  margin: 1em 0;
}
.markdown-body .mermaid-error {
  background: var(--err-bg, #fef2f2);
  color: var(--err-fg, #b91c1c);
  padding: 0.5em;
  border-radius: 4px;
  font-size: 0.9em;
  white-space: pre-wrap;
}
.markdown-body .math.inline {
  display: inline-block;
}
.markdown-body .math.block {
  display: block;
  text-align: center;
  margin: 1em 0;
}
```

> ponytail：占位符不预设宽高——让 mermaid 自己量；KaTeX 自带排版。

## 8. 边界行为

1. **mermaid 解析失败**：占位符内显示错误信息（`<pre class="mermaid-error">`），不白屏、不抛全局。
2. **KaTeX 解析失败**：`throwOnError: false` 走 KaTeX 自带红字 error，仍能展示源码。
3. **XSS**：后端 `escape_html` 包 `data-source`；前端 mermaid 走 `securityLevel: 'strict'`（不执行 mermaid 源码里任何 JS）；KaTeX 走 `katex.render`（纯排版、不 eval）。
4. **主题切换**：自动重渲 mermaid，KaTeX 跟随 CSS 变量。
5. **同 source 重复**：前端 `svgCache` + `dataset.rendered` 双层短路；切 tab 切回不重渲。
6. **未保存文档 / 新标签**：渲染照常走——`previewResult.html` 由 docStore 投影兜底。
7. **慢 mermaid**：dynamic import + 占位符空 div 期间不阻塞；用户感知为「渲染稍后出现」。

## 9. 测试

### 9.1 Rust（`cargo test --workspace`）

照 `html.rs` 末尾 `mod tests` 模式新增 5 个测试（详见 §6.3）。

### 9.2 前端（`pnpm build` tsc 严格编译 + `docs/regression-checklist.md` 增补手工条目）

1. ```mermaid flowchart 块渲染为可点击链接的 SVG 节点（flowchart 默认带超链接行为）。
2. `$x^2$` 行内渲染为 KaTeX 上下标。
3. `$$\n\sum\n$$` 块状渲染为 display 模式。
4. `\`\`\`math\n\sum\n\`\`\`` 同样渲染为 display。
5. 切 dark 主题，mermaid 重渲（颜色变了）。
6. 故意写错 mermaid 语法 → 占位符内显示错误信息，页面其他内容正常。
7. 工具栏 mermaid 按钮插入空围栏并把光标落在中间。
8. 工具栏公式按钮：选区 "hello" → `$hello$` 光标落在 `$` 后面；无选区 → `$|$` 光标在中间。
9. XSS 测试：```mermaid 含 `<script>alert(1)</script>` 源码 → 渲染成纯文本不弹窗。
10. 双语模式下 mermaid 块不消耗 sub_counter（与 §6.3 第 5 项同源，前端手工 spot-check）。

## 10. 参考资料

- mark2 `src/utils/mermaidRenderer.js`——mermaid 加载、缓存、错误降级模式。
- mark2 `src/extensions/MathBlock.js`——math 块挂载思路（不直接复用，mark2 是 TipTap，qingbird 是 Rust+CM6）。
- SuperMarkdown `src/renderer/editor/katexEmbedded.css`——KaTeX 字体嵌入做法（决定走 npm 打包而非 base64）。
- 本仓 `src-tauri/src/markdown/html.rs`——后端 emit 占位符插入位置；`PreviewView.tsx`——前端注入管线插入位置。
- 本仓 `src/components/EditorToolbar.tsx`——现有插入按钮模式（B/I/CodeBlock 等）。
