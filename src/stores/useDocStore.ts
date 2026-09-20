// 文档域：标签集合 + 当前激活 id 的 zustand store（P2-8b 拆分后只留生命周期
// 与编辑/保存/翻译联动的动作编排）。类型 OpenTab/DocState、纯函数投影
//（tabToDoc/projection/commit）与集中写路径工厂 makePatchers（patchActive/
// patchTab）在 ./docTabs；会话快照恢复与启动装载在 ../lib/sessionRestore
//（restoreSession/openDocFromArgs 于此为薄壳）。公开 API 与导出面不变。
// 阅读模式真源、翻译联动等语义详见各动作内注释。
import { create } from "zustand";
import { undo, redo } from "@codemirror/commands";
import type { TargetLang } from "../types/ipc";
import { api, byteToCharOffset, charToByteOffset } from "../lib/ipc";
import { baseName } from "../lib/wsPath";
import { useUiStore, errText } from "./useUiStore";
import { useTranslationStore } from "./useTranslationStore";
import { useSettingsStore } from "./useSettingsStore";
import { useRecentStore } from "./useRecentStore";
import { makePatchers, projection, commit, activeTab, newId, type OpenTab, type DocState } from "./docTabs";
import {
  restoreSession as restoreSessionImpl,
  openDocFromArgs as openDocFromArgsImpl,
} from "../lib/sessionRestore";

// 防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let parseTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 当前翻译方向。**单源** = `useSettingsStore.target`（由 settings 派生）。
 *
 * 凡是「结果要落进某个索引空间」的调用（open_file / parse_markdown /
 * translate_document / render_translated）都必须经由此函数取方向——四处传的
 * 必须是同一个值，任一处不同就会让占号与收集对不上。
 */
const currentTarget = (): TargetLang => useSettingsStore.getState().target;

