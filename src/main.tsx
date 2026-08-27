import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
// 预览样式（Task 20）需在此导入：PreviewView 由 T22 的 MainArea 才挂载，
// 仅靠组件内导入会被 vite 连同未引用模块一起树摇剔除。
import "./styles/markdown.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
