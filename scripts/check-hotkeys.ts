// T29 hotkeys.ts 自检：`node scripts/check-hotkeys.ts`（Node 24 原生 type stripping）。
// 覆盖：Meta/空值/无修饰拒绝、录制串解析、与事件的精确修饰匹配（防 Alt+1 吞 Ctrl+Alt+1）。
// 任何断言失败即 process.exitCode = 1。
import { comboMatches, parseCombo } from "../src/lib/hotkeys.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  }
}

// ---- parseCombo：拒绝路径 ----
assert(parseCombo("Meta+X") === null, "Meta+X 必须拒绝");
assert(parseCombo("") === null, "空串必须拒绝");
assert(parseCombo("Ctrl+Alt") === null, "纯修饰无主键必须拒绝");
assert(parseCombo("A") === null, "无修饰键必须拒绝（录制器契约）");
assert(parseCombo("Ctrl+F5") === null, "非白名单键名必须拒绝");

// ---- parseCombo：解析路径（录制器固定顺序 Ctrl/Alt/Shift）----
assert(
  JSON.stringify(parseCombo("Ctrl+Alt+1")) ===
    JSON.stringify({ ctrl: true, alt: true, shift: false, code: "Digit1" }),
  "Ctrl+Alt+1 → Ctrl+Alt+Digit1",
);
assert(
  JSON.stringify(parseCombo("Alt+1")) ===
    JSON.stringify({ ctrl: false, alt: true, shift: false, code: "Digit1" }),
  "Alt+1 → Alt+Digit1",
);
assert(
  JSON.stringify(parseCombo("Ctrl+Shift+A")) ===
    JSON.stringify({ ctrl: true, alt: false, shift: true, code: "KeyA" }),
  "Ctrl+Shift+A → Ctrl+Shift+KeyA",
);
assert(
  JSON.stringify(parseCombo("Alt+Space")) ===
    JSON.stringify({ ctrl: false, alt: true, shift: false, code: "Space" }),
  "Alt+Space → Alt+Space",
);

// ---- comboMatches：精确修饰匹配 ----
const ev = (o: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }>) => ({
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  code: "",
  ...o,
});
assert(comboMatches(ev({ altKey: true, code: "Digit1" }), "Alt+1"), "Alt+1 命中");
assert(!comboMatches(ev({ ctrlKey: true, altKey: true, code: "Digit1" }), "Alt+1"), "Ctrl+Alt+1 不误吞 Alt+1");
assert(comboMatches(ev({ ctrlKey: true, shiftKey: true, code: "KeyA" }), "Ctrl+Shift+A"), "Ctrl+Shift+A 命中");
assert(!comboMatches(ev({ shiftKey: true, code: "KeyA" }), "Ctrl+Shift+A"), "少 Ctrl 不命中");
assert(!comboMatches(ev({ altKey: true, code: "KeyX" }), "Meta+X"), "Meta 录制值永不命中");
assert(!comboMatches(ev({ altKey: true, code: "Digit2" }), "Alt+1"), "键不同不命中");

if (failed) {
  console.error(`${failed} 个断言失败`);
  process.exitCode = 1;
} else {
  console.log("check-hotkeys: all assertions passed");
}
