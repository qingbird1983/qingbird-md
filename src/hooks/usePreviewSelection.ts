// 预览划词 hook（P2-8e 自 components/PreviewView.tsx 纯提取）：
// 划词翻译（选区查词）的 selectionchange 捕获，与「预览选区 → 源码选中」的
// mouseup 定位（T25 期的分栏联动）。锚点落在本预览容器内才动作。
import { useEffect, type RefObject } from "react";
import { EditorView as CmEditorView } from "@codemirror/view";
import { collectLineAnchors, sourceRangeForSelection } from "../lib/previewAnchor";
import { lockSplitSide } from "../lib/splitSync";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useDocStore } from "../stores/useDocStore";
import { useTranslationStore } from "../stores/useTranslationStore";

export function usePreviewSelection(ref: RefObject<HTMLDivElement | null>) {
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

  // ── 预览选区 → 源码选中（2026-09-14）────────────────────────
  // 挂在 mouseup 而非 selectionchange：拖选过程中选区每帧都变，逐帧把光标甩进
  // 源码会打断用户拖拽；松手落一次，语义也更像「定位」。只在分栏下生效——
  // 单预览视图里 EditorView 根本没挂载（cmRef 为空），本就无处可落。
  useEffect(() => {
    const onUp = () => {
      if (useDocStore.getState().view !== "split") return;
      const host = ref.current;
      const sel = window.getSelection();
      if (!host || !sel || sel.isCollapsed) return;
      if (!sel.anchorNode || !host.contains(sel.anchorNode)) return;
      const text = sel.toString();
      if (!text.trim()) return;

      // 现场重收一次「注释 ↔ 块元素」配对：这里要的是元素本身（用于判断选区
      // 落在哪个块），而 lineAnchorsRef 只留了行号与像素顶边。mouseup 是低频
      // 动作，重扫一遍 childNodes 远比重算整表便宜，也不会吃到过期缓存。
      const la = collectLineAnchors(host);
      if (la.length === 0) return;
      const indexAt = (node: Node | null): number => {
        if (!node) return -1;
        for (let i = 0; i < la.length; i++) {
          if (la[i]!.el.contains(node)) return i;
        }
        return -1;
      };
      const a = indexAt(sel.anchorNode);
      const b = indexAt(sel.focusNode);
      if (a < 0 && b < 0) return; // 选区整个落在无锚点的区域（如文末脚注区）
      const first = b < 0 ? a : a < 0 ? b : Math.min(a, b);
      const last = b < 0 ? a : a < 0 ? b : Math.max(a, b);
      const fromLine = la[first]!.line;
      const nextLine = la[last + 1]?.line ?? null;

      const src = useDocStore.getState().doc?.content ?? "";
      const range = sourceRangeForSelection(src, fromLine, nextLine, text);
      const view = useDocStore.getState().cmRef.current;
      if (!range || !view) return;
      const max = view.state.doc.length;
      const from = Math.min(range[0], max);
      const to = Math.min(range[1], max);
      lockSplitSide("editor"); // 这次程序化滚动不该把预览也一路带下去
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: CmEditorView.scrollIntoView(from, { y: "center" }),
      });
      view.focus();
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);
}
