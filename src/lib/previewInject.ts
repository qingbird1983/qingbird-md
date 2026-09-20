// 预览渲染注入的 DOM 后处理（P2-8d 自 components/PreviewView.tsx 纯提取，体逐字）。
//
// XSS 信任边界（勿改）：调用方（PreviewView）以 dangerouslySetInnerHTML 等价的
// 方式把 html 赋给容器 innerHTML——字符串生产者唯一：src-tauri/markdown/html.rs，
// 其中所有文本节点与属性值均经 escape_html 转义，markdown / 文档内容永远无法
// 注入标签或脚本。本文件是该层的 DOM 后处理之一：图片 src 经后端 resolve_image
// 解析成绝对路径再转 asset 协议、代码块注入复制按钮、标题注入折叠 caret。
// 绝不向 HTML 字符串拼接任何文档派生内容。
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./ipc";
import { codeTextFrom } from "./codeText";

/** img src 只在 DOM 层改写：resolve 失败/null（http/data 等）保持原样由浏览器加载。 */
export async function rewriteImages(scope: HTMLElement, baseDir: string | null) {
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

/** 复制/成功态图标：静态常量（非文档派生内容），遵循本文件 XSS 边界约定。 */
export const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
export const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

/**
 * 每个代码卡片头栏右侧注入复制按钮（一次性 mutation）；成功显示 ✓ 2s。
 * 取文走 codeTextFrom（只收 .lc 内容列）——.ln 行号与 .lc 同在 <code> 子树里，
 * 直接读 code.textContent 会把行号一起复制出去（html.rs flex 行契约）。
 */
export function addCopyButtons(scope: HTMLElement) {
  const cards = scope.querySelectorAll<HTMLElement>(".code-card");
  for (const card of Array.from(cards)) {
    if (card.querySelector(".copy-btn")) continue; // StrictMode 双跑防重复
    const head = card.querySelector<HTMLElement>(".code-head");
    const code = card.querySelector("code");
    if (!head || !code) continue;
    const actions = document.createElement("div");
    actions.className = "code-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.title = "复制代码";
    btn.innerHTML = ICON_COPY;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(codeTextFrom(code)).then(
        () => {
          btn.classList.add("ok");
          btn.innerHTML = ICON_CHECK;
          setTimeout(() => {
            btn.classList.remove("ok");
            btn.innerHTML = ICON_COPY;
          }, 2000);
        },
        () => {}, // 剪贴板不可用：静默放弃，按钮还原
      );
    });
    actions.appendChild(btn);
    head.appendChild(actions);
  }
}

/**
 * 标题折叠（对齐旧版 UI）：每个标题前置 ▼ caret，点击隐藏到下一个同级或
 * 更高级标题为止的全部兄弟节点。折叠态存 DOM（inline display），重渲染
 * （内容变化 → innerHTML 重建）即重置——ponytail: 折叠不跨编辑保留，
 * 需要持久化时提升到 uiStore 按 contentKey 记忆。
 */
export function addHeadingToggles(scope: HTMLElement) {
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
