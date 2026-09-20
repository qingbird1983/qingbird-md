// 预览渲染注入 hook（P2-8e 自 components/PreviewView.tsx 纯提取）：
// 译文形态判定（payloadHtml/html 派生）、ensureParsed 触发、innerHTML 重建管线、
// 水位复位、committed 回填、reveal DOM patcher、链接点击接管（linkSafety）、
// mermaid 主题跟随。DOM 注入函数在 lib/previewInject，textContent 路线经
// lib/patchPartial（XSS 边界见 PreviewView 文件头，勿改）。
import { useEffect, type RefObject } from "react";
import { api } from "../lib/ipc";
import { lockTypingHost, patchPartial, setStreamingFlag, unlockTypingHost } from "../lib/patchPartial";
import { handlePreviewLinkClick } from "../lib/linkSafety";
import {
  renderMathPlaceholders,
  renderMermaidPlaceholders,
  clearMermaidCache,
  reconfigureMermaidTheme,
} from "../lib/previewExtensions";
import { rewriteImages, addCopyButtons, addHeadingToggles } from "../lib/previewInject";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { useDocStore } from "../stores/useDocStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import type { Mode } from "../types/ipc";

export interface PreviewRenderDeps {
  /** 预览容器（.markdown-body）。 */
  ref: RefObject<HTMLDivElement | null>;
  /** reveal 打字期块宿主（start 锁高 / done 解锁）。 */
  typingHostRef: { current: Map<number, HTMLElement | null> };
  /** committed 回填水位（innerHTML 重建时复位）。 */
  patchedRef: { current: { gen: number; upto: number } };
  /** 两份锚点表共用的脏标记（注入/重建/行高变化都要标脏）。 */
  anchorsDirtyRef: { current: boolean };
  /** 上次被编辑器驱动到的锚点下标（innerHTML 重建时坐标系作废）。 */
  appliedLineRef: { current: number };
  /** 上次外发给编辑器的行号（innerHTML 重建时坐标系作废）。 */
  emittedLineRef: { current: number };
  /** 回顶按钮显隐 setter（重建后随后的滚动上报会用真实 scrollTop 纠正）。 */
  setShowTop: (v: boolean) => void;
  content: string | null;
  mode: Mode;
  parseHtml: string | null;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  baseDir: string | null;
  ensureParsed: () => void;
  partialBlocks: Map<number, string>;
  partialCursor: number;
  partialGen: number;
}

export function usePreviewRender(deps: PreviewRenderDeps) {
  const {
    ref,
    typingHostRef,
    patchedRef,
    anchorsDirtyRef,
    appliedLineRef,
    emittedLineRef,
    setShowTop,
    content,
    mode,
    parseHtml,
    doneHtml,
    baseDir,
    ensureParsed,
    partialBlocks,
    partialCursor,
    partialGen,
  } = deps;

  // 译文形态直用：当前阅读模式与批次形态匹配且内容未变。跑批期间的编辑/切档
  // 已在 done 落库处被 runContent 护栏拦下，这里 contentKey 再核一道（双保险）。
  const payloadHtml =
    mode !== "original" && doneHtml && doneHtml.mode === mode && doneHtml.contentKey === content
      ? doneHtml.html
      : null;
  const html = payloadHtml ?? parseHtml;

  // 与 OutlinePanel 同款触发：内容变化后保证 parseResult 新鲜（缓存命中零开销；
  // 大纲面板折叠时预览独自兜底）。ensureParsed 幂等且带乱序丢弃护栏。
  useEffect(() => {
    if (content !== null) void ensureParsed();
  }, [content, ensureParsed]);

  // 注入管线（见文件头注释）：innerHTML 重建 → 图片改写 → 复制按钮。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html ?? ""; // 文档切换瞬间置空，避免上一份内容闪留
    void rewriteImages(el, baseDir);
    addCopyButtons(el);
    addHeadingToggles(el);
    renderMathPlaceholders(el);
    // mermaid 是异步渲染：落位后块高变化 → 锚点表标脏。不标的话分栏同步会按
    // 「mermaid 还是空占位」时的位置对齐，图越多的文档偏得越厉害。
    void renderMermaidPlaceholders(el).then(() => {
      anchorsDirtyRef.current = true;
    });
  }, [html, baseDir]);

  // innerHTML 重建（doneHtml/parse 切换）会抹掉所有 patch——水位复位，
  // 让下方 committed patch effect 从头重放（幂等，committed 都是完整译文）。
  // 锚点表同步标脏（brief 未列，本任务适配）：重建后各块 offsetTop 全变，
  // 不标脏则下次滚动上报仍用旧锚点，视口索引跨文档/跨重建错位。
  useEffect(() => {
    patchedRef.current.upto = 0;
    anchorsDirtyRef.current = true;
    // 同步侧的两处「上次值」一并作废：换文档/重建后行号与块下标都换了坐标系，
    // 沿用旧值会让第一次同步被误判成「没变化」而不生效。
    appliedLineRef.current = -1;
    emittedLineRef.current = -1;
    setShowTop(false); // 随后的滚动上报会用真实 scrollTop 纠正
  }, [html]);

  // committed 回填：只处理上次水位之后新放行的已定格区间，逐块查锚点 patch。
  // partialGen 变化（新轮次/清空）即重置水位；innerHTML 重建 effect（上方）先
  // 整树重渲、水位 effect 再复位，本 effect 从 0 重放——三管线无缝交接。
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

  // ── reveal DOM patcher：start 锁高 / tick 切片 / done 定格解锁 / instant 直写 ──
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
          // 整段定型：块内全部 run 一次落地（translation 逐 run span；bilingual 单 run=块）
          for (const r of c.runs) {
            patchPartial(el, mode, r.index, r.text);
            setStreamingFlag(el, mode, r.index, false);
          }
          unlockTypingHost(typingHostRef.current.get(c.index) ?? null);
          typingHostRef.current.delete(c.index);
          anchorsDirtyRef.current = true; // 行高变化 → 锚点表标脏
          break;
        case "instant":
          for (const r of c.runs) {
            patchPartial(el, mode, r.index, r.text);
            setStreamingFlag(el, mode, r.index, false);
          }
          anchorsDirtyRef.current = true;
          break;
        case "stream":
          patchPartial(el, mode, c.index, c.text);
          setStreamingFlag(el, mode, c.index, true);
          break;
      }
    });
    return () => useTranslationStore.getState().registerPatcher(null);
  }, [mode]);

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
        // 抹掉 dataset.rendered 强制重渲（renderMermaidPlaceholders 的幂等
        // 短路先于缓存查询，不清 rendered 旧主题 SVG 会残留）
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

  // T25：预览链接点击接管。document capture 委托——预览容器 innerHTML 整树
  // 重建不丢监听、先于任何子元素 handler；只处理本预览容器内的 <a>：
  // http(s)/mailto/tel 走系统浏览器（open_external），# 锚点手动滚动，
  // 危险/相对链接一律吞掉。绝不发生 WebView 整窗导航（窗口被外部站点顶掉后
  // 标题栏操作键全失，只能强杀）。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      handlePreviewLinkClick(e, ref.current, (url) => {
        void api.openExternal(url).catch(() => {});
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return { html };
}
