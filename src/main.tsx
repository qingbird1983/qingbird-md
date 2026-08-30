import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/theme.css"; // T30：主题变量 + CJK 字体栈（先于 global 载入）
import "./styles/global.css";
// 预览样式（Task 20）需在此导入：PreviewView 由 T22 的 MainArea 才挂载，
// 仅靠组件内导入会被 vite 连同未引用模块一起树摇剔除。
import "./styles/markdown.css";
import App from "./App";
// KaTeX CSS 必须在首次 katex.render 前导入（previewExtensions 懒加载 mermaid，
// 但 katex 是同步 import，CSS 放 main.tsx 全局保障样式先于任何渲染就绪）
import "katex/dist/katex.min.css";

// 桌面应用禁用 WebView 原生右键菜单：其"刷新"会整页重载，前端内存态
// （打开的文档、未保存编辑）全丢——"右击刷新清空文档"即源于此。
// DevTools 调试不受影响（F12 / Tauri devtools）。
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 滚动条淡显淡出（样式见 global.css 尾部）：scroll 事件不冒泡，捕获阶段
// 委托一次即覆盖所有滚动容器——滚动开始给容器加 .scrolling 渐显滑块，
// 停止 900ms 后摘除渐隐；计时按元素各记一份（WeakMap），多容器互不干扰。
const scrollTimers = new WeakMap<Element, number>();
document.addEventListener(
  "scroll",
  (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    el.classList.add("scrolling");
    const prev = scrollTimers.get(el);
    if (prev !== undefined) clearTimeout(prev);
    scrollTimers.set(
      el,
      window.setTimeout(() => el.classList.remove("scrolling"), 900),
    );
  },
  true,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
