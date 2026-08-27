// 预览主视图（Task 20）。
//
// XSS 信任边界（勿改）：本组件以 dangerouslySetInnerHTML 等价的方式把
// `parseResult.html` 赋给容器 innerHTML——该字符串的唯一生产者是
// src-tauri/markdown/html.rs，其中所有文本节点与属性值均经 escape_html 转义，
// markdown / 文档内容永远无法注入标签或脚本。前端在此层只做两件 DOM 后处理：
// 图片 src 经后端 resolve_image 解析成绝对路径再转 asset 协议、代码块注入复制
// 按钮；绝不向 HTML 字符串拼接任何文档派生内容。
//
// 渲染管线：useEffect([html, baseDir]) 先整树重建 innerHTML（旧图片改写与按钮
// 随之清空，天然幂等防重复），再异步改写图片。翻译/对照形态复用同一管线：
// 按 plan 定案三种形态 html 应随 translation-done payload 下发并经
// docStore.parseResult 单一来源流入（Task 8 未随附该扩展，见 task-20-report）。
import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
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
    btn.textContent = "复制";
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
            btn.textContent = "复制";
          }, 2000);
        },
        () => {}, // 剪贴板不可用：静默放弃，按钮还原
      );
    });
    pre.appendChild(btn);
  }
}

export default function PreviewView() {
  const ref = useRef<HTMLDivElement>(null);
  const content = useDocStore((s) => s.doc?.content ?? null);
  const html = useDocStore((s) => s.parseResult?.html ?? null);
  const baseDir = useDocStore((s) => s.doc?.base_dir ?? null);
  const ensureParsed = useDocStore((s) => s.ensureParsed);

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
  }, [html, baseDir]);

  if (content === null) return <div className="preview-empty">未打开文档</div>;

  return (
    <div className="preview-scroll">
      <div className="markdown-body" ref={ref} />
    </div>
  );
}
