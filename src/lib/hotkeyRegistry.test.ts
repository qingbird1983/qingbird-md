// 快捷键注册表守卫（2026-09-14）。
//
// 这张表成了「设置页列出什么 / App.tsx 认哪些键 / Rust 注册哪些全局键」的
// 唯一真源，于是三类漂移必须被拦住：
//   ① 表里加了 id、App.tsx 的 APP_ACTIONS 没补 → 按下去静默无动作
//      （这一条主要由 TS 的 Record<AppHotkeyId, …> 在编译期挡，这里兜第二道）；
//   ② 默认键与 Rust storage.rs 的 DEFAULT_HOTKEYS 不一致 → 设置页显示
//      Ctrl+Alt+2、实际全局注册的却是别的键（未聚焦时按键没反应）；
//   ③ 解析白名单与默认值打架 → 出厂默认键自己匹配不上自己。
//
// 读 Rust 源码用 node:fs（vitest 跑 SSR，`?raw` 对非 CSS 也会退化成空串口径；
// node 内置的类型声明见 src/types/node-builtins.d.ts）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_HOTKEY_IDS,
  HOTKEYS,
  HOTKEY_GROUPS,
  FIXED_HOTKEYS,
  effectiveHotkeys,
  defaultHotkeys,
  findConflicts,
  hotkeyDef,
} from "./hotkeyRegistry";
import { allowsBare, comboMatches, keyName, parseCombo } from "./hotkeys";

const readAsset = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

// ────────────────────── ① 注册表自身的一致性 ──────────────────────

describe("快捷键注册表", () => {
  it("id 唯一，且分组都在分组标题表里", () => {
    const ids = HOTKEYS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(HOTKEY_GROUPS.map(([g]) => g));
    for (const h of HOTKEYS) {
      expect(known.has(h.group), `${h.id} 的分组 ${h.group} 没有标题`).toBe(true);
    }
  });

  it("每项都有名称和默认键（「都支持默认」的前提）", () => {
    for (const h of HOTKEYS) {
      expect(h.label.length, `${h.id} 缺名称`).toBeGreaterThan(0);
      expect(h.def.length, `${h.id} 缺默认键`).toBeGreaterThan(0);
    }
  });

  it("APP_HOTKEY_IDS 与「非模式非系统级」项双向一致", () => {
    const derived = HOTKEYS.filter((h) => h.group !== "mode" && h.group !== "system")
      .map((h) => h.id)
      .sort();
    expect([...APP_HOTKEY_IDS].sort()).toEqual(derived);
    // 派生集合里的每一项都必须真在表里（防手抄 id 写错字）
    for (const id of APP_HOTKEY_IDS) expect(hotkeyDef(id), `表里没有 ${id}`).toBeDefined();
  });

  it("只有 capture 是系统级注册", () => {
    const globals = HOTKEYS.filter((h) => h.global).map((h) => h.id);
    expect(globals).toEqual(["capture"]);
  });

  it("固定键一览不是空的，且都不与可自定义项重名", () => {
    expect(FIXED_HOTKEYS.length).toBeGreaterThan(0);
    const custom = new Set(HOTKEYS.map((h) => h.label));
    for (const f of FIXED_HOTKEYS) expect(custom.has(f.label)).toBe(false);
  });

  // 汉堡菜单用 `hk.<id>` 取生效键位渲染到菜单项右侧。id 写错一个字母的后果是
  // **静默的**：那个菜单项只是不再显示键位，没有任何报错、tsc 也拦不住
  // （effectiveHotkeys 的返回类型是 Record<string, string>）。这里把菜单源码里
  // 的静态 id 抠出来跟注册表对一遍。
  it("汉堡菜单引用的键位 id 都在注册表里", () => {
    const menu = readAsset("../components/AppMenu.tsx");
    const ids = [...menu.matchAll(/\bhk\.(\w+)/g)].map((m) => m[1]!);
    expect(ids.length, "AppMenu 里一个 hk.<id> 都没匹配到，正则或写法变了？").toBeGreaterThan(4);
    for (const id of ids) {
      expect(hotkeyDef(id), `AppMenu 引用了注册表里没有的 ${id}`).toBeDefined();
    }
  });
});

// ────────────────── ② 默认键必须能被解析器认出来 ──────────────────

