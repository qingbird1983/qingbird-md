// 全部快捷键的唯一真源（2026-09-14 建立）。
//
// 为什么要有这张表：改造前快捷键散在三处——App.tsx 里写死的 switch
// （Ctrl+O/S/E/B/I/\ …）、设置页里写死的四个录制项、以及右键菜单里写死的
// shortcut 文案。加一个快捷键要改三处，漏一处就「菜单上写着、实际按不出」。
// 现在统一成：**表驱动**——表里加一行，设置页自动多一行可录制项，
// App.tsx 自动按它匹配（settings.hotkeys 里有同名键就用用户录的值，
// 没有就用表里的默认值）。
//
// 与 Rust 的边界：`scope === "mode"` 与 `global` 的项会被 Rust 侧
// src-tauri/src/hotkeys.rs 注册成**系统级**热键（程序未聚焦也生效），
// 因此这几个 id 必须与那边的 MODES 逐字对齐；其余（app 作用域）只在
// 应用内匹配，Rust 不认识也不需要认识。
//
// 默认值有两处副本（这里 + Rust storage.rs 的 Default/补缺逻辑），
// 由 src/lib/hotkeyRegistry.test.ts 读 Rust 源码逐条比对钉住，改一处漏另一处会红。

export type HotkeyGroup = "mode" | "file" | "view" | "edit" | "system";

export interface HotkeyDef {
  /** settings.hotkeys 的键名；mode/system 组的必须与 Rust hotkeys.rs 对齐 */
  id: string;
  /** 设置页里左对齐显示的名称 */
  label: string;
  /** 出厂默认组合键；"" = 出厂无默认（现在的表里没有这种） */
  def: string;
  group: HotkeyGroup;
  /**
   * 系统级注册（未聚焦也生效）。只有 capture 是全局的：
   * 截图翻译要在别的窗口里也能按下，其余都是应用内语义。
   */
  global?: boolean;
}

/** 设置页的分组标题与顺序 */
export const HOTKEY_GROUPS: Array<[HotkeyGroup, string]> = [
  ["mode", "阅读与翻译"],
  ["file", "文件"],
  ["view", "视图"],
  ["edit", "编辑"],
  ["system", "系统级"],
];

/**
 * 需要 App.tsx 提供「按下去做什么」的 id（模式组与系统级除外：
 * 模式组在 App.tsx 里统一走 switchMode，capture 由 Rust 触发截图）。
 *
 * 单独列一份的理由：App.tsx 的 APP_ACTIONS 以 `Record<AppHotkeyId, …>` 声明，
 * TS 于是**编译期**强制穷尽——注册表加了一项却忘了写执行体，`tsc` 直接报错，
 * 不会被 `?.()` 兜成「按了没反应」的静默故障。
 * 这份清单与 HOTKEYS 的一致性由 hotkeyRegistry.test.ts 双向比对钉住。
 */
export const APP_HOTKEY_IDS = [
  "open_file",
  "open_folder",
  "new_file",
  "save",
  "refresh_ws",
  "toggle_view",
  "split_view",
  "palette",
  "bold",
  "italic",
] as const;

export type AppHotkeyId = (typeof APP_HOTKEY_IDS)[number];

export const HOTKEYS: HotkeyDef[] = [
  // ── 阅读模式：全局注册，没聚焦到窗口也能换模式 ──
  { id: "original", label: "切换到原文", def: "Ctrl+Alt+1", group: "mode" },
  { id: "translation", label: "切换到译文", def: "Ctrl+Alt+2", group: "mode" },
  { id: "bilingual", label: "切换到中英对照", def: "Ctrl+Alt+3", group: "mode" },

  // ── 文件（App.tsx 内的应用级语义）──
  { id: "open_file", label: "打开文档", def: "Ctrl+O", group: "file" },
  { id: "open_folder", label: "打开文件夹", def: "Ctrl+Shift+O", group: "file" },
  { id: "new_file", label: "新建文件", def: "Ctrl+N", group: "file" },
  { id: "save", label: "保存文档", def: "Ctrl+S", group: "file" },
  { id: "refresh_ws", label: "刷新工作区", def: "F5", group: "file" },

  // ── 视图 ──
  { id: "toggle_view", label: "源码 ↔ 预览", def: "Ctrl+E", group: "view" },
  { id: "split_view", label: "分栏视图", def: "Ctrl+\\", group: "view" },
  { id: "palette", label: "命令面板", def: "Ctrl+Shift+P", group: "view" },

  // ── 编辑（编辑器聚焦时由 CodeMirror 先处理，这里兜底其余焦点）──
  { id: "bold", label: "加粗", def: "Ctrl+B", group: "edit" },
  { id: "italic", label: "斜体", def: "Ctrl+I", group: "edit" },

  // ── 系统级 ──
  {
    id: "capture",
    label: "截图翻译",
    def: "Ctrl+Shift+X",
    group: "system",
    global: true,
  },
];

/**
 * 控件自带、**不参与自定义**的键（只列出来给用户看，不进 settings.hotkeys）。
 * 这些是浏览器原生 / 组件内部的局部行为，改不了也不该改：
 * 文件树的行内键要跟「选中哪一行」绑定，预览区的复制/全选是浏览器默认语义，
 * 强行重绑只会让它们在该生效的地方失效。列出来是为了「一览表完整」。
 */
export const FIXED_HOTKEYS: Array<{ label: string; keys: string }> = [
  { label: "文件树：打开选中项", keys: "Enter" },
  { label: "文件树：重命名", keys: "F2" },
  { label: "文件树：删除到回收站", keys: "Del" },
  { label: "预览：复制选中内容", keys: "Ctrl+C" },
  { label: "预览：全选", keys: "Ctrl+A" },
];

const BY_ID = new Map(HOTKEYS.map((h) => [h.id, h]));

export function hotkeyDef(id: string): HotkeyDef | undefined {
  return BY_ID.get(id);
}

/**
 * 生效值：用户在 settings.hotkeys 里录过就用他的，没录过用表里的默认。
 * 显式空串 = 用户主动禁用（与 Rust capture 补缺逻辑同一约定：空串不补默认）。
 */
export function effectiveHotkeys(overrides: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of HOTKEYS) {
    const v = overrides?.[h.id];
    out[h.id] = v === undefined ? h.def : v;
  }
  return out;
}

/** 出厂默认表：点「恢复默认」就是把它整个写回 settings.hotkeys */
export function defaultHotkeys(): Record<string, string> {
  return Object.fromEntries(HOTKEYS.map((h) => [h.id, h.def]));
}

/**
 * 冲突检测：同一组合键被两个快捷键占用 → 两个 id 都进返回值。
 * 不做自动消解（用户可能正录到一半），只在界面上标红提醒——
 * 生效时按 HOTKEYS 表序先到先得。
 */
export function findConflicts(effective: Record<string, string>): Set<string> {
  const seen = new Map<string, string>();
  const bad = new Set<string>();
  for (const h of HOTKEYS) {
    const combo = effective[h.id];
    if (!combo) continue;
    const prev = seen.get(combo);
    if (prev) {
      bad.add(prev);
      bad.add(h.id);
    } else {
      seen.set(combo, h.id);
    }
  }
  return bad;
}
