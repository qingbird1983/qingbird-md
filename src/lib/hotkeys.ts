// T29 快捷键解析/匹配：把录制器产出的 "Ctrl+Alt+1" 形态串与 KeyboardEvent 判定。
// 与 Rust 侧全局注册（src-tauri/src/hotkeys.rs）消费同一批 settings.hotkeys 值，
// 两边对 Meta 的口径一致。
//
// Meta(Win) 显式拒绝：Win 键组合在 Windows 上被系统大量占用（单按弹开始
// 菜单、Win+E 被资源管理器截走），注册与应用内触发都不稳定、不可测；支持
// 面收窄到 Ctrl/Alt/Shift，与旧版 egui「须含 Ctrl/Alt/Shift」的可用集一致。
// 保存含 Meta 的录制值时 SettingsModal 会 toast 提示。
//
// 2026-09-14 扩表：原来只认 字母/数字/Space，于是 F5、Ctrl+\ 这类**已经在用**
// 的键录不进去，「所有快捷键都可自定义」就成了空话。现在补上 F1–F12 与常用
// 符号，并把「哪些键必须带修饰」的规则收成一处（[`allowsBare`]）：
//   · 字母/数字/Space —— 必须带修饰。裸字母会被 RegisterHotKey 当成系统级劫持，
//     应用内匹配也会抢走打字（与 Rust registrable 的约定一致）。
//   · F1–F12 与符号   —— 可以裸按。F5 刷新、`\` 分栏本来就没有修饰键。
// 录制器与解析器共用这张表，不再各写一套白名单。

export interface ComboParts {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

/** 键名 → KeyboardEvent.code（用物理键位，免键盘布局差异） */
const NAMED_CODES: Record<string, string> = {
  Space: "Space",
  "\\": "Backslash",
  "/": "Slash",
  ".": "Period",
  ",": "Comma",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
};

/** code → 键名（录制器用；与 NAMED_CODES 互为反函数） */
const NAMED_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(NAMED_CODES).map(([name, code]) => [code, name]),
);

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/**
 * 该键名是否允许「不带修改键」单独成快捷键。
 * 字母/数字/Space 一律不允许（会抢走正常打字，裸 Space 还会触发页面滚动）；
 * 功能键与符号允许——F5 刷新、`\` 分栏本来就没有修饰键。
 * 注意 Space 也在 NAMED_CODES 里（它要能解析成 code），所以这里单独排除。
 */
export function allowsBare(name: string): boolean {
  return FUNCTION_KEY.test(name) || (name in NAMED_CODES && name !== "Space");
}

/**
 * 从按键事件取键名；不在白名单（如 Esc、方向键、中文输入）返回 null。
 * 录制器与解析器共用——**这是「什么算一个键」的唯一判定**。
 */
export function keyName(e: {
  key?: string;
  code?: string;
}): string | null {
  const code = e.code ?? "";
  const key = e.key ?? "";
  // 优先按 code 判定：键盘布局无关，且 Shift+2 这种修饰后 key 变 " 的也认得出
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (FUNCTION_KEY.test(code)) return code;
  if (code in NAMED_KEYS) return NAMED_KEYS[code];
  // code 缺失的合成事件（测试/部分 IME）退回 key 判定
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (key === " ") return "Space";
  if (FUNCTION_KEY.test(key)) return key;
  return null;
}

/**
 * 解析录制串；含 Meta/未知修饰或键名不在白名单 → null（拒绝）。
 * `requireModifier`（默认 true）保留 T29「模式热键必须带修饰」的契约——
 * 那几个是 **系统级**注册，裸键会劫持整机；应用内快捷键（F5 等）传 false。
 */
export function parseCombo(combo: string, requireModifier = true): ComboParts | null {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const p: ComboParts = { ctrl: false, alt: false, shift: false, code: "" };
  for (const m of parts) {
    if (m === "Ctrl") p.ctrl = true;
    else if (m === "Alt") p.alt = true;
    else if (m === "Shift") p.shift = true;
    else return null; // Meta 或未知修饰 token：整体拒绝
  }
  const hasMod = p.ctrl || p.alt || p.shift;
  if (!hasMod && requireModifier) return null; // 录制器契约：须含修饰键
  if (!hasMod && !allowsBare(key)) return null; // 裸字母/数字照样拒绝
  // 键名 → 物理键位 e.code（免键盘布局差异，同 T28 palette 的取码口径）
  if (/^[A-Z]$/.test(key)) p.code = "Key" + key;
  else if (/^[0-9]$/.test(key)) p.code = "Digit" + key;
  else if (FUNCTION_KEY.test(key)) p.code = key; // F1–F12 的 code 就是自身
  else if (key in NAMED_CODES) p.code = NAMED_CODES[key];
  else return null;
  return p;
}

/**
 * 与 KeyboardEvent 精确匹配：修饰必须完全一致，防 "Alt+1" 误吞 "Ctrl+Alt+1"。
 * `requireModifier` 需与写入时同一取值，否则裸键项会永远匹配不上。
 */
export function comboMatches(
  e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
  combo: string,
  requireModifier = true,
): boolean {
  const p = parseCombo(combo, requireModifier);
  return !!p && p.ctrl === e.ctrlKey && p.alt === e.altKey && p.shift === e.shiftKey && p.code === e.code;
}
