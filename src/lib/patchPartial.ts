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
  // nextElementSibling 静态类型是 Element；tr-box 恒为 div（本函数自建或既有
  // 均出自 createElement）——断言收敛到 HTMLElement，下方 style 访问才合法
  //（brief 原片段按 Element 推导，`box.style` 必报 TS2339，唯一类型适配点）。
  let box = host.nextElementSibling as HTMLElement | null;
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

/** 流式态样式开关（单单元裸发增量）：灰字+省略号标记"请求在途"，完整 Unit
 * 定格（done/instant）时关闭。锚点缺失静默跳过（与 patchPartial 同口径）。
 * translation 模式作用在 run 元素本身；bilingual 作用在 tr-box（nextElementSibling）。 */
export function setStreamingFlag(el: HTMLElement, mode: Mode, index: number, on: boolean) {
  const node =
    mode === "bilingual"
      ? (el.querySelector(`[data-bi="${index}"]`)?.nextElementSibling as HTMLElement | null)
      : (el.querySelector(`[data-ri="${index}"]`) as HTMLElement | null);
  if (node instanceof HTMLElement) {
    node.classList.toggle("tr-streaming", on);
  }
}
