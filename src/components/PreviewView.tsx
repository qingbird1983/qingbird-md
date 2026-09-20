// 预览主视图（Task 20）。
//
// XSS 信任边界（勿改）：本组件以 dangerouslySetInnerHTML 等价的方式把 html 赋给
// 容器 innerHTML——字符串生产者唯一：src-tauri/markdown/html.rs（parseResult 与
// done payload 的三形态 html 皆出于此），其中所有文本节点与属性值均经 escape_html
// 转义，markdown / 文档内容永远无法注入标签或脚本。前端在此层只做四件 DOM 后
// 处理：图片 src 经后端 resolve_image 解析成绝对路径再转 asset 协议、代码块
// 注入复制按钮、标题注入折叠 caret；
// 四：翻译进行中的流式回填（patchPartial）——partial 事件放行的块经
// textContent / createElement 写入，绝不拼 HTML 字符串（XSS 边界同上）。
// 绝不向 HTML 字符串拼接任何文档派生内容。
//
// 渲染管线：useEffect([html, baseDir]) 先整树重建 innerHTML（旧图片改写与按钮
// 随之清空，天然幂等防重复），再异步改写图片。翻译/对照形态（Task 23）：done
// payload 附带的译文 html 经 docStore.doneHtml 流入——当前阅读模式与批次形态、
// 内容一致时直接采用（零延迟），否则回退 parseResult.html（原文渲染）兜底。
//
// （P2-8e 拆分）渲染注入（含 reveal patcher/committed 回填/链接接管/mermaid
// 主题）在 hooks/usePreviewRender，滚动同步（ResizeObserver/视口上报/分栏总线）
// 在 hooks/usePreviewScrollSync，划词（selectionchange + 选区→源码）在
// hooks/usePreviewSelection，右键菜单在 hooks/usePreviewContextMenu；DOM 注入
// 函数在 lib/previewInject。本组件只留 refs 接线、store 订阅、边缘拖宽与 JSX。
// resetSplitSync / classifyPreviewHref / StreamFollower 的红线注释与导出在各自
// lib 内未动。
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUp } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { contentWidthPx, edgeDragWidth } from "../lib/contentWidth";
import { startColDrag } from "../lib/colDrag";
import type { SplitAnchor } from "../lib/splitSync";
import { useDocStore } from "../stores/useDocStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore, type PanelSide } from "../stores/useUiStore";
import { usePreviewRender } from "../hooks/usePreviewRender";
import { usePreviewScrollSync } from "../hooks/usePreviewScrollSync";
import { usePreviewSelection } from "../hooks/usePreviewSelection";
import { usePreviewContextMenu } from "../hooks/usePreviewContextMenu";

