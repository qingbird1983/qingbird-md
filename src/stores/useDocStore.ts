// 文档域：当前文档、视图/阅读模式、脏标记、选区、解析缓存。
// htmlCache 为单槽 { contentKey, result }——只服务当前内容，保证 ensureParsed 幂等；
// parseResult 与之原子联动，供 OutlinePanel / Preview 单一来源消费（plan Task 19 修正接口）。
import { create } from "zustand";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { DocDTO, Mode, ParseResult, ViewKind } from "../types/ipc";
import { api, byteToCharOffset, charToByteOffset } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
// 环引用仅存在于 action 体内（getState 调用不发生在模块求值期）——plan 明确允许的边
import { useTranslationStore } from "./useTranslationStore";

interface DocState {
  doc: DocDTO | null;
  view: ViewKind;
  mode: Mode;
  cursorSel: [number, number];
  isDirty: boolean;
  savedContent: string; // 供 isDirty 比较
  translations: Map<number, string>; // 翻译完成后按段下标写入（translation-done）
  // translation-done payload 附带的译文形态 html 单槽（Task 23）：contentKey = 发起批次时的
  // doc.content，mode = 批次模式。PreviewView 在匹配的阅读模式下零延迟直用，否则回退 parseResult。
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  parseResult: ParseResult | null;
  // 单槽缓存：key = 产出 result 时的完整 content；与 parseResult 永远同一次 set 内联动更新
  htmlCache: { contentKey: string; result: ParseResult } | null;
  /** CM 实例句柄（非响应式）：EditorView 挂载/卸载时写入/清空，供工具栏撤销/重做桥接（Task 22）。 */
  cmRef: { current: EditorView | null };

  openDoc(path: string): Promise<void>;
  /** 启动期 document-changed 监听注册处：首开文件参数与第二实例 handoff 都经该事件流入。只挂一次。 */
  openDocFromArgs(): void;
  /** 工具栏撤销/重做（CodeMirror 命令）；编辑器未挂载时 no-op。 */
  dispatchUndo(): void;
  dispatchRedo(): void;
  setContent(c: string): void;
  setCursorSel(s: [number, number]): void;
  applyFormat(op: string): Promise<void>;
  saveDoc(as: boolean): Promise<void>;
  switchView(v: ViewKind): void;
  switchMode(m: Mode): void;
  /** 内容未变即直接复用缓存；变了重新解析。幂等。 */
  ensureParsed(): Promise<void>;
}

function pathParts(p: string) {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return { name: i >= 0 ? p.slice(i + 1) : p, dir: i >= 0 ? p.slice(0, i) : null };
}

// 应用生命周期持有；“只挂一次”闩
// 同步哨兵防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let docChangedRegistered = false;

export const useDocStore = create<DocState>()((set, get) => ({
  doc: null,
  view: "split",
  mode: "original",
  cursorSel: [0, 0],
  isDirty: false,
  savedContent: "",
  translations: new Map(),
  doneHtml: null,
  parseResult: null,
  htmlCache: null,
  cmRef: { current: null },

  dispatchUndo: () => {
    const v = get().cmRef.current;
    if (v) undo(v);
  },
  dispatchRedo: () => {
    const v = get().cmRef.current;
    if (v) redo(v);
  },

  openDoc: async (path) => {
    try {
      const d = await api.openFile(path);
      set({
        doc: d,
        savedContent: d.content,
        isDirty: false,
        cursorSel: [0, 0],
        translations: new Map(), // 新文档段落索引全变，旧译文一律作废
        doneHtml: null, // payload html 属于旧文档内容，一并作废
        parseResult: null,
        htmlCache: null,
      });
    } catch (e) {
      useUiStore.getState().addToast("error", `打开失败：${errText(e)}`);
    }
  },

  openDocFromArgs: () => {
    if (docChangedRegistered) return;
    docChangedRegistered = true;
    void api.listenDocumentChanged((p) =>
      useDocStore.getState().openDoc(p),
    );
  },

  setContent: (c) => {
    const d = get().doc;
    if (!d || d.content === c) return;
    set({ doc: { ...d, content: c }, isDirty: c !== get().savedContent });
  },

  setCursorSel: (s) => set({ cursorSel: s }),

  applyFormat: async (op) => {
    const d = get().doc;
    if (!d) return;
    const [c0, c1] = get().cursorSel;
    try {
      // 偏移口径桥（types/ipc.ts EditOp 契约）：store.cursorSel 是 CM code unit
      // 偏移，Rust apply_op 需要 UTF-8 字节偏移；返回的 sel 同样转回 code unit。
      const r = await api.applyOp({
        content: d.content,
        sel: [charToByteOffset(d.content, c0), charToByteOffset(d.content, c1)],
        op,
      });
      if (get().doc !== d) {
        // await 期间用户已编辑/切换文档 ⇒ 结果基于陈旧内容，应用会吞掉新输入
        useUiStore.getState().addToast("info", "文档已变化，本次格式化已取消");
        return;
      }
      set({
        doc: { ...d, content: r.content },
        cursorSel: [
          byteToCharOffset(r.content, r.sel[0]),
          byteToCharOffset(r.content, r.sel[1]),
        ],
        isDirty: r.content !== get().savedContent,
      });
    } catch (e) {
      useUiStore.getState().addToast("error", `编辑操作失败：${errText(e)}`);
    }
  },

  saveDoc: async (as) => {
    const d = get().doc;
    if (!d) return;
    let target = d.path;
    if (!target || as) {
      target = await api.pickSavePath(d.name);
      if (!target) return; // 用户取消
    }
    try {
      await api.saveFile(target, d.content);
      const { name, dir } = pathParts(target);
      set({
        doc: { ...d, path: target, name, base_dir: dir },
        savedContent: d.content,
        isDirty: false,
      });
      useUiStore.getState().addToast("success", "保存成功");
    } catch (e) {
      useUiStore.getState().addToast("error", `保存失败：${errText(e)}`);
    }
  },

  switchView: (v) => set({ view: v }),

  switchMode: (m) => {
    if (get().mode === m) return;
    set({ mode: m });
    if (m === "original") {
      set({ translations: new Map() }); // 回原文不留译文态
    } else {
      // plan Task 23 预留的收尾逻辑：进入翻译类模式时按需启动/续跑
      useTranslationStore.getState().startIfFresh();
    }
  },

  ensureParsed: async () => {
    const d = get().doc;
    if (!d) return;
    if (get().htmlCache?.contentKey === d.content) return; // 幂等命中
    const key = d.content; // 捕获当前内容：快速换档时防止旧 parse 乱序覆盖新文档
    try {
      const r = await api.parse(key);
      // await 期间文档可能已切换/关闭：内容不再是 key ⇒ 过期结果直接丢弃
      if (get().doc?.content !== key) return;
      set({ parseResult: r, htmlCache: { contentKey: key, result: r } });
    } catch (e) {
      useUiStore.getState().addToast("error", `解析失败：${errText(e)}`);
    }
  },
}));
