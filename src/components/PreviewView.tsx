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
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";
import { contentWidthPx, edgeDragWidth } from "../lib/contentWidth";
import { startColDrag } from "../lib/colDrag";
import { lockTypingHost, patchPartial, unlockTypingHost } from "../lib/patchPartial";
import { handlePreviewLinkClick } from "../lib/linkSafety";
import { renderMathPlaceholders, renderMermaidPlaceholders, clearMermaidCache, reconfigureMermaidTheme } from "../lib/previewExtensions";
// 样式：markdown.css 由 main.tsx 全局导入（此处再导入会与树摇后的主路径重复）

/** img src 只在 DOM 层改写：resolve 失败/null（http/data 等）保持原样由浏览器加载。 */
async function rewriteImages(scope: HTMLElement, baseDir: string | null) {
  const imgs = Array.from(scope.querySelectorAll("img[src]"));
  await Promise.all(
    imgs.map(async (img) => {
      const raw = img.getAttribute("src");
      if (!raw) return;
      const abs = await api.resolveImage(raw, baseDir);
      if (abs === null) return;
      // 改写后的值是 asset 协议地址，与原始 attr 不再匹配——重渲染走整树重建，
      // 永远从 fresh DOM 重新 resolve，不存在对已改写值的二次解析循环。
      img.setAttribute("src", convertFileSrc(abs));
    }),
  );
}

/** 每个代码块右上注入复制按钮（一次性 mutation）；成功显示 ✓ 2s。 */
function addCopyButtons(scope: HTMLElement) {
  const blocks = scope.querySelectorAll<HTMLPreElement>("pre.code-block");
  for (const pre of Array.from(blocks)) {
    if (pre.querySelector(".copy-btn")) continue; // StrictMode 双跑防重复
    const code = pre.querySelector("code");
    if (!code) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "⧉";
    btn.title = "复制代码";
    btn.addEventListener("click", () => {
      // 剥离 .ln 行号：克隆 code 节点并移除行号 span，再取纯代码文本。
      const clone = code.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".ln").forEach((n) => n.remove());
      navigator.clipboard.writeText(clone.textContent ?? "").then(
        () => {
          btn.classList.add("ok");
          btn.textContent = "✓";
          setTimeout(() => {
            btn.classList.remove("ok");
            btn.textContent = "⧉";
          }, 2000);
        },
        () => {}, // 剪贴板不可用：静默放弃，按钮还原
      );
    });
    pre.appendChild(btn);
  }
}

/**
 * 标题折叠（对齐旧版 UI）：每个标题前置 ▼ caret，点击隐藏到下一个同级或
 * 更高级标题为止的全部兄弟节点。折叠态存 DOM（inline display），重渲染
 * （内容变化 → innerHTML 重建）即重置——ponytail: 折叠不跨编辑保留，
 * 需要持久化时提升到 uiStore 按 contentKey 记忆。
 */
function addHeadingToggles(scope: HTMLElement) {
  const heads = scope.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6");
  for (const h of Array.from(heads)) {
    if (h.querySelector(".h-toggle")) continue; // StrictMode 双跑防重复
    const level = Number(h.tagName[1]);
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "h-toggle";
    caret.textContent = "▼";
    caret.title = "折叠/展开本节";
    caret.setAttribute("aria-expanded", "true");
    caret.addEventListener("click", () => {
      const collapsed = h.classList.toggle("h-collapsed");
      caret.textContent = collapsed ? "▶" : "▼";
      caret.setAttribute("aria-expanded", collapsed ? "false" : "true");
      let sib = h.nextElementSibling;
      while (sib) {
        const isStop =
          sib.matches("h1,h2,h3,h4,h5,h6") && Number(sib.tagName[1]) <= level;
        if (isStop) break;
        (sib as HTMLElement).style.display = collapsed ? "none" : "";
        sib = sib.nextElementSibling;
      }
    });
    h.prepend(caret);
  }
}

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
  const [paneW, setPaneW] = useState(0);
  const hasDoc = content !== null;
  // Task 11：reveal patcher 与滚动观察的共享 refs——brief 要求把 d 组 refs 声明
  // 提前到组件体顶部区域（anchorsDirtyRef 被 patcher 与观察两个 effect 共享）。
  const typingHostRef = useRef<Map<number, HTMLElement | null>>(new Map());
  const anchorsRef = useRef<Array<{ idx: number; top: number }> | null>(null);
  const anchorsDirtyRef = useRef(true);
  const scrollRafRef = useRef(0);
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
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasDoc]);
  const contentPx = contentWidthPx(contentWidth, customWidth);
  const showHandles = paneW > contentPx + 16;

  // 边缘拖宽：起手锁基准（getState 快照，不吃闭包旧 state）；拖拽中直接写
  // wrap 的 --qb-content-w（绕过 React——大文档回流不进 setState），松手
  // onEnd 一次落库 setCustomWidth，重渲写回同值（幂等）。
  const startEdgeDrag = (side: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
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
    void renderMermaidPlaceholders(el);
  }, [html, baseDir]);

  // innerHTML 重建（doneHtml/parse 切换）会抹掉所有 patch——水位复位，
  // 让下方 committed patch effect 从头重放（幂等，committed 都是完整译文）。
  // 锚点表同步标脏（brief 未列，本任务适配）：重建后各块 offsetTop 全变，
  // 不标脏则下次滚动上报仍用旧锚点，视口索引跨文档/跨重建错位。
  const patchedRef = useRef<{ gen: number; upto: number }>({ gen: 0, upto: 0 });
  useEffect(() => {
    patchedRef.current.upto = 0;
    anchorsDirtyRef.current = true;
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
    report(); // 挂载/整树重建即上报一次（首次窗口用真实视口而非回退值）
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      // 取消后句柄必须清零：残留 truthy 会让 onScroll 永久 early-return，滚动上报死亡。
      scrollRafRef.current = 0;
    };
  }, [hasDoc, html]);

  // 划词翻译（选区查词）预览侧捕获：编辑器侧由 App.tsx 的 CM cursorSel 订阅
  // 覆盖，预览渲染 DOM 没有 CM 选区事件——这里监听 selectionchange，锚点落
  // 在本预览容器内才取词交给 translateSelection（300ms 防抖/乱序保护内置）。
  // 空选区不清浮窗：SelectionPopup「点外即关」已覆盖（预览内再按下亦然），
  // 且不能顺手清——分栏下选区在编辑器侧时 anchorNode 不在本容器，误清会关掉
  // 编辑器侧刚弹出的浮窗。
  useEffect(() => {
    const onSelChange = () => {
      if (!useSettingsStore.getState().settings?.selection_translate) return;
      const el = ref.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
      const text = sel.toString();
      if (text.trim()) useTranslationStore.getState().translateSelection(text);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, []);

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

  if (content === null) return <div className="preview-empty">未打开文档</div>;

  return (
    <div
      className="preview-wrap"
      ref={wrapRef}
      style={{ "--qb-content-w": `${contentPx}px` } as CSSProperties}
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
    </div>
  );
}
