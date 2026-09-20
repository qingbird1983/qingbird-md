// 预览右键菜单 hook（P2-8e 自 components/PreviewView.tsx 纯提取）：
// 菜单状态、选区辅助（复制选中/复制全文/全选渲染层）与菜单项构造。
// 预览是只读渲染层：复制/全选作用于渲染结果，插入类动作落到源码光标处
// （insertFromPreview 会先切到源码视图等编辑器挂载）。
import { useState, type RefObject } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { ClipboardCopy, Copy, Plus, SquareCode, TextSelect } from "lucide-react";
import type { CtxEntry } from "../components/ContextMenu";
import { insertFormula, insertFromPreview, insertMermaid, insertSnippet } from "../lib/inserts";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";

export function usePreviewContextMenu(ref: RefObject<HTMLDivElement | null>, hasDoc: boolean) {
  // ── 右键菜单（2026-09-12）────────────────────────────
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const onCtxMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!hasDoc) return; // 无文档时不弹（欢迎页自己接管）
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const selectionInPreview = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !ref.current) return "";
    const node = sel.anchorNode;
    return node && ref.current.contains(node) ? sel.toString() : "";
  };

  const copySelection = () => {
    const text = selectionInPreview();
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => useUiStore.getState().addToast("success", "已复制选中内容"))
      .catch(() => useUiStore.getState().addToast("error", "复制失败"));
  };

  const copyWholeDoc = () => {
    const text = useDocStore.getState().doc?.content ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => useUiStore.getState().addToast("success", "已复制全文 Markdown"))
      .catch(() => useUiStore.getState().addToast("error", "复制失败"));
  };

  const selectAllRendered = () => {
    const host = ref.current;
    if (!host) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(host);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // 只读渲染层的右键菜单。编辑类动作（剪切/粘贴/删除）暂不接——预览要能真正
  // 编辑得等所见即所得，现在挂上去只会错落到源码光标处，反而困惑。
  // 快捷键只标真实可用的：Ctrl+C / Ctrl+A 是 WebView 原生选区行为，
  // Ctrl+E 是 App.tsx 的源码/预览切换键（从预览出发正好落在源码）。
  const ctxEntries = (): CtxEntry[] => [
    {
      label: "复制",
      icon: <Copy size={14} />,
      shortcut: "Ctrl+C",
      disabled: !selectionInPreview(),
      onSelect: copySelection,
    },
    { label: "复制全文 Markdown", icon: <ClipboardCopy size={14} />, onSelect: copyWholeDoc },
    { label: "全选", icon: <TextSelect size={14} />, shortcut: "Ctrl+A", onSelect: selectAllRendered },
    { kind: "sep" },
    {
      label: "插入",
      icon: <Plus size={14} />,
      children: [
        { label: "段落", onSelect: () => void insertFromPreview(() => insertSnippet("\n\n"), "段落") },
        { label: "一级标题", onSelect: () => void insertFromPreview(() => insertSnippet("\n# "), "一级标题") },
        { label: "二级标题", onSelect: () => void insertFromPreview(() => insertSnippet("\n## "), "二级标题") },
        { label: "三级标题", onSelect: () => void insertFromPreview(() => insertSnippet("\n### "), "三级标题") },
        { label: "引用", onSelect: () => void insertFromPreview(() => insertSnippet("\n> "), "引用") },
        {
          label: "代码块",
          onSelect: () =>
            void insertFromPreview(() => insertSnippet("\n```\n\n```\n", "\n```\n".length), "代码块"),
        },
        { kind: "sep" },
        { label: "分割线", onSelect: () => void insertFromPreview(() => insertSnippet("\n---\n"), "分割线") },
        {
          label: "表格",
          onSelect: () =>
            void insertFromPreview(
              () => insertSnippet("\n| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n"),
              "表格",
            ),
        },
        { label: "公式", onSelect: () => void insertFromPreview(insertFormula, "公式") },
        { label: "Mermaid 图表", onSelect: () => void insertFromPreview(insertMermaid, "Mermaid 图表") },
        { kind: "sep" },
        { label: "图片", onSelect: () => void insertFromPreview(() => insertSnippet("![](https://)"), "图片") },
        { label: "链接", onSelect: () => void insertFromPreview(() => insertSnippet("[](https://)"), "链接") },
      ],
    },
    { kind: "sep" },
    {
      label: "在源码中编辑",
      icon: <SquareCode size={14} />,
      shortcut: "Ctrl+E",
      onSelect: () => useDocStore.getState().switchView("source"),
    },
  ];

  return { ctx, setCtx, onCtxMenu, ctxEntries };
}
