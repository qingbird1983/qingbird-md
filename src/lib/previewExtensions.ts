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
