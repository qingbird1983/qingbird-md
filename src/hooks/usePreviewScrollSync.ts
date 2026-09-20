// 预览滚动同步 hook（P2-8e 自 components/PreviewView.tsx 纯提取）：
// ResizeObserver 观察滚动容器、data-bi 锚点与源行锚点双表重建、rAF 节流的视口
// 上报（setViewport + 回顶按钮 + 主动方行号外发）、编辑器→预览的被动跟随。
// 分栏同步总线（lib/splitSync）的接线逐字不变。
import { useEffect, useState, type RefObject } from "react";
import { collectLineAnchors } from "../lib/previewAnchor";
import {
  anchorIndexForLine,
  anchorIndexForTop,
  emitSplitSync,
  splitSyncLocked,
  subscribeSplitSync,
  type SplitAnchor,
} from "../lib/splitSync";
import { useDocStore } from "../stores/useDocStore";
import { useTranslationStore } from "../stores/useTranslationStore";

/** 回顶按钮出现阈值（px）：短文不该顶一个按钮晃眼。 */
const PREVIEW_TOP_AT = 320;

export interface PreviewScrollSyncDeps {
  /** 预览容器（.markdown-body，锚点表重建的扫描根）。 */
  ref: RefObject<HTMLDivElement | null>;
  /** 定位基准（.preview-wrap，--sb-w 写在其上）。 */
  wrapRef: RefObject<HTMLDivElement | null>;
  /** 滚动容器（.preview-scroll）。 */
  scrollerRef: RefObject<HTMLDivElement | null>;
  anchorsRef: { current: Array<{ idx: number; top: number }> | null };
  anchorsDirtyRef: { current: boolean };
  /** 源行锚点表（<!--sl:N--> 注释 ↔ 块元素，供分栏同步）。 */
  lineAnchorsRef: { current: SplitAnchor[] | null };
  /** 上次被编辑器驱动到的锚点下标：同一块不重复写 scrollTop。 */
  appliedLineRef: { current: number };
  /** 上次外发给编辑器的行号：滚动中同一块只推一次。 */
  emittedLineRef: { current: number };
  scrollRafRef: { current: number };
  /** 回顶按钮显隐 setter（state 在壳，JSX 读取）。 */
  setShowTop: (v: boolean) => void;
  hasDoc: boolean;
  html: string | null;
}

