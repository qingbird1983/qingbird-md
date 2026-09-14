// 主题配色守卫（2026-09-14）。改配色只改 paletteSeeds.ts，这个文件负责拦住
// 三类翻车：
//   ① 对比度退化——6 套 × 明暗 2 档 × 9 项指标，任一项低于门槛即失败；
//   ② 忘了跑生成——磁盘上的 palettes.css 必须逐行等于 paletteCss() 的输出；
//   ③ 默认外观漂移——xuan 一档必须与 theme.css 的 :root / dark 块逐令牌相等
//      （没有 data-palette 时走 theme.css，两者一旦不一致，挂不挂属性会变色）。
//
// 读磁盘产物用 node:fs（不用 `?raw`：vite 在 SSR 下 CSS 说明符被 css 插件接管，
// raw 结果是空串）。node 内置的类型声明见 src/types/node-builtins.d.ts。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PALETTES,
  PALETTE_IDS,
  TOKEN_ORDER,
  cssVarName,
  paletteCss,
  normalizePalette,
  DEFAULT_PALETTE,
  type PaletteTokens,
} from "./paletteSeeds";

const readAsset = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

/** 统一换行再比：Windows 检出会把 LF 变 CRLF，不归一化会误报不一致。 */
const norm = (s: string) => s.replace(/\r\n/g, "\n");

// ────────────────────────── WCAG 对比度 ──────────────────────────

function srgb(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * srgb(r!) + 0.7152 * srgb(g!) + 0.0722 * srgb(b!);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** hue（度）：只用于断言彩头与朱砂不会互相冒充。 */
function hue(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const d = max - min;
  if (d === 0) return 0;
  const hr = max === r ? ((g! - b!) / d + (g! < b! ? 6 : 0)) : max === g ? (b! - r!) / d + 2 : (r! - g!) / d + 4;
  return hr * 60;
}

/**
 * 门槛表：正文长读要松（≥10），次级 ≥7，弱文本/彩头/朱砂这类小字与图标
 * 一律按 WCAG AA 正文标准 4.5。这些数字是 2026-09-14 逐项实测后定的，
 * 不要为了「让某个新配色过」而调低——要先改色。
 */
const THRESHOLDS: Array<[keyof PaletteTokens, keyof PaletteTokens, number, string]> = [
  ["fg", "bg", 10, "主墨 / 纸面"],
  ["fg", "bg2", 9, "主墨 / 面板"],
  ["fg", "surface", 9, "主墨 / 浮层"],
  ["fg2", "bg", 7, "次墨 / 纸面"],
  ["fg3", "bg", 4.5, "弱墨 / 纸面（9.5px 分区标题）"],
  ["accent", "bg", 4.5, "彩头 / 纸面"],
  ["onAccent", "accent", 4.5, "彩底上的字 / 彩头"],
  ["zhu", "bg", 4.5, "朱砂 / 纸面（警示文字）"],
  ["onZhu", "zhu", 4.5, "朱砂底上的字 / 朱砂（印章）"],
];

describe("配色对比度门槛", () => {
  for (const id of PALETTE_IDS) {
    for (const mode of ["light", "dark"] as const) {
      const t = PALETTES[id][mode];
      it(`${PALETTES[id].label}（${id}）· ${mode} 全项达标`, () => {
        const bad: string[] = [];
        for (const [a, b, need, label] of THRESHOLDS) {
          const r = contrast(t[a], t[b]);
          if (r < need) {
            bad.push(`${label} = ${r.toFixed(2)}（需 ≥ ${need}，${t[a]} on ${t[b]}）`);
          }
        }
        expect(bad, bad.join("；")).toEqual([]);
      });
    }
  }
});

describe("彩头与朱砂必须可分辨", () => {
  for (const id of PALETTE_IDS) {
    for (const mode of ["light", "dark"] as const) {
      it(`${id} · ${mode} 色相差 ≥ 60°`, () => {
        const t = PALETTES[id][mode];
        const d = Math.abs(hue(t.accent) - hue(t.zhu));
        const dist = Math.min(d, 360 - d);
        expect(dist, `accent=${t.accent} zhu=${t.zhu}`).toBeGreaterThanOrEqual(60);
      });
    }
  }
});

// ────────────────────────── 结构完整性 ──────────────────────────

describe("令牌结构完整", () => {
  it("六套配色 id 与顺序固定，默认档合法", () => {
    expect(PALETTE_IDS).toEqual(["xuan", "su", "qing", "tan", "ci", "ye"]);
    expect(PALETTE_IDS).toContain(DEFAULT_PALETTE);
  });

  it("每套两档令牌齐全，且实色为 6 位 hex、派生为 rgba()", () => {
    for (const id of PALETTE_IDS) {
      expect(Object.keys(PALETTES[id])).toContain("light");
      expect(Object.keys(PALETTES[id])).toContain("dark");
      for (const mode of ["light", "dark"] as const) {
        const t = PALETTES[id][mode] as unknown as Record<string, string>;
        for (const k of TOKEN_ORDER) {
          expect(t[k], `${id}.${mode}.${k} 缺失`).toBeTruthy();
          const isRgba = k === "accentWeak" || k === "accentRing" || k === "accentBorder" || k === "zhuWash";
          expect(t[k], `${id}.${mode}.${k} = ${t[k]}`).toMatch(
            isRgba ? /^rgba\(\d+, \d+, \d+, [\d.]+\)$/ : /^#[0-9a-f]{6}$/,
          );
        }
      }
    }
  });

  it("normalizePalette 收敛非法值到默认档", () => {
    expect(normalizePalette("tan")).toBe("tan");
    expect(normalizePalette("")).toBe(DEFAULT_PALETTE);
    expect(normalizePalette(null)).toBe(DEFAULT_PALETTE);
    expect(normalizePalette("宣纸")).toBe(DEFAULT_PALETTE);
    expect(normalizePalette(42)).toBe(DEFAULT_PALETTE);
  });
});

// ────────────────────── 生成物一致性（防忘跑生成）──────────────────────

describe("palettes.css 与种子一致", () => {
  it("磁盘文件 == paletteCss() 输出", () => {
    const disk = norm(readAsset("../styles/palettes.css")).trimEnd();
    const generated = paletteCss().trimEnd();
    if (disk !== generated) {
      throw new Error(
        "palettes.css 已过期（改了 paletteSeeds.ts 但没重新生成）。跑 `npm run gen:palettes` 即可。",
      );
    }
    expect(disk).toBe(generated);
  });

  it("每套配色两档各有一条选择器，且不含主题负责的令牌", () => {
    const css = paletteCss();
    for (const id of PALETTE_IDS) {
      expect(css).toContain(`body[data-palette="${id}"] {`);
      expect(css).toContain(`body[data-theme="dark"][data-palette="${id}"] {`);
    }
    // 阴影 / 圆角 / 字体栈不归配色管，混进来会两套来源打架
    for (const forbidden of ["--shadow", "--r-sm", "--font-serif", "--h-topbar"]) {
      expect(css.includes(`${forbidden}:`)).toBe(false);
    }
  });
});

// ────────────────── 默认外观零漂移（theme.css == xuan）──────────────────

/**
 * 颜色字面量归一：只比「是不是同一个颜色」，不比写法。
 * `rgba(49, 103, 142, 0.50)` 与 `rgba(49, 103, 142, 0.5)` 是同一个值，
 * `#F7F4EC` 与 `#f7f4ec` 也是——写成两份（种子 / theme.css）时格式难免不一致，
 * 若在这里放大写差异，测试会因为噪声变红而失去意义。
 */
function canonColor(v: string): string {
  return v.toLowerCase().replace(/[\d.]+(?=\))/g, (n) => String(Number(n)));
}

