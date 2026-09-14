// 前端预览扩展：mermaid 图表渲染 + KaTeX 数学公式渲染。
//
// 数据契约：后端 html.rs 在 render_html 时已识别 ```mermaid / $...$ / $$...$$
// / ```math 并 emit 占位符 DOM（见 spec 2026-08-30 §5.1）；本模块只替换占位符
// 内容，XSS 边界由后端 escape_html + 本模块不向 innerHTML 拼任何文档派生字符串
// 共同维护。

import katex from "katex";
import { isDarkTheme } from "../stores/useSettingsStore";

// ── mermaid 懒加载单例（dynamic import，不入首屏） ────────────────────────────
//
// 注意这条链路在 dev 与 build 下的形态完全不同：build 里 mermaid 是单个
// 3MB chunk，dev 里 Vite 的依赖预打包把它拆成「入口 + 60 多个 chunk」的异步
// 图（`node_modules/.vite/deps/mermaid.js` 只 60KB，其余全在 chunk 里）。
// 因此 dev 下一次失败的概率远高于 build，且失败形态是**整条 import 不 settle**。
// 下面的写法针对这两点：不缓存失败的 promise（可重试）、失败必须写进 DOM（可见）。

type MermaidApi = typeof import("mermaid").default;

/** 懒加载单例。**只存 fulfilled 的 promise**——失败由 armMermaidPromise 清空。 */
let mermaidPromise: Promise<MermaidApi> | null = null;

/** 取 default，并兜底打包器 interop 差异（dev 预打包与 build 的落点可能差一层）。 */
function pickMermaid(mod: unknown): MermaidApi {
  const a = (mod as { default?: unknown }).default ?? mod;
  return ((a as { default?: unknown }).default ?? a) as MermaidApi;
}

/** 加载上限。dev 的异步链偶发**永不 settle**（不是 reject！），不设上限就永远等下去。 */
const MERMAID_LOAD_TIMEOUT_MS = 15_000;

function initMermaid(): Promise<MermaidApi> {
  const load = import("mermaid").then((m) => {
    const mermaid = pickMermaid(m);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // 关键：不执行 mermaid 源码里的脚本
      theme: isDarkTheme() ? "dark" : "default",
    });
    return mermaid;
  });
  // 护栏：把「挂起」转成可重试的失败。Promise.race 已替双方挂了 handler，
  // 迟到的 load 若再 reject 不会变成 unhandled rejection。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`mermaid 加载超过 ${MERMAID_LOAD_TIMEOUT_MS / 1000}s（依赖未就绪，可重试）`)),
      MERMAID_LOAD_TIMEOUT_MS
    );
  });
  return Promise.race([load, guard]).finally(() => clearTimeout(timer));
}

/** 装上单例并把「失败不留缓存」这条规矩一并挂上（两处调用都要，故抽出来）。 */
function armMermaidPromise(): Promise<MermaidApi> {
  const p = initMermaid();
  mermaidPromise = p;
  // 失败的 promise 一旦留在单例里，就等于「本次会话再也不会有图」——而且调用方
  // 是 `void renderMermaidPlaceholders(el).then(...)`，rejection 被吞掉，用户
  // 只会看到一块空白，分不清「加载失败」和「文档里本来没有图」。故：失败即清，
  // 下次进预览还能再试一次。
  p.catch(() => {
    if (mermaidPromise === p) mermaidPromise = null;
  });
  return p;
}

async function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise) return mermaidPromise;
  return armMermaidPromise();
}

// 主题重配（外部调用：PreviewView 在 isDarkTheme 变化时触发）
export function reconfigureMermaidTheme() {
  // 重新初始化并清缓存（renderMermaidPlaceholders 会再次触发 initialize 也行，
  // 这里显式重配以避免「先 await loadMermaid 再 initialize」的时序坑）
  // 注意：这里也必须走 armMermaidPromise——否则一个 rejected promise 会直接
  // 落在单例上，把后续所有渲染（含重试）一起钉死。
  void armMermaidPromise();
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

/** 把失败原因写进占位符（与解析失败同一样式），绝不静默留白。 */
function showMermaidError(el: HTMLElement, msg: string) {
  const err = document.createElement("pre");
  err.className = "mermaid-error";
  err.textContent = msg;
  el.replaceChildren(err);
  // 故意**不**写 dataset.rendered：留空才能让下次调用重试（失败不该是终态）
}

export async function renderMermaidPlaceholders(scope: HTMLElement) {
  const els = Array.from(scope.querySelectorAll<HTMLElement>(".mermaid[data-source]")).filter(
    (el) => el.dataset.rendered !== (el.getAttribute("data-source") ?? "")
  );
  // 文档里没有图就别付 3MB 动态导入的代价（本函数在每次 html 变化时都会被调）
  if (els.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch (e) {
    // 走到这里说明**加载**就失败了（模块没拿到），不是解析失败。必须可见：
    // 否则调用方 `void ...then(...)` 把 rejection 吞掉，用户只见空白，分不清
    // 「加载挂了」和「文档本来没图」。
    for (const el of els) showMermaidError(el, `[mermaid 加载失败]\n${String(e)}`);
    return;
  }

  await Promise.all(
    els.map(async (el) => {
      const src = el.getAttribute("data-source") ?? "";
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
        // 解析失败是终态（同样源码再渲也不会好），所以这里**写** rendered 做幂等
        showMermaidError(el, `[mermaid 解析失败]\n${String(e)}`);
        el.dataset.rendered = src;
      }
    })
  );
}