describe("出厂默认键自洽", () => {
  it("每个默认键都能解析（否则出厂即失效）", () => {
    for (const h of HOTKEYS) {
      expect(parseCombo(h.def, false), `${h.id}=${h.def} 解析不了`).not.toBeNull();
    }
  });

  it("模式热键带修饰（Rust registrable 的硬要求：裸键会劫持整机）", () => {
    for (const h of HOTKEYS.filter((x) => x.group === "mode")) {
      // requireModifier=true 下仍能解析 ⇒ 一定含 Ctrl/Alt/Shift
      expect(parseCombo(h.def), `${h.id}=${h.def} 缺少修饰键`).not.toBeNull();
    }
  });

  it("出厂默认之间不冲突", () => {
    expect([...findConflicts(defaultHotkeys())]).toEqual([]);
  });

  it("effectiveHotkeys：没录过用默认，录过用用户的，空串=禁用", () => {
    const eff = effectiveHotkeys({ original: "Ctrl+Alt+9", save: "" });
    expect(eff.original).toBe("Ctrl+Alt+9"); // 用户改过的
    expect(eff.open_file).toBe("Ctrl+O"); // 没录过的用默认
    expect(eff.save).toBe(""); // 显式空串保留，不回填默认
    expect(parseCombo(eff.save, false)).toBeNull(); // 空串匹配不上任何键
  });

  it("findConflicts 标出双方", () => {
    const bad = findConflicts({ ...defaultHotkeys(), italic: "Ctrl+B" });
    expect(bad.has("bold")).toBe(true);
    expect(bad.has("italic")).toBe(true);
    expect(bad.has("save")).toBe(false);
  });
});

// ─────────────────── ③ 与 Rust DEFAULT_HOTKEYS 对齐 ───────────────────

describe("与 Rust 侧对齐", () => {
  const rust = readAsset("../../src-tauri/src/storage.rs");
  const rustHotkeys = readAsset("../../src-tauri/src/hotkeys.rs");

  it("Rust DEFAULT_HOTKEYS 与前端表的默认值逐条相等", () => {
    const block = rust.match(/pub const DEFAULT_HOTKEYS[^=]*=\s*&\[([\s\S]*?)\];/);
    expect(block, "storage.rs 里找不到 DEFAULT_HOTKEYS").not.toBeNull();
    const pairs = [...block![1].matchAll(/\("([^"]+)",\s*"([^"]*)"\)/g)].map(
      ([, k, v]) => [k!, v!] as const,
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const [id, def] of pairs) {
      const entry = hotkeyDef(id);
      expect(entry, `前端注册表缺 ${id}`).toBeDefined();
      expect(entry!.def, `${id} 默认值两边不一致`).toBe(def);
      // 系统级注册只看这几个，必须是 global 或 mode
      expect(["mode", "system"]).toContain(entry!.group);
    }
  });

  it("Rust 注册的模式集合 = 前端 mode 组的 id", () => {
    const modes = rustHotkeys.match(/const MODES: \[&str; \d\] = \[([^\]]*)\]/);
    expect(modes, "hotkeys.rs 里找不到 MODES").not.toBeNull();
    const named = [...modes![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
    const front = HOTKEYS.filter((h) => h.group === "mode")
      .map((h) => h.id)
      .sort();
    expect(named).toEqual(front);
  });
});

// ───────────────────────── ④ 解析/匹配规则 ─────────────────────────

describe("键位白名单", () => {
  it("字母数字必须带修饰，功能键与符号可裸按", () => {
    expect(allowsBare("A")).toBe(false);
    expect(allowsBare("1")).toBe(false);
    expect(allowsBare("Space")).toBe(false);
    expect(allowsBare("F5")).toBe(true);
    expect(allowsBare("\\")).toBe(true);
    expect(allowsBare("F13")).toBe(false); // 超出 F1–F12
  });

  it("keyName 认字母/数字/功能键/符号，其余返回 null", () => {
    expect(keyName({ code: "KeyQ", key: "q" })).toBe("Q");
    expect(keyName({ code: "Digit7", key: "7" })).toBe("7");
    expect(keyName({ code: "F5", key: "F5" })).toBe("F5");
    expect(keyName({ code: "Backslash", key: "\\" })).toBe("\\");
    expect(keyName({ code: "Escape", key: "Escape" })).toBeNull();
    expect(keyName({ code: "ArrowDown", key: "ArrowDown" })).toBeNull();
  });

  it("裸键的匹配口径：F5 认、裸字母不认", () => {
    const f5 = { ctrlKey: false, altKey: false, shiftKey: false, code: "F5" };
    expect(comboMatches(f5, "F5", false)).toBe(true);
    expect(comboMatches(f5, "F5")).toBe(false); // 默认 requireModifier=true
    const a = { ctrlKey: false, altKey: false, shiftKey: false, code: "KeyA" };
    expect(comboMatches(a, "A", false)).toBe(false); // 裸字母照样拒绝
    const ctrlShiftO = { ctrlKey: true, altKey: false, shiftKey: true, code: "KeyO" };
    expect(comboMatches(ctrlShiftO, "Ctrl+Shift+O", false)).toBe(true);
    expect(comboMatches(ctrlShiftO, "Ctrl+O", false)).toBe(false); // 修饰必须完全一致
  });

  it("符号键走 code 判定，Shift 改 key 也不影响", () => {
    expect(parseCombo("Ctrl+\\", false)?.code).toBe("Backslash");
    expect(parseCombo("\\", false)?.code).toBe("Backslash");
    expect(parseCombo("Ctrl+Meta+X", false)).toBeNull(); // Meta 一律拒绝
  });
});