/** 从 theme.css 抽一个规则块的 `--var: value;`，带注释的值也能取到。 */
function themeBlock(css: string, marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  expect(start, `theme.css 缺少 ${marker}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + marker.length, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    vars[`--${m[1]}`] = m[2]!.trim().replace(/\s+/g, " ");
  }
  return vars;
}

describe("默认配色 xuan 与 theme.css 逐令牌相等", () => {
  const themeCss = norm(readAsset("../styles/theme.css"));
  const blocks = {
    light: themeBlock(themeCss, "\n:root {"),
    dark: themeBlock(themeCss, 'body[data-theme="dark"] {'),
  };

  for (const mode of ["light", "dark"] as const) {
    it(`${mode} 档：theme.css 里出现的配色令牌都等于 xuan 种子`, () => {
      const t = PALETTES.xuan[mode] as unknown as Record<string, string>;
      const diffs: string[] = [];
      for (const k of TOKEN_ORDER) {
        const name = cssVarName(k);
        const inTheme = blocks[mode][name];
        if (inTheme === undefined) continue; // theme.css 不负责的令牌跳过
        if (canonColor(inTheme) !== canonColor(t[k]))
          diffs.push(`${name}: theme.css=${inTheme} vs xuan=${t[k]}`);
      }
      expect(diffs, diffs.join(" | ")).toEqual([]);
    });
  }

  it("theme.css 必须定义 --on-zhu 与 --accent-border（否则首帧无值）", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(blocks[mode]["--on-zhu"], `${mode} --on-zhu`).toBeTruthy();
      expect(blocks[mode]["--accent-border"], `${mode} --accent-border`).toBeTruthy();
    }
  });
});
