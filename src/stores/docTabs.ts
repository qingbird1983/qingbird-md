// 文档域：标签集合 + 当前激活 id 的类型与纯函数/投影层（P2-8b 自 useDocStore
// 纯提取）。每标签独立持有内容、视图模式、阅读模式、光标、滚动、解析/翻译
// 缓存。doc/view/mode/cursorSel/isDirty/parseResult/htmlCache/doneHtml/
// translations 是 active tab 的派生投影，原始真源在对应 OpenTab 上——所有现存
// 的 s.doc / s.view / s.mode / s.cursorSel 订阅方零改动。
//
// 为什么是投影字段而不是 getter：zustand v5 的 setState 每次都用
// Object.assign({}, state, partial) 重建 state 对象，accessor getter 会被
// 求值成静态数据属性——第一次 setState 后 getter 全部冻结。因此改为
// commit() 辅助：所有写路径集中在 patchActive / commit，写 tabs/activeId
// 的同一 set 内同步重算投影，杜绝投影与真源脱节。
import type { DocDTO, Mode, ParseResult, TargetLang, ViewKind } from "../types/ipc";
import type { EditorView } from "@codemirror/view";

export interface OpenTab {
  id: string;                // crypto.randomUUID() 或 fallback，React key
  path: string | null;       // null = 未保存的新标签
  name: string;              // 显示名（path basename 或 "未命名"）
  content: string;
  savedContent: string;
  /** 打开/保存时的磁盘 mtime（毫秒）；外部修改检测与保存冲突检测基线 */
  mtime: number | null;
  /** 打开时实际解码编码（"UTF-8"/"GB18030"）；状态栏标注 */
  encoding: string | null;
  view: ViewKind;
  mode: Mode;
  cursorSel: [number, number];
  scrollTop: number;
  translations: Map<number, string>;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  parseResult: ParseResult | null;
  /**
   * 内容 → 解析结果的缓存。**方向也要进 key**（`target` 字段）：`data-bi`
   * 的占号随方向变，同一份内容在 zh / en 下是不同的 html。只比 contentKey
   * 会让切方向后沿用旧方向的 DOM 编号，而本轮翻译按新方向收集 → 流式译文
   * 贴错块（终态由 doneHtml 兜住，中途那几秒是错的）。
   */
  htmlCache: { contentKey: string; target: TargetLang; result: ParseResult } | null;
}

