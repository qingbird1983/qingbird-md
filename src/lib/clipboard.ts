// 剪贴板助手（P2-8d 自 components/Sidebar.tsx 纯提取）。
import { useUiStore } from "../stores/useUiStore";

/** 复制文本到剪贴板：navigator.clipboard 失败时退回 textarea + execCommand。 */
export async function copyText(text: string, what = "路径") {
  const ui = useUiStore.getState();
  try {
    await navigator.clipboard.writeText(text);
    ui.addToast("success", `已复制${what}`);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      ui.addToast("success", `已复制${what}`);
    } catch {
      ui.addToast("error", "复制失败");
    }
  }
}