export default function PreviewView() {
  const ref = useRef<HTMLDivElement>(null);
  const content = useDocStore((s) => s.doc?.content ?? null);
  const mode = useDocStore((s) => s.mode);
  const parseHtml = useDocStore((s) => s.parseResult?.html ?? null);
  const doneHtml = useDocStore((s) => s.doneHtml);
  const partialBlocks = useTranslationStore((s) => s.partialBlocks);
  const partialCursor = useTranslationStore((s) => s.partialCursor);
  const partialGen = useTranslationStore((s) => s.partialGen);
  const baseDir = useDocStore((s) => s.doc?.base_dir ?? null);
  const ensureParsed = useDocStore((s) => s.ensureParsed);
  const contentWidth = useUiStore((s) => s.contentWidth);
  const customWidth = useUiStore((s) => s.customWidth);

  // ── 正文栏边缘拖宽把手（DSH 式）────────────────────────────
  // preview-wrap 是定位基准：把手贴 --qb-content-w 算出的栏边缘，
  // ResizeObserver 跟窗口/分栏拖动实时翻转显示（面板宽 > 生效宽 + 16 才
  // 有留白可调；rAF 合并防拖分栏时高频 setState）。
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hasDoc = content !== null;
  // Task 11：reveal patcher 与滚动观察的共享 refs——brief 要求把 d 组 refs 声明
  // 提前到组件体顶部区域（anchorsDirtyRef 被 patcher 与观察两个 effect 共享）。
  const typingHostRef = useRef<Map<number, HTMLElement | null>>(new Map());
  const anchorsRef = useRef<Array<{ idx: number; top: number }> | null>(null);
  const anchorsDirtyRef = useRef(true);
  const scrollRafRef = useRef(0);
  // 分栏同步：源行锚点表（<!--sl:N--> 注释 ↔ 块元素，索引与 anchorsRef 无关）。
  // 与 anchorsRef 共用脏标记——两者都是「DOM 重建 / 尺寸变化后必须整体重算」的
  // 同类产物，分开维护只会漏标一个。
  const lineAnchorsRef = useRef<SplitAnchor[] | null>(null);
  /** 上次被编辑器驱动到的锚点下标：同一块不重复写 scrollTop。 */
  const appliedLineRef = useRef(-1);
  /** 上次外发给编辑器的行号：滚动中同一块只推一次，避免每帧 dispatch 编辑器。 */
  const emittedLineRef = useRef(-1);
  /** 回顶按钮显隐（只在跨阈值时 setState，滚动中不重渲）。 */
  const [showTop, setShowTop] = useState(false);
  /** committed 回填水位（innerHTML 重建时复位）。 */
  const patchedRef = useRef<{ gen: number; upto: number }>({ gen: 0, upto: 0 });

  // ── 渲染注入（注入管线/reveal patcher/committed 回填/链接接管/mermaid 主题）──
  const { html } = usePreviewRender({
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
  });

  // ── 滚动同步（视口上报/回顶/分栏总线）──
  const { paneW } = usePreviewScrollSync({
    ref,
    wrapRef,
    scrollerRef,
    anchorsRef,
    anchorsDirtyRef,
    lineAnchorsRef,
    appliedLineRef,
    emittedLineRef,
    scrollRafRef,
    setShowTop,
    hasDoc,
    html,
  });

  // ── 划词（selectionchange 取词 + 预览选区→源码选中）──
  usePreviewSelection(ref);

  // ── 右键菜单（2026-09-12）──
  const { ctx, setCtx, onCtxMenu, ctxEntries } = usePreviewContextMenu(ref, hasDoc);

  const contentPx = contentWidthPx(contentWidth, customWidth);
  const showHandles = paneW > contentPx + 16;

  // 边缘拖宽：起手锁基准（getState 快照，不吃闭包旧 state）；拖拽中直接写
  // wrap 的 --qb-content-w（绕过 React——大文档回流不进 setState），松手
  // onEnd 一次落库 setCustomWidth，重渲写回同值（幂等）。
  const startEdgeDrag = (side: PanelSide) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const st = useUiStore.getState();
    const base = contentWidthPx(st.contentWidth, st.customWidth);
    const max = scrollerRef.current?.clientWidth ?? wrap.clientWidth;
    startColDrag(
      e,
      (dx) => wrap.style.setProperty("--qb-content-w", `${edgeDragWidth(side, base, dx, max)}px`),
      (dx) => {
        if (Math.abs(dx) < 2) return;
        useUiStore.getState().setCustomWidth(edgeDragWidth(side, base, dx, max));
      },
    );
  };

  // 药丸跟随：Y 直写热区 CSS 变量（零重渲），钳在热区内不出界（药丸半高 70）。
  // 拖拽中 pointer capture 把 move 重定向到热区自身，同一监听器继续生效。
  const trackPill = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const y = Math.max(70, Math.min(rect.height - 70, e.clientY - rect.top));
    el.style.setProperty("--pill-y", `${y}px`);
  };

  if (content === null) return <div className="preview-empty">未打开文档</div>;

  return (
    <div
      className="preview-wrap"
      ref={wrapRef}
      style={{ "--qb-content-w": `${contentPx}px` } as CSSProperties}
      onContextMenu={onCtxMenu}
    >
      <div className="preview-scroll" ref={scrollerRef}>
        <div className="markdown-body" ref={ref} />
      </div>
      {showHandles && (
        <>
          <div className="content-resizer left" onPointerDown={startEdgeDrag("left")} onPointerMove={trackPill} />
          <div className="content-resizer right" onPointerDown={startEdgeDrag("right")} onPointerMove={trackPill} />
        </>
      )}
      {/* 回到顶部：滚过一屏以上才淡入（见 PREVIEW_TOP_AT），点击平滑滚回顶部。
          平滑滚动期间 report 会把行号推给编辑器，两侧一起回到顶部。
          隐藏态用 tabIndex=-1 + visibility 彻底退出键盘与命中测试，不留隐形靶子。 */}
      <button
        type="button"
        className={`preview-top${showTop ? " on" : ""}`}
        title="回到顶部"
        aria-label="回到顶部"
        tabIndex={showTop ? 0 : -1}
        onClick={() => scrollerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <ArrowUp size={16} />
      </button>
      {ctx && (
        <ContextMenu anchor={{ x: ctx.x, y: ctx.y }} entries={ctxEntries()} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}