// 应用启动时检查 randomUUID 可用性；Tauri WebView2 是 Chromium 内核通常支持，
// 旧 WebView 才走 fallback。
let idCounter = 0;
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${++idCounter}`;
}

export interface DocState {
  tabs: OpenTab[];
  activeId: string | null;
  cmRef: { current: EditorView | null };

  // —— 派生投影（active tab 的即时快照，写路径集中在下方动作）——
  doc: DocDTO | null;
  view: ViewKind;
  mode: Mode;
  cursorSel: [number, number];
  isDirty: boolean;
  parseResult: ParseResult | null;
  htmlCache: { contentKey: string; target: TargetLang; result: ParseResult } | null;
  doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null;
  translations: Map<number, string>;

  // —— 动作 ——
  openTab(path: string): Promise<void>;
  newTab(): void;
  /**
   * 打开一份**内置内容**（欢迎页「打开示例文档」，内容来自 lib/demoDoc.ts）。
   * 没有 path：不在磁盘上留副本、不会被存回安装目录；同名标签已存在则切过去。
   */
  openExampleTab(name: string, content: string): void;
  closeTab(id: string): Promise<void>;
  /** 放弃指定标签的未保存改动：savedContent 对齐 content（工作区删除脏文件的
   *  「不保存」分支用）。必须走 patchTab 集中写路径——isDirty 投影与写入在
   *  同一次 set 内重算；跨 store 直接 setState 会漏掉这一步（BUG-6：脏标
   *  停留到下一次任意写动作才自愈）。 */
  discardChanges(id: string): void;
  switchTab(id: string): void;

  openDocFromArgs(): Promise<void>;
  /** 恢复上次休眠留下的会话快照；无快照 / 版本不符则静默回落冷启动。 */
  restoreSession(): Promise<void>;
  dispatchUndo(): void;
  dispatchRedo(): void;
  setCursorSel(s: [number, number]): void;
  /** 编辑器内容+选区原子写入 active tab（EditorView updateListener 用）。 */
  applyEdit(content: string, cursorSel: [number, number]): void;
  /** 滚动事件落库到指定 tab；切回本标签时恢复。 */
  setScrollTop(id: string, n: number): void;
  /** 磁盘重命名/移动后同步标签路径与显示名（内容/撤销栈不动）。 */
  retargetPath(oldPath: string, newPath: string): void;
  applyFormat(op: string): Promise<void>;
  saveDoc(as: boolean): Promise<boolean>;     // 返回值变了：true=写盘成功，false=用户取消
  /** 从磁盘重读指定标签（T6「重新加载」）：内容/解析/翻译态全量重置。 */
  reloadTab(id: string): Promise<void>;
  /** 窗口聚焦时检查当前文档是否被外部修改（T6）：变了则弹重载确认。 */
  checkExternalChange(): Promise<void>;
  switchView(v: ViewKind): void;
  switchMode(m: Mode): void;
  /**
   * 切换翻译方向（中 ⇄ 英）。**与 switchMode 同级的一次索引空间变更**：
   * 落偏好 + `resetDisplay()` + 清 `translations` + 清 `doneHtml` + 按新方向
   * 重解析基础 html，最后在阅读模式下重跑。UI 必须走这个动作，不要直接调
   * `useSettingsStore.setTarget`（那会漏掉整套 reset）。
   */
  setTranslateTarget(t: TargetLang): Promise<void>;
  ensureParsed(): void;

  /** 翻译完成回写入口（useTranslationStore 调用），写入当前激活标签。 */
  applyTranslationResult(
    translations: Map<number, string>,
    doneHtml: { contentKey: string; mode: Exclude<Mode, "original">; html: string } | null,
  ): void;
  /** 窗口化 run 的增量合并：pairs 并入当前累积表（不整表 replace）。 */
  mergeTranslations(pairs: Array<[number, string]>): void;
  /** 内容与上轮 run 不符时整表作废 active tab 的 translations（终审 I2，
   * resetDisplayIfStale 调用；已空时不动，避免无谓的 Map 身份变更）。 */
  clearTranslations(): void;
}

/**
 * doc.base_dir：路径的父目录。与 wsPath.dirName 的两处语义差异是有意的——
 * 无分隔符（裸文件名）返 null 而非原样返回；盘根不做 "C:\foo"→"C:\" 特判
 * （保持 "C:"）。base_dir 只作后端 resolve 的 join 基准，维持原 pathParts
 * 行为避免无谓的入参变化；文件名半径已统一走 wsPath.baseName（P2-3）。
 */
function baseDirOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : null;
}

export function activeTab(state: { tabs: OpenTab[]; activeId: string | null }): OpenTab | null {
  return state.activeId ? state.tabs.find((t) => t.id === state.activeId) ?? null : null;
}

/** 构造一份 DocDTO 形态的快照给派生投影用。 */
function tabToDoc(t: OpenTab): DocDTO {
  return {
    name: t.name,
    path: t.path,
    base_dir: t.path ? baseDirOf(t.path) : null,
    content: t.content,
    char_count: [...t.content].length,
    line_count: t.content.split("\n").length,
    encoding: t.encoding ?? "UTF-8",
    mtime: t.mtime,
    parse: t.parseResult ?? { html: "", outline: [] },
  };
}

/** active tab 的派生投影；与 tabs/activeId 在同一次 set 内联动写入。 */
export function projection(tabs: OpenTab[], activeId: string | null) {
  const t = activeId ? tabs.find((x) => x.id === activeId) ?? null : null;
  return {
    doc: t ? tabToDoc(t) : null,
    view: t?.view ?? "preview",
    mode: t?.mode ?? "original",
    cursorSel: t?.cursorSel ?? ([0, 0] as [number, number]),
    isDirty: !!t && t.content !== t.savedContent,
    parseResult: t?.parseResult ?? null,
    htmlCache: t?.htmlCache ?? null,
    doneHtml: t?.doneHtml ?? null,
    translations: t?.translations ?? new Map<number, string>(),
  };
}

/** 写 tabs/activeId 的唯一入口：同一次 set 内带上重算后的投影。 */
export function commit(tabs: OpenTab[], activeId: string | null) {
  return { tabs, activeId, ...projection(tabs, activeId) };
}

/** 集中写路径工厂：动作经 makePatchers(set, get) 取得两个写辅助（体为原
 *  useDocStore 工厂闭包逐字）。 */
export function makePatchers(
  set: (partial: Partial<DocState> | ((s: DocState) => Partial<DocState>)) => void,
  get: () => DocState,
) {
  function patchActive(mut: (t: OpenTab) => OpenTab): void {
    const s = get();
    if (!s.activeId) return;
    const idx = s.tabs.findIndex((t) => t.id === s.activeId);
    if (idx < 0) return;
    const tabs = [...s.tabs];
    tabs[idx] = mut(tabs[idx]);
    set(commit(tabs, s.activeId));
  }

  // 按 id 定位写入：用于跨 await 后 active tab 可能已变更的场景（滚动刷新、saveDoc）。
  // 仍走 commit()，投影在同一次 set 内重算，doc/isDirty/view 不脱节。
  function patchTab(id: string, mut: (t: OpenTab) => OpenTab): void {
    const s = get();
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return; // tab 已被关
    const tabs = [...s.tabs];
    tabs[idx] = mut(tabs[idx]);
    const nextActiveId = s.activeId;
    // 投影仍按当前 activeId 算（不变）。本写入不动 activeId。
    set({ tabs, ...projection(tabs, nextActiveId) });
  }

  return { patchActive, patchTab };
}