export function usePreviewScrollSync(deps: PreviewScrollSyncDeps) {
  const {
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
  } = deps;
  const [paneW, setPaneW] = useState(0);

  // 观察滚动容器内容宽（clientWidth 不含经典滚动条）：把手定位与拖宽钳制都以它为准；
  // 滚动条宽 = scroller offsetWidth − clientWidth，写 --sb-w 供 CSS 定位取用——
  // 正文栏在内容盒内居中（margin auto），不在 wrap 全宽内居中。
  useEffect(() => {
    const el = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap || !hasDoc) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      raf ||= requestAnimationFrame(() => {
        raf = 0;
        setPaneW(el.clientWidth);
        wrap.style.setProperty("--sb-w", `${el.offsetWidth - el.clientWidth}px`);
        // 宽度变了 → 文本重排 → 各块 offsetTop 全变，两份锚点表都必须重算。
        // （不在这里重算本身：标脏即可，真正的重建推迟到下一次滚动上报。）
        anchorsDirtyRef.current = true;
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasDoc]);
  // （wrapRef 为稳定 ref，不入 deps——与原实现一致。）

  // ── 滚动观察：rAF 节流 + data-bi 锚点 offsetTop 缓存 + 二分 → setViewport ──
  // offsetTop 语义已验证（brief 要求先验证再选用）：.markdown-body 与
  // .preview-scroll 的 CSS 均无定位，唯 .preview-wrap position:relative（无
  // border/padding）——data-bi 块的 offsetParent 即 preview-wrap，其 offsetTop
  // 与 preview-scroll 的 scrollTop 同系（同一未滚动坐标系，原点同在滚动容器
  // 顶缘），offsetTop 版成立，无需 rect 差值。
  // deps（brief 为 []，本任务适配）：无文档时组件早退渲染 preview-empty，
  // scrollerRef 为 null——[] 会在开档后永久失联；html 入 deps 使整树重建
  //（换档/换文档/canonical 重建）后立即重报一次真实视口，视口不串号。
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
    /** 两份锚点表一起重建（data-bi 供翻译视口、源行供分栏同步），代价一次付清。 */
    const rebuildAnchors = (el: HTMLElement) => {
      const list: Array<{ idx: number; top: number }> = [];
      el.querySelectorAll<HTMLElement>("[data-bi]").forEach((n) => {
        const bi = Number(n.dataset.bi);
        if (Number.isFinite(bi)) list.push({ idx: bi, top: n.offsetTop });
      });
      list.sort((a, b) => a.top - b.top);
      anchorsRef.current = list;
      // 源行锚点也按 offsetTop 同系（offsetParent 同为 .preview-wrap），
      // 与 scroller.scrollTop 可直接相减/赋值，无需 rect 差值。
      lineAnchorsRef.current = collectLineAnchors(el)
        .map((a) => ({ line: a.line, top: a.el.offsetTop }))
        .sort((a, b) => a.line - b.line);
      anchorsDirtyRef.current = false;
    };
    const report = () => {
      const el = ref.current;
      if (!el) return;
      if (anchorsDirtyRef.current || !anchorsRef.current || !lineAnchorsRef.current) {
        rebuildAnchors(el);
      }
      const y = scroller.scrollTop;

      // 回顶按钮（无 data-bi 的纯中文文档也要生效，故排在下面的早退之前）
      setShowTop(y > PREVIEW_TOP_AT);

      // 分栏同步：把「预览当前顶块」的源行号推给编辑器。被编辑器驱动时
      // （splitSyncLocked）不上报，否则两侧互相推让滚不停。同块只推一次，
      // 免得平滑滚动期间每帧都去 dispatch 编辑器。
      if (useDocStore.getState().view === "split" && !splitSyncLocked("preview")) {
        const la = lineAnchorsRef.current;
        const i = la && la.length > 0 ? anchorIndexForTop(la, y) : -1;
        const line = i >= 0 ? la![i]!.line : -1;
        if (line > 0 && line !== emittedLineRef.current) {
          emittedLineRef.current = line;
          // 本侧开始当「主动方」：之前给对侧的被动跟随记录作废（那些位置是
          // 对侧拖过来的，不代表本侧主动滚过），否则下次回到同一块会被去重吃掉。
          appliedLineRef.current = -1;
          emitSplitSync("preview", line);
        }
      }

      const anchors = anchorsRef.current;
      if (!anchors || anchors.length === 0) return;
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
    report(); // 挂载/整树重建即上报一次（首次窗口用真实视口而非回退值）
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      // 取消后句柄必须清零：残留 truthy 会让 onScroll 永久 early-return，滚动上报死亡。
      scrollRafRef.current = 0;
    };
  }, [hasDoc, html]);

  // ── 分栏同步（反向）：编辑器顶行 → 预览对齐 ──────────────────
  // 只做被动跟随（本侧的主动上报在上面的 report 里）。收到行号立刻写 scrollTop，
  // 不走 smooth：平滑滚动会在 180ms 锁窗之外继续派发 scroll 事件，行号又被弹回去。
  useEffect(() => {
    return subscribeSplitSync("preview", (line) => {
      const scroller = scrollerRef.current;
      const la = lineAnchorsRef.current;
      if (!scroller || !la || la.length === 0) return;
      const i = anchorIndexForLine(la, line);
      if (i < 0 || i === appliedLineRef.current) return;
      appliedLineRef.current = i;
      // 本侧转为「被动方」：把主动上报的记录作废——位置是编辑器拖过来的，
      // 不代表本侧滚过这一块；不清的话用户随后手动滚回同一块会被去重吃掉。
      emittedLineRef.current = -1;
      scroller.scrollTop = la[i]!.top;
    });
  }, []);

  return { paneW };
}
