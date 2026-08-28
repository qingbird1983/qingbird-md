// 编辑器主视图（Task 21）：CodeMirror 6 源码编辑器。
//
// 双向同步（无回环关键 = 等值短路）：
//   editor → store：updateListener 把 docChanged 的内容与选区合成一次 setState
//     推给 docStore（原子更新——App 的划词订阅方拿到一致的内容+选区快照）；
//     仅 selection 变化走 setCursorSel。
//   store → editor：subscribe 对比 store 内容与视图内容——编辑器自身推送恒等值
//     被短路；只有外部变更（openTab 换文档 / applyFormat 全文替换）才走一次
//     全量 replaceRange + selection 回填（CM 口径，applyFormat 已把字节转回
//     字符）+ scrollIntoView(center)。
//
// 偏移口径：CM 位置 = UTF-16 code unit；Rust apply_op.sel = UTF-8 字节。
// 换算函数在 lib/ipc.ts，useDocStore.applyFormat 完成出入双向转换，本组件
// 只处理 CM 口径。
//
// IME 安全：store 推送从不反向 dispatch 回 CM（等值短路），组合输入期间
// 不会被 replaceRange 打断。
import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView as CmEditorView, keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { minimalSetup } from "codemirror";
import { math } from "codemirror-lang-math";
import { useDocStore } from "../stores/useDocStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";

// ```math 围栏代码块高亮（codemirror-lang-math 0.1.8，无 @replit scope）
const mathLang = LanguageDescription.of({
  name: "math",
  load: async () => math(),
});

// 主题经 compartment 运行时重配（亮/暗切换不重建 View）；
// language 恒为 markdown（应用生命周期内不变），无需第二个 compartment。
const themeComp = new Compartment();

export default function EditorView() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = new CmEditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: useDocStore.getState().doc?.content ?? "",
        extensions: [
          minimalSetup, // 已含 default/history keymap 与 undo history
          markdown({ codeLanguages: [mathLang, ...languages] }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void useDocStore.getState().saveDoc(false); return true; } },
            { key: "Mod-b", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("bold"); return true; } },
            { key: "Mod-i", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("italic"); return true; } },
          ]),
          CmEditorView.lineWrapping, // markdown 源码软换行，与预览排版一致
          themeComp.of(isDarkTheme() ? oneDark : []),
          CmEditorView.updateListener.of((u) => {
            if (!u.docChanged && !u.selectionSet) return;
            const { from, to } = u.state.selection.main;
            const st = useDocStore.getState();
            if (!u.docChanged) {
              st.setCursorSel([from, to]);
              return;
            }
            const content = u.state.doc.toString();
            const t = st.tabs.find((x) => x.id === st.activeId);
            if (t && t.content !== content) {
              // 内容+选区原子写入 active tab（applyEdit 同步重算派生投影）：
              // App 划词订阅方拿到原子快照
              st.applyEdit(content, [from, to]);
            } else {
              st.setCursorSel([from, to]);
            }
          }),
        ],
      }),
    });

    // 工具栏撤销/重做桥接（Task 22）：实例句柄挂到 docStore，卸载时清空
    useDocStore.getState().cmRef.current = view;

    // store → editor：外部内容变更（openTab/applyFormat）全量替换 + 光标回填 +
    // 居中滚动；选区钳制到新文档长度（Rust clamp_sel 同款语义）。
    const unsubDoc = useDocStore.subscribe((s) => {
      const content = s.doc?.content;
      if (content === undefined || view.state.doc.toString() === content) return;
      const len = view.state.doc.length;
      const clamp = (p: number) => Math.max(0, Math.min(p, len));
      const [f, t] = s.cursorSel;
      const anchor = clamp(f);
      view.dispatch({
        changes: { from: 0, to: len, insert: content },
        selection: { anchor, head: clamp(t) },
        effects: CmEditorView.scrollIntoView(anchor, { y: "center" }),
      });
    });

    // 主题 compartment：settings.theme 或系统明暗变化时重配
    let lastDark = isDarkTheme();
    const applyTheme = () => {
      const dark = isDarkTheme();
      if (dark === lastDark) return;
      lastDark = dark;
      view.dispatch({ effects: themeComp.reconfigure(dark ? oneDark : []) });
    };
    const unsubTheme = useSettingsStore.subscribe(applyTheme);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);

    return () => {
      useDocStore.getState().cmRef.current = null;
      mq.removeEventListener("change", applyTheme);
      unsubTheme();
      unsubDoc();
      view.destroy();
    };
  }, []);

  return <div className="editor-cm" ref={hostRef} />;
}
