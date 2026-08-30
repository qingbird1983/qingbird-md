// 预览主视图（Task 20）。
//
// XSS 信任边界（勿改）：本组件以 dangerouslySetInnerHTML 等价的方式把 html 赋给
// 容器 innerHTML——字符串生产者唯一：src-tauri/markdown/html.rs（parseResult 与
// done payload 的三形态 html 皆出于此），其中所有文本节点与属性值均经 escape_html
// 转义，markdown / 文档内容永远无法注入标签或脚本。前端在此层只做三件 DOM 后
// 处理：图片 src 经后端 resolve_image 解析成绝对路径再转 asset 协议、代码块
// 注入复制按钮、标题注入折叠 caret；绝不向 HTML 字符串拼接任何文档派生内容。
//
// 渲染管线：useEffect([html, baseDir]) 先整树重建 innerHTML（旧图片改写与按钮
// 随之清空，天然幂等防重复），再异步改写图片。翻译/对照形态（Task 23）：done
// payload 附带的译文 html 经 docStore.doneHtml 流入——当前阅读模式与批次形态、
// 内容一致时直接采用（零延迟），否则回退 parseResult.html（原文渲染）兜底。
import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";
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
  const baseDir = useDocStore((s) => s.doc?.base_dir ?? null);
  const ensureParsed = useDocStore((s) => s.ensureParsed);
  const wide = useUiStore((s) => s.wideContent);

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

  if (content === null) return <div className="preview-empty">未打开文档</div>;

  return (
    <div className="preview-scroll">
      <div className={wide ? "markdown-body wide" : "markdown-body"} ref={ref} />
    </div>
  );
}
