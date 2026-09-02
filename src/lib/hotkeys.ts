// T29 快捷键解析/匹配：把录制器（SettingsModal keyName 白名单）产出的
// "Ctrl+Alt+1" 形态串与 KeyboardEvent 判定。与 Rust 侧全局注册（src-tauri/
// src/hotkeys.rs）消费同一批 settings.hotkeys 值，两边对 Meta 的口径一致。
//
// Meta(Win) 显式拒绝：Win 键组合在 Windows 上被系统大量占用（单按弹开始
// 菜单、Win+E 被资源管理器截走），注册与应用内触发都不稳定、不可测；支持
// 面收窄到 Ctrl/Alt/Shift，与旧版 egui「须含 Ctrl/Alt/Shift」的可用集一致。
// 保存含 Meta 的录制值时 SettingsModal 会 toast 提示。

export interface ComboParts {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

/** 解析录制串；含 Meta/未知修饰或键名不在字母/数字/Space 白名单 → null（拒绝）。 */
export function parseCombo(combo: string): ComboParts | null {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const p: ComboParts = { ctrl: false, alt: false, shift: false, code: "" };
  for (const m of parts) {
    if (m === "Ctrl") p.ctrl = true;
    else if (m === "Alt") p.alt = true;
    else if (m === "Shift") p.shift = true;
    else return null; // Meta 或未知修饰 token：整体拒绝
  }
  if (!p.ctrl && !p.alt && !p.shift) return null; // 录制器契约：须含修饰键
  // 键名 → 物理键位 e.code（免键盘布局差异，同 T28 palette 的取码口径）
  if (/^[A-Z]$/.test(key)) p.code = "Key" + key;
  else if (/^[0-9]$/.test(key)) p.code = "Digit" + key;
  else if (key === "Space") p.code = "Space";
  else return null;
  return p;
}

/** 与 KeyboardEvent 精确匹配：修饰必须完全一致，防 "Alt+1" 误吞 "Ctrl+Alt+1"。 */
export function comboMatches(
  e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
  combo: string,
): boolean {
  const p = parseCombo(combo);
  return !!p && p.ctrl === e.ctrlKey && p.alt === e.altKey && p.shift === e.shiftKey && p.code === e.code;
}