export const useDocStore = create<DocState>()((set, get) => {
  // —— 派生投影集合（一个辅助函数，actions 用它一次写完 tab 与投影）——
  const { patchActive, patchTab } = makePatchers(set, get);

  /**
   * 按当前方向重解析指定 tab 的 markdown，落地 parseResult + htmlCache。
   *
   * 与 `ensureParsed` 共用同一段逻辑，差别只在**是否去抖**：编辑期连续重解析
   * 要走 150ms 去抖（ensureParsed），而切方向必须**立刻且等它落地**——
   * 流式 partial 是按 `data-bi` 往 DOM 里贴的（lib/patchPartial.ts），基础 html
   * 若还停在旧方向的编号上，那几秒的译文就会贴到别的块。
   *
   * 三道过期护栏：tab 被关、内容被改、方向又被切走 —— 任一命中即丢弃结果。
   */
  async function reparseTab(id: string, target: TargetLang): Promise<void> {
    const t0 = get().tabs.find((x) => x.id === id);
    if (!t0) return;
    const key = t0.content;
    try {
      const r = await api.parse(key, target);
      const cur = get().tabs.find((x) => x.id === id);
      if (!cur || cur.content !== key) return;
      if (cur.htmlCache?.contentKey === key && cur.htmlCache.target === target) return;
      patchTab(id, (c) => ({
        ...c,
        parseResult: r,
        htmlCache: { contentKey: key, target, result: r },
      }));
    } catch (e) {
      useUiStore.getState().addToast("error", `解析失败：${errText(e)}`);
    }
  }

  return {
    tabs: [],
    activeId: null,
    cmRef: { current: null },
    ...projection([], null),

    // —— 动作 ——
    openTab: async (path) => {
      const existing = get().tabs.find((t) => t.path === path);
      if (existing) {
        get().switchTab(existing.id);
        return;
      }
      // 打开时就按当前方向首渲：parse 里的 data-bi 占号要跟随后续翻译的同方向。
      const target = currentTarget();
      try {
        const d = await api.openFile(path, target);
        const tab: OpenTab = {
          id: newId(),
          path,
          name: d.name,
          content: d.content,
          savedContent: d.content,
          mtime: d.mtime,
          encoding: d.encoding,
          view: "preview",
          mode: "original",
          cursorSel: [0, 0],
          scrollTop: 0,
          translations: new Map(),
          doneHtml: null,
          parseResult: d.parse,
          htmlCache: { contentKey: d.content, target, result: d.parse },
        };
        set((s) => commit([...s.tabs, tab], tab.id));
        // 最近打开文档登记：这里是所有「按路径打开」的唯一漏斗，记在这儿才不漏
        // （树点击 / Ctrl+O / 命令面板 / 文件关联 / 休眠交接 / 欢迎页 / 菜单）。
        useRecentStore.getState().push(path, d.name);
      } catch (e) {
        useUiStore.getState().addToast("error", `打开失败：${errText(e)}`);
      }
    },

    newTab: () => {
      const tab: OpenTab = {
        id: newId(),
        path: null,
        name: "未命名",
        content: "",
        savedContent: "",
        mtime: null,
        encoding: null,
        view: "source",
        mode: "original",
        cursorSel: [0, 0],
        scrollTop: 0,
        translations: new Map(),
        doneHtml: null,
        parseResult: null,
        htmlCache: null,
      };
      set((s) => commit([...s.tabs, tab], tab.id));
    },

    openExampleTab: (name, content) => {
      // 去重：示例只会有一份，重复点按钮应当切过去而不是叠出第二个标签
      // （与 openTab 对同一路径的处理同口径）。
      const existing = get().tabs.find((t) => t.path === null && t.name === name);
      if (existing) {
        get().switchTab(existing.id);
        return;
      }
      const tab: OpenTab = {
        id: newId(),
        path: null,
        name,
        content,
        // savedContent 与内容等值 ⇒ **不标脏**：用户不动它，关标签时不会被追问
        // 保存；动过之后照常进脏态，Ctrl+S 因 path 为空自然走「另存为」。
        savedContent: content,
        mtime: null,
        encoding: null,
        // 预览态：示例是用来「看」的（渲染、公式、图表一屏尽收），要改再切源码。
        view: "preview",
        mode: "original",
        cursorSel: [0, 0],
        scrollTop: 0,
        translations: new Map(),
        doneHtml: null,
        parseResult: null,
        htmlCache: null,
      };
      set((s) => commit([...s.tabs, tab], tab.id));
    },

    closeTab: async (id) => {
      const t = get().tabs.find((x) => x.id === id);
      if (!t) return;
      const dirty = t.content !== t.savedContent;
      if (dirty) {
        // 弹出 DirtyConfirmDialog；动态 import 避免循环依赖（dialog 读 useDocStore）
        const { showDirtyConfirm } = await import("../components/DirtyConfirmDialog");
        const choice = await showDirtyConfirm(t.name);
        if (choice === "cancel") return;
        if (choice === "save") {
          // 先切到该标签，再保存——saveDoc 永远作用于 active tab
          get().switchTab(id);
          const ok = await get().saveDoc(false);
          if (!ok) return; // 用户在另存为里取消，中止关闭
        }
      }
      // 真实删除 + 邻居切换
      set((s) => {
        const idx = s.tabs.findIndex((x) => x.id === id);
        if (idx < 0) return {};
        const tabs = s.tabs.filter((x) => x.id !== id);
        let activeId = s.activeId;
        if (s.activeId === id) {
          activeId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
        }
        return commit(tabs, activeId);
      });
    },

    /** 放弃未保存改动（BUG-6 收口）：savedContent 对齐 content。走 patchTab
     *  集中写路径，isDirty 投影在同一次 set 内重算——工作区删除脏文件曾直接
     *  setState 只改真源，脏标停留到下一次任意写动作才自愈。 */
    discardChanges: (id) => {
      patchTab(id, (t) => ({ ...t, savedContent: t.content }));
    },

    switchTab: (id) => {
      if (get().activeId === id) return;
      set((s) => commit(s.tabs, id));
    },

    openDocFromArgs: async () => {
      await openDocFromArgsImpl();
    },

    restoreSession: async () => {
      await restoreSessionImpl({ get, set, patchTab });
    },

    dispatchUndo: () => {
      const v = get().cmRef.current;
      if (v) undo(v);
    },
    dispatchRedo: () => {
      const v = get().cmRef.current;
      if (v) redo(v);
    },

    setCursorSel: (s) => {
      patchActive((t) => ({ ...t, cursorSel: s }));
    },

    applyEdit: (content, cursorSel) => {
      useTranslationStore.getState().resetDisplayIfStale(content);
      patchActive((t) => ({ ...t, content, cursorSel }));
    },

    setScrollTop: (id, n) => {
      patchTab(id, (t) => (t.scrollTop === n ? t : { ...t, scrollTop: n }));
    },

    // 磁盘重命名/移动后同步标签（路径 + 显示名）；内容与撤销栈保持不动，
    // 否则保存会把内容写回已失效的旧路径。
    retargetPath: (oldPath, newPath) => {
      set((s) => {
        if (!s.tabs.some((t) => t.path === oldPath)) return {};
        const name = baseName(newPath);
        const tabs = s.tabs.map((t) => (t.path === oldPath ? { ...t, path: newPath, name } : t));
        return commit(tabs, s.activeId);
      });
    },

    applyFormat: async (op) => {
      const t = activeTab(get());
      if (!t) return;
      const [c0, c1] = t.cursorSel;
      try {
        const r = await api.applyOp({
          content: t.content,
          sel: [charToByteOffset(t.content, c0), charToByteOffset(t.content, c1)],
          op,
        });
        // 三向陈旧守卫：activeId 变了（切走）/ tab 已被关（id 不再）/ 内容被改（打字）
        // 任何一项命中都说明 r 是基于陈旧内容的结果，跳过覆盖。
        const cur = activeTab(get());
        if (!cur || cur.id !== t.id || cur.content !== t.content) {
          useUiStore.getState().addToast("info", "文档已变化，本次格式化已取消");
          return;
        }
        patchActive((cur2) => ({
          ...cur2,
          content: r.content,
          cursorSel: [
            byteToCharOffset(r.content, r.sel[0]),
            byteToCharOffset(r.content, r.sel[1]),
          ],
        }));
      } catch (e) {
        useUiStore.getState().addToast("error", `编辑操作失败：${errText(e)}`);
      }
    },

    saveDoc: async (as) => {
      const t = activeTab(get());
      if (!t) return false;
      const myId = t.id; // 锁定目标 tab id
      let target = t.path;
      if (!target || as) {
        target = await api.pickSavePath(t.name);
        if (!target) return false; // 用户取消另存为
      } else {
        // T8 冲突检测：磁盘 mtime 与打开时基线不一致 → 覆盖/另存/取消。
        // 基线缺失（mtime=null）或文件已消失（disk=null，保存即重建）时跳过。
        const disk = await api.fileMtime(target);
        if (disk !== null && t.mtime !== null && disk !== t.mtime) {
          const { showConflict } = await import("../components/ConflictDialog");
          const choice = await showConflict(t.name);
          if (choice === "cancel") return false;
          if (choice === "saveas") {
            const alt = await api.pickSavePath(t.name);
            if (!alt) return false;
            target = alt;
          }
          // overwrite → 继续按原路径落盘
        }
      }
      try {
        const mtime = await api.saveFile(target, t.content);
        const name = baseName(target);
        // 按 id 写：await 期间 active tab 可能已切走（如 closeTab 的 save-then-close），
        // 内容也可能已变（用户在写盘往返期间继续输入）。基线必须取**写盘的那份
        // 快照 t.content**——写 cur.content 会让这段领先于磁盘的编辑被错误地
        // 记为已保存（isDirty 变 false → 关标签不弹确认 → 静默丢改动）。
        patchTab(myId, (cur) => ({
          ...cur,
          path: target!,
          name,
          savedContent: t.content,
          mtime, // 新基线：下次冲突检测以此为准
        }));
        useUiStore.getState().addToast("success", "保存成功");
        return true;
      } catch (e) {
        useUiStore.getState().addToast("error", `保存失败：${errText(e)}`);
        return false;
      }
    },

    reloadTab: async (id) => {
      const t = get().tabs.find((x) => x.id === id);
      if (!t?.path) return;
      const target = currentTarget();
      try {
        const d = await api.openFile(t.path, target);
        // 按 id 写：await 期间 active 可能已切走。视图/模式/滚动保留（用户语境），
        // 内容、解析、翻译态、光标全量重置（翻译按行号索引，旧内容下已失效）。
        patchTab(id, (cur) => ({
          ...cur,
          name: d.name,
          content: d.content,
          savedContent: d.content,
          mtime: d.mtime,
          encoding: d.encoding,
          parseResult: d.parse,
          htmlCache: { contentKey: d.content, target, result: d.parse },
          translations: new Map(),
          doneHtml: null,
          cursorSel: [0, 0],
        }));
      } catch (e) {
        useUiStore.getState().addToast("error", `重新加载失败：${errText(e)}`);
      }
    },

    checkExternalChange: async () => {
      const t = activeTab(get());
      if (!t?.path || t.mtime === null) return; // 新标签/基线缺失：无从比对
      const disk = await api.fileMtime(t.path);
      if (disk === null || disk === t.mtime) return; // 文件消失或未变
      const { showReloadConfirm } = await import("../components/ReloadDialog");
      const choice = await showReloadConfirm(t.name, t.content !== t.savedContent);
      if (choice === "reload") {
        void get().reloadTab(t.id);
      } else {
        // 保留我的版本：记下磁盘 mtime 作为新基线——用户已知情并选择保留，
        // 之后保存不再重复弹冲突（一次外部修改只打扰一次）。
        patchTab(t.id, (cur) => ({ ...cur, mtime: disk }));
      }
    },

    switchView: (v) => {
      patchActive((t) => ({ ...t, view: v }));
    },

    switchMode: (m) => {
      const t = activeTab(get());
      if (!t || t.mode === m) return;
      useTranslationStore.getState().resetDisplay(); // 旧模式显示/流全部作废（索引空间变）
      patchActive((cur) => ({
        ...cur,
        mode: m,
        // （终审 I3）任意模式切换都清表：translation 的键是 run 空间（data-ri）、
        // bilingual 是块空间（data-bi），跨模式混表会让另一空间的旧键在
        // render_translated 里错位到错误块/文本框。缓存使重译廉价，宁缺勿错。
        translations: new Map(),
      }));
      if (m !== "original") useTranslationStore.getState().startIfFresh();
    },

    setTranslateTarget: async (t) => {
      const cur = activeTab(get());
      const split = useTranslationStore.getState();
      if (!cur) {
        // 无文档：只有偏好要落，没有索引空间要重置。
        useSettingsStore.getState().setTarget(t);
        return;
      }
      if (useSettingsStore.getState().target === t) return;
      // 1) 偏好先落（乐观更新是同步的）——下面的重解析与起跑都从 settings 取方向。
      useSettingsStore.getState().setTarget(t);
      // 2) **与 switchMode 同级的一次索引空间变更**（H2 红线）：`data-bi` 的
      //    占号由方向决定，所以旧显示、旧打字流、旧译文表、旧 doneHtml 全部作废。
      //    resetDisplay 会 gen 前跳并通知后端取消在途 run——迟到的事件自然失配丢弃。
      split.resetDisplay();
      patchActive((c) => ({ ...c, translations: new Map(), doneHtml: null }));
      // 3) 基础 html 按新方向重解析，并**等它落地**（理由见 reparseTab 注释）。
      //    顺带让后端有一点时间把上一轮 run 收干净，降低"已有翻译在进行"的撞车概率。
      await reparseTab(cur.id, t);
      // 4) 阅读模式下重跑（resetDisplay 已把 gen 前跳、译文表已清 ⇒ startIfFresh
      //    必然判 fresh，除非用户此刻已切到原文模式）。
      if (activeTab(get())?.mode !== "original") useTranslationStore.getState().startIfFresh();
    },

    ensureParsed: () => {
      const t = activeTab(get());
      if (!t) return;
      // 方向也要比：同一份内容在 zh / en 下是不同的 html（data-bi 占号不同）。
      if (t.htmlCache?.contentKey === t.content && t.htmlCache.target === currentTarget()) return;
      clearTimeout(parseTimer);
      const myId = t.id;
      parseTimer = setTimeout(() => void reparseTab(myId, currentTarget()), 150);
    },

    applyTranslationResult: (translations, doneHtml) => {
      patchActive((t) => ({ ...t, translations, doneHtml }));
    },

    mergeTranslations: (pairs) => {
      if (pairs.length === 0) return;
      patchActive((t) => {
        const merged = new Map(t.translations);
        for (const [i, v] of pairs) merged.set(i, v);
        return { ...t, translations: merged };
      });
    },

    clearTranslations: () => {
      // （终审 I2）最小面入口：只动 translations 一个字段，走既有 patchActive
      // 通道（投影同次 set 重算）。已空时原对象透传——避免空表清空也换 Map
      // 身份触发无谓重渲。
      patchActive((t) => (t.translations.size === 0 ? t : { ...t, translations: new Map() }));
    },
  };
});
