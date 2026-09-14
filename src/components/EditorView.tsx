// 编辑器主视图（Task 21 + 多标签扩展）。
//
// 多标签扩展要点：
//   - mount 时把 cmRef 写到 store 顶层（顶层 cmRef 永远指向 active tab 的 CM）。
//   - mount 时从 active tab 读 scrollTop + cursorSel，恢复到 CM。
//   - 编辑产生的 cursorSel 变更走 setCursorSel（原行为不变）。
//   - 编辑产生的 content 变更走 applyEdit（在 store 里改 active tab.content 与
//     cursorSel 原子写入，触发 commit 联动重算投影）。
//   - scroll 事件节流落库 setScrollTop；切回本标签时由 MainArea 的 key 触发
//     卸载/重挂，新 mount 读取最新 scrollTop 恢复。
//
// ⚠️ 不要在本组件里 useDocStore.setState({ tabs: [...] })——会绕过 Task 1 的投影
// 模型导致 doc/isDirty/view 失真。所有写入一律走 store action。
//
// 单实例生命周期：MainArea.tsx 里 key={activeTabId ?? "empty"} 切标签时强制
// unmount/remount，杜绝跨标签 CM 状态污染。
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
import { emitSplitSync, splitSyncLocked, subscribeSplitSync } from "../lib/splitSync";

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
    // mount 时锁住 activeId 与对应 tab 的快照，避免后续异步回调跑错 tab。
    const st0 = useDocStore.getState();
    const t0 = st0.tabs.find((t) => t.id === st0.activeId);
    if (!t0) return;
    const myId = t0.id;

    const view = new CmEditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: t0.content,
        selection: { anchor: t0.cursorSel[0], head: t0.cursorSel[1] },
        extensions: [
          minimalSetup,
          markdown({ codeLanguages: [mathLang, ...languages] }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void useDocStore.getState().saveDoc(false); return true; } },
            { key: "Mod-b", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("bold"); return true; } },
            { key: "Mod-i", preventDefault: true, run: () => { void useDocStore.getState().applyFormat("italic"); return true; } },
          ]),
          CmEditorView.lineWrapping,
          themeComp.of(isDarkTheme() ? oneDark : []),
          CmEditorView.updateListener.of((u) => {
            if (!u.docChanged && !u.selectionSet) return;
            const cur = useDocStore.getState();
            const myTab = cur.tabs.find((t) => t.id === myId);
            if (!myTab) return; // tab 已被关闭
            const { from, to } = u.state.selection.main;
            if (!u.docChanged) {
              // 光标变更：等值短路后走 setCursorSel（→ patchActive → 投影重算）
              if (myTab.cursorSel[0] === from && myTab.cursorSel[1] === to) return;
              cur.setCursorSel([from, to]);
              return;
            }
            const content = u.state.doc.toString();
            if (myTab.content === content) return;
            // 内容 + 选区原子写入 active tab，走 applyEdit：App 划词订阅方拿到原子快照
            cur.applyEdit(content, [from, to]);
          }),
        ],
      }),
    });

    // 挂载后恢复滚动位置（CM 在 nextTick 才把 layout 出来，用 rAF 等一帧）
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = t0.scrollTop;
    });

    // store → editor：外部内容变更（openTab 新文档 / applyFormat 全文替换）
    // 全量替换 + 光标回填 + 居中滚动；选区钳制到新文档长度。
    const unsubDoc = useDocStore.subscribe((s) => {
      const tab = s.tabs.find((t) => t.id === myId);
      if (!tab) return;
      const content = tab.content;
      if (view.state.doc.toString() === content) return;
      const len = view.state.doc.length;
      const clamp = (p: number) => Math.max(0, Math.min(p, len));
      const [f, head] = tab.cursorSel;
      const anchor = clamp(f);
      view.dispatch({
        changes: { from: 0, to: len, insert: content },
        selection: { anchor, head: clamp(head) },
        effects: CmEditorView.scrollIntoView(anchor, { y: "center" }),
      });
    });

    // scroll 落库：节流 100ms，去重写。
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    let lastScroll = t0.scrollTop;
    const onScroll = () => {
      const top = view.scrollDOM.scrollTop;
      if (top === lastScroll) return;
      lastScroll = top;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        // 用 getState 读最新 store，避免闭包旧值；显式传 myId 写回本 tab
        useDocStore.getState().setScrollTop(myId, top);
      }, 100);
    };
    view.scrollDOM.addEventListener("scroll", onScroll);

    // ── 分栏同步（编辑器侧）──────────────────────────────────
    // 行号是两侧唯一的公共坐标（预览侧锚点来自 Rust 写的 <!--sl:N--> 注释，
    // 见 lib/splitSync.ts）。本侧负责两头：滚动时把「视口顶行」推给预览；
    // 收到预览的行号则把该行对齐到视口顶部。
    // 锁由 emitSplitSync/lockSplitSide 打在对侧——被程序化拖动的一侧不回报，
    // 否则两侧会互相推让滚不停。
    let lastEmittedLine = -1;
    let lastAppliedLine = -1;
    let syncRaf = 0;
    const emitLine = () => {
      // 非分栏视图没有对侧可同步（预览没挂载），单源码视图白算一趟
      if (useDocStore.getState().view !== "split") return;
      if (splitSyncLocked("editor")) return;
      const top = view.scrollDOM.scrollTop;
      // lineBlockAtHeight 的高度是**文档坐标系**（= 滚动容器 scrollTop），
      // 返回该高度的行块，取其起始位置再换行号。
      const line = view.state.doc.lineAt(view.lineBlockAtHeight(top).from).number;
      if (line === lastEmittedLine) return; // 同块只推一次，别每帧都惊动预览
      lastEmittedLine = line;
      // 本侧转为「主动方」：清掉被动跟随记录。那些位置是预览拖过来的，不代表
      // 本侧主动滚过这一行；不清的话用户随后手动滚回同一行会被去重吃掉。
      lastAppliedLine = -1;
      emitSplitSync("editor", line);
    };
    const onSyncScroll = () => {
      if (syncRaf) return;
      syncRaf = requestAnimationFrame(() => {
        syncRaf = 0;
        emitLine();
      });
    };
    view.scrollDOM.addEventListener("scroll", onSyncScroll, { passive: true });
    const unsubSync = subscribeSplitSync("editor", (line) => {
      if (line === lastAppliedLine) return;
      lastAppliedLine = line;
      // 本侧转为「被动方」：清掉主动上报记录（见 emitLine 的对称说明）
      lastEmittedLine = -1;
      const target = Math.max(1, Math.min(view.state.doc.lines, line));
      view.dispatch({
        effects: CmEditorView.scrollIntoView(view.state.doc.line(target).from, { y: "start" }),
      });
    });

    // 工具栏撤销/重做桥接：实例句柄挂到 docStore，卸载时清空
    useDocStore.getState().cmRef.current = view;

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
      // 卸载前同步落库最新滚动位置——防抖定时器会在“滚动后立即切标签”时
      // 被 clearTimeout 取消，尾巴上的 scrollTop 若不在此处 flush 就会丢失。
      if (lastScroll !== t0.scrollTop) {
        useDocStore.getState().setScrollTop(myId, lastScroll);
      }
      clearTimeout(scrollTimer);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.scrollDOM.removeEventListener("scroll", onSyncScroll);
      if (syncRaf) cancelAnimationFrame(syncRaf);
      unsubSync();
      useDocStore.getState().cmRef.current = null;
      mq.removeEventListener("change", applyTheme);
      unsubTheme();
      unsubDoc();
      view.destroy();
    };
  }, []);

  return <div className="editor-cm" ref={hostRef} />;
}
