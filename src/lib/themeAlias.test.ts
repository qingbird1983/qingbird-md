// 派生令牌（值里引用另一个令牌）的**声明位置**守卫。
//
// 为什么需要这个测试：自定义属性在「声明它的元素」上就把 var() 替换成具体值，
// 再按继承往下传（computed-value time）。palettes.css 的配色覆盖写在 body 上，
// 所以 `--panel-bg: var(--bg2)` 若声明在 :root(=html)，它就冻结成 html 上的
// --bg2（默认档 xuan 的暖纸色）——换配色后标题栏/侧栏/按钮底纹丝不动。
// 这个坑 2026-09-14 才被发现（症状：换主题色只有标题栏不跟随），而且**只在浅档
// 暴露**（暗档的 body[data-theme="dark"] 里重复声明过一遍别名，替换点恰好落回
// body，所以一直是好的），极难靠肉眼回归。
//
// 引擎行为已用实测钉住（Edge / WebView2 同引擎）：
//   :root 声明  → 冻结，读不到 body 上的覆盖
//   body  声明  → 正确（body 上 data-theme + data-palette 都已生效）
//
// 本测试只能用结构断言（vitest 无真实浏览器，happy-dom 不做真实级联），
// 但它足以拦住「新加别名时又写回 :root」这一唯一的复发路径。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 读同目录相对路径的样式文件（口径与 paletteSeeds.test.ts 一致，
 *  走 new URL + fileURLToPath，省掉 node:path 的模块声明）。 */
const readStyle = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const themeCss = norm(readStyle("../styles/theme.css"));
const palettesCss = norm(readStyle("../styles/palettes.css"));

/** 极简 CSS 规则拆解：够用就好（本仓库样式表无嵌套、无 @media 包裹令牌）。 */
function rules(css: string): Array<{ sel: string; body: string }> {
  const out: Array<{ sel: string; body: string }> = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (sel) out.push({ sel, body: m[2]! });
  }
  return out;
}

/** 值里引用了别的令牌 = 派生令牌（会受「声明位置」影响的那一类）。 */
const isDerived = (v: string) => v.includes("var(");

/** theme.css 里所有 `--x: value;` 声明（带选择器）。 */
function decls(css: string) {
  return rules(css).flatMap((r) =>
    Array.from(r.body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g), (m) => ({
      sel: r.sel,
      name: m[1]!,
      value: m[2]!.trim(),
    })),
  );
}

/** 不可放 :root 的派生令牌清单（换配色必须跟得着的那批语义令牌）。 */
const ALIASES = [
  "--panel-bg",
  "--btn-hover-bg",
  "--btn-bg",
  "--btn-border",
  "--tree-selected-bg",
  "--palette-selected-bg",
  "--caret-fg",
  "--muted-fg",
  "--note-fg",
  "--test-fg",
  "--status-fg",
  "--danger",
  "--tr-track-bg",
];

describe("主题派生令牌的声明位置", () => {
  const all = decls(themeCss);

  it("每个派生别名都恰好声明在 body 上（且只此一处）", () => {
    for (const name of ALIASES) {
      const at = all.filter((d) => d.name === name);
      expect(at.length, `${name} 未声明或重复声明`).toBe(1);
      expect(at[0]!.sel, `${name} 必须声明在 body 上，否则换配色读不到`).toBe("body");
      expect(isDerived(at[0]!.value), `${name} 应当是 var() 别名`).toBe(true);
    }
  });

  it(":root 与暗档块里不出现任何 var() 引用", () => {
    // 「只放字面量」是这套令牌体系的分工：一旦有人把 --x: var(--y) 写回去，
    // 就会重新引入「换配色不跟随」的静默 bug。
    const offenders = all
      .filter((d) => d.sel === ":root" || d.sel === 'body[data-theme="dark"]')
      .filter((d) => isDerived(d.value))
      .map((d) => `${d.sel} { ${d.name}: ${d.value} }`);
    expect(offenders, "派生令牌请移到 theme.css 的 body 段").toEqual([]);
  });

  it("配色覆盖确实落在 body 上（否则修好声明位置也没用）", () => {
    const sel = new Set(rules(palettesCss).map((r) => r.sel));
    expect(sel.has('body[data-palette="xuan"]')).toBe(true);
    expect(sel.has('body[data-theme="dark"][data-palette="xuan"]')).toBe(true);
    // 反面：配色表里不许出现 html 级选择器
    for (const s of sel) expect(s.startsWith("body")).toBe(true);
  });

  it("body 段引用的都是基础令牌（不出现别名引用别名）", () => {
    // 别名引用别名同样会在 body 上定格成中间值，多绕一层难排查；
    // 统一「body 段只引用 =theme/palette 直接提供的那些令牌」。
    const aliasSet = new Set(ALIASES);
    const bodyAliases = all.filter((d) => d.sel === "body" && isDerived(d.value));
    const bad = bodyAliases
      .flatMap((d) => Array.from(d.value.matchAll(/var\((--[a-z0-9-]+)\)/g), (m) => ({ d, ref: m[1]! })))
      .filter(({ ref }) => aliasSet.has(ref))
      .map(({ d, ref }) => `${d.name} → ${ref}`);
    expect(bad).toEqual([]);
  });
});
