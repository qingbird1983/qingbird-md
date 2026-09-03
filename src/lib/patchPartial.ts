// 翻译流式回填的单块 patch（PreviewView 的 DOM 后处理，独立成纯函数便于测试）。
// XSS 边界：只用 createElement + textContent，LLM 译文永不解析为 HTML。
import type { Mode } from "../types/ipc";

/**
 * 把一个已放行的译文块 patch 进预览 DOM。锚点缺失/形态不符静默跳过：
 * done 事件随后整树重建兜底，不在此层重试。
 */
export function patchPartial(el: HTMLElement, mode: Mode, index: number, text: string) {
  if (mode === "bilingual") {
    const host = el.querySelector(`[data-bi="${index}"]`);
    if (!host) return;
    // 已有 tr-box（双语重跑：缓存未命中/设置变更/中途停止后再次起跑）→ 更新
    // 而非跳过，否则整条 partial 流被静默吞掉；StrictMode 双跑由 PreviewView
    // 的 patchedRef 水位防重（refs 跨双挂载存活），无需在此防。
    const existing = host.nextElementSibling;
    if (existing?.classList.contains("tr-box")) {
      existing.textContent = text;
      return;
    }
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
