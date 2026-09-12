// 编辑器插入动作（源码视图 / 预览区右键菜单共用）。
//
// 之前这些模板（mermaid / 公式）内联在 EditorToolbar 里；右键菜单也要用，
// 故抽到此处单一实现，避免两份逻辑漂移。
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";

/** 在当前光标处插入模板文本；caretOffset 为插入后光标相对插入起点的偏移。 */
export function insertSnippet(template: string, caretOffset = 0): boolean {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return false;
  const from = v.state.selection.main.from;
  v.dispatch({
    changes: { from, insert: template },
    selection: { anchor: from + caretOffset },
  });
  v.focus();
  return true;
}

/** mermaid 围栏（光标落在中间空行开头）。 */
export function insertMermaid(): boolean {
  return insertSnippet("\n```mermaid\n\n```\n", "\n```mermaid\n".length);
}

/** 公式：有选区则包成 `$选区$`，否则插入 `$$` 且光标居中。 */
export function insertFormula(): boolean {
  const v = useDocStore.getState().cmRef.current;
  if (!v) return false;
  const { from, to } = v.state.selection.main;
  const sel = v.state.sliceDoc(from, to);
  if (sel) {
    v.dispatch({ changes: { from, to, insert: `$${sel}$` }, selection: { anchor: from + sel.length + 1 } });
  } else {
    v.dispatch({ changes: { from, insert: "$$" }, selection: { anchor: from + 1 } });
  }
  v.focus();
  return true;
}

/**
 * 预览区右键的「插入」：预览里没有编辑器实例，插入必须落到源码视图的光标处。
 * 当前若是预览视图，先切到源码、等 EditorView 挂载完成再执行动作，
 * 否则 cmRef 为空会静默失败。
 */
export async function insertFromPreview(run: () => boolean, label: string): Promise<void> {
  const doc = useDocStore.getState();
  if (!doc.doc) return;
  if (!doc.cmRef.current) {
    doc.switchView("source");
    // EditorView 挂载 + 光标恢复在下一帧之后完成；40ms 足够且无感
    await new Promise((r) => setTimeout(r, 40));
  }
  if (run()) useUiStore.getState().addToast("success", `已插入${label}`);
  else useUiStore.getState().addToast("info", "插入失败：编辑器未就绪");
}
