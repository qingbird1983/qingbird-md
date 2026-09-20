// 主题配色的 CSS 生成算法（P2-8g 自 lib/paletteSeeds.ts 纯提取，体逐字）。
// 种子表数据在 ./paletteSeeds/<id>.ts 与 ./paletteSeeds/index.ts；本文件只含
// 「从种子到 CSS 文本」的固定管线：令牌输出顺序 → 属性名 → 选择器 → 整文件。
// 经 paletteSeeds/index re-export，消费方 import 路径不变（此处 import 带
// .ts 扩展名：scripts/gen-palettes.mjs 以 Node 类型剥离直跑本文件，ESM 需显式后缀）。
import { PALETTES, PALETTE_IDS, type PaletteId, type PaletteTokens } from "./paletteSeeds/index.ts";

/** 令牌输出顺序：实色（大到小）在前、半透明派生在后。
 *  固定顺序 = 生成物逐字节稳定（守卫测试靠它做等值断言）。 */
export const TOKEN_ORDER: Array<keyof PaletteTokens> = [
  "bg", "bg2", "bg3",
  "fg", "fg2", "fg3",
  "accent", "accentStrong", "onAccent",
  "border", "borderStrong", "surface",
  "zhu", "onZhu",
  "sepBg", "placeholderFg", "scrollbarThumb", "resizerHover", "trBoxBg",
  "accentWeak", "accentRing", "accentBorder", "zhuWash",
];

/** 令牌名 → CSS 自定义属性名（camelCase → kebab-case，规则唯一）。 */
export function cssVarName(k: keyof PaletteTokens): string {
  return "--" + k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/** 选择器：浅档一层属性，深档两层（特异性天然更高，无需 !important）。 */
export function paletteSelector(id: PaletteId, mode: "light" | "dark"): string {
  return mode === "dark"
    ? `body[data-theme="dark"][data-palette="${id}"]`
    : `body[data-palette="${id}"]`;
}

/**
 * 生成整份 `src/styles/palettes.css`。
 * 生成器（scripts/gen-palettes.mjs）与守卫测试共用本函数——两边同源，
 * 测试断言「磁盘上的文件 == 本函数输出」，所以忘了跑生成会被 CI 拦下。
 */
export function paletteCss(): string {
  const out: string[] = [
    "/* 主题配色（palette）令牌表 —— 生成物，请勿手改。",
    "   真源：src/lib/paletteSeeds.ts；重新生成：`npm run gen:palettes`。",
    "   与 theme.css 的明暗两档正交：本文件只覆盖「纸色 + 彩头 + 纸面派生」，",
    "   阴影 / 圆角 / 尺寸节奏 / 字体栈仍由 theme.css 负责。",
    "   默认配色 xuan 的取值与 theme.css 的 :root / dark 块逐一相等",
    "   （paletteSeeds.test.ts 有断言守着），所以挂不挂 data-palette 都不变色。 */",
    "",
  ];
  for (const id of PALETTE_IDS) {
    const p = PALETTES[id];
    out.push(`/* ${p.label}（${id}）— ${p.note} */`);
    for (const mode of ["light", "dark"] as const) {
      out.push(`${paletteSelector(id, mode)} {`);
      for (const k of TOKEN_ORDER) out.push(`  ${cssVarName(k)}: ${p[mode][k]};`);
      out.push("}", "");
    }
  }
  return out.join("\n");
}
