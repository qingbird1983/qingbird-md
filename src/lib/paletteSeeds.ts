// 主题配色「种子」——palette 的唯一真源（2026-09-14）。
//
// 为什么是「种子」而不是直接写 CSS：6 套 × 明暗 2 档 × 23 枚令牌 = 276 个色值，
// 手抄必漂移。本文件是唯一真源，`scripts/gen-palettes.mjs` 由它生成
// `src/styles/palettes.css`，`paletteSeeds.test.ts` 双重守卫：
//   ① 全部 12 档逐项过对比度门槛（主墨≥10 / 次墨≥7 / 弱墨·彩头·朱砂≥4.5）
//   ② 生成出来的 palettes.css 必须逐字节等于本文件的输出（防「改了种子忘跑生成」）
//   ③ xuan 一档必须与 theme.css 的 :root / dark 块逐一相等（默认外观零漂移）
//
// 改配色的正确姿势：只改本文件 → `npm run gen:palettes` → `npm run test`。
// 不要手改 palettes.css（会被下次生成覆盖，且测试会拦下）。

/** 六套配色的 id。单字命名，设置面板直接当标签用。 */
export type PaletteId = "xuan" | "su" | "qing" | "tan" | "ci" | "ye";

/** 一档明暗下的全部令牌。前 14 枚是实色语义色，后 5 枚是纸面派生，
    最后 4 枚由 accent / zhu 派生为半透明（rgba 字面量）。 */
export interface PaletteTokens {
  /** 纸面（编辑 / 预览 / 主区） */
  bg: string;
  /** 面板（标题栏 / 侧栏 / 状态条） */
  bg2: string;
  /** 悬停 / 按下 / 凹陷 */
  bg3: string;
  /** 主墨色（正文） */
  fg: string;
  /** 次级墨色（菜单项 / 树行） */
  fg2: string;
  /** 弱墨色（分区标题 / 空态 / 图标） */
  fg3: string;
  /** 彩头（翻译语义，唯一彩色） */
  accent: string;
  /** 彩头强调（hover / 按下 / 链接） */
  accentStrong: string;
  /** 彩底上的字 */
  onAccent: string;
  /** 发丝线（中缝 / 分隔） */
  border: string;
  /** 浮层 / 输入框描边 */
  borderStrong: string;
  /** 浮层底（最亮面：弹窗 / 卡片 / 选中行） */
  surface: string;
  /** 朱砂（品牌印 / 警示 / 脏标） */
  zhu: string;
  /** 朱砂底上的字（印章 / 主按钮） */
  onZhu: string;
  /** 菜单 / 弹窗内分隔线 */
  sepBg: string;
  /** 占位文字（最弱墨） */
  placeholderFg: string;
  /** 滚动条滑块 */
  scrollbarThumb: string;
  /** 拖宽条 hover */
  resizerHover: string;
  /** 翻译进度卡浅底（彩头淡化） */
  trBoxBg: string;
  /** 彩头选中底（半透明） */
  accentWeak: string;
  /** focus 外环（半透明） */
  accentRing: string;
  /** 彩头描边（双语对照左标） */
  accentBorder: string;
  /** 朱砂淡底（警示 hover） */
  zhuWash: string;
}

export interface Palette {
  id: PaletteId;
  /** 设置面板色卡上的单字（宣 / 素 / 青 / 檀 / 瓷 / 夜） */
  short: string;
  /** 全名（宣纸·青花） */
  label: string;
  /** 一句话定位，色卡下方小字 */
  note: string;
  light: PaletteTokens;
  dark: PaletteTokens;
}

/** 未设置 / 值非法时回落到的默认配色（= 项目原有纸色，老用户升级零感知）。 */
export const DEFAULT_PALETTE: PaletteId = "xuan";

/** 设置面板的展示顺序（也是 paletteCss 的输出顺序，保证生成物稳定）。 */
export const PALETTE_IDS: PaletteId[] = ["xuan", "su", "qing", "tan", "ci", "ye"];

export const PALETTES: Record<PaletteId, Palette> = {
  xuan: {
    id: "xuan",
    short: "宣",
    label: "宣纸·青花",
    note: "现状默认。暖宣纸 + 青花靛蓝，东方雅致",
    light: {
      bg: "#f7f4ec",
      bg2: "#f1ece0",
      bg3: "#e8e1d1",
      fg: "#211f1a",
      fg2: "#4c4a40",
      fg3: "#736f63",
      accent: "#31678e",
      accentStrong: "#285677",
      onAccent: "#f9f3ea",
      border: "#e3dcc9",
      borderStrong: "#d8d0bb",
      surface: "#fffdf8",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#ece6d8",
      placeholderFg: "#bcb7a5",
      scrollbarThumb: "#bcb7a5",
      resizerHover: "#c9c2ae",
      trBoxBg: "#e6edf2",
      accentWeak: "rgba(49, 103, 142, 0.08)",
      accentRing: "rgba(49, 103, 142, 0.3)",
      accentBorder: "rgba(49, 103, 142, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#232220",
      bg2: "#2b2925",
      bg3: "#39362f",
      fg: "#e6e1d4",
      fg2: "#b8b3a4",
      fg3: "#8d8a7b",
      accent: "#6fa3c4",
      accentStrong: "#8fbad6",
      onAccent: "#14161a",
      border: "#3b3830",
      borderStrong: "#474338",
      surface: "#2e2b26",
      zhu: "#cb7062",
      onZhu: "#2a1512",
      sepBg: "#332f29",
      placeholderFg: "#6b6759",
      scrollbarThumb: "#55514a",
      resizerHover: "#55514a",
      trBoxBg: "#22323d",
      accentWeak: "rgba(111, 163, 196, 0.14)",
      accentRing: "rgba(111, 163, 196, 0.38)",
      accentBorder: "rgba(111, 163, 196, 0.50)",
      zhuWash: "rgba(203, 112, 98, 0.12)",
    },
  },
  su: {
    id: "su",
    short: "素",
    label: "素笺·石墨",
    note: "中性无彩纸 + 石墨。纯白文档感，校对/截图/排版用",
    light: {
      bg: "#fafaf8",
      bg2: "#f3f3f1",
      bg3: "#e8e8e5",
      fg: "#1b1b19",
      fg2: "#454542",
      fg3: "#73736d",
      accent: "#44506b",
      accentStrong: "#384258",
      onAccent: "#f8f8fb",
      border: "#e5e5e1",
      borderStrong: "#c8c8c4",
      surface: "#ffffff",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#eeeeeb",
      placeholderFg: "#b6b6b2",
      scrollbarThumb: "#bdbdb9",
      resizerHover: "#c7c7c3",
      trBoxBg: "#e1e2e4",
      accentWeak: "rgba(68, 80, 107, 0.08)",
      accentRing: "rgba(68, 80, 107, 0.3)",
      accentBorder: "rgba(68, 80, 107, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#1e1e1d",
      bg2: "#262625",
      bg3: "#333331",
      fg: "#e8e8e4",
      fg2: "#b4b4af",
      fg3: "#868680",
      accent: "#a3aec9",
      accentStrong: "#b7c3e1",
      onAccent: "#12131a",
      border: "#343432",
      borderStrong: "#484846",
      surface: "#2a2a29",
      zhu: "#c96b5d",
      onZhu: "#2a1512",
      sepBg: "#2c2c2b",
      placeholderFg: "#5b5b57",
      scrollbarThumb: "#4a4a48",
      resizerHover: "#51514e",
      trBoxBg: "#41434a",
      accentWeak: "rgba(163, 174, 201, 0.14)",
      accentRing: "rgba(163, 174, 201, 0.38)",
      accentBorder: "rgba(163, 174, 201, 0.50)",
      zhuWash: "rgba(201, 107, 93, 0.12)",
    },
  },
  qing: {
    id: "qing",
    short: "青",
    label: "竹纸·青竹",
    note: "微黄绿纸 + 竹青。色温最低，长文护眼",
    light: {
      bg: "#f5f7ee",
      bg2: "#eef1e3",
      bg3: "#e2e7d3",
      fg: "#1f2418",
      fg2: "#48503d",
      fg3: "#6c735f",
      accent: "#3f6b4a",
      accentStrong: "#34583d",
      onAccent: "#f7fbf4",
      border: "#e0e5d2",
      borderStrong: "#c3c8b5",
      surface: "#fcfef6",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#e8ecdb",
      placeholderFg: "#b0b5a6",
      scrollbarThumb: "#b7bcae",
      resizerHover: "#c1c5b8",
      trBoxBg: "#dce3d7",
      accentWeak: "rgba(63, 107, 74, 0.08)",
      accentRing: "rgba(63, 107, 74, 0.3)",
      accentBorder: "rgba(63, 107, 74, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#1e221c",
      bg2: "#262b23",
      bg3: "#333a2e",
      fg: "#e4e9da",
      fg2: "#b1b9a4",
      fg3: "#838b77",
      accent: "#8cbb95",
      accentStrong: "#9dd1a7",
      onAccent: "#131a14",
      border: "#32382c",
      borderStrong: "#464d3f",
      surface: "#2a3026",
      zhu: "#cb6e61",
      onZhu: "#2a1512",
      sepBg: "#2c3228",
      placeholderFg: "#596051",
      scrollbarThumb: "#494f43",
      resizerHover: "#505649",
      trBoxBg: "#3b4a3b",
      accentWeak: "rgba(140, 187, 149, 0.14)",
      accentRing: "rgba(140, 187, 149, 0.38)",
      accentBorder: "rgba(140, 187, 149, 0.50)",
      zhuWash: "rgba(203, 110, 97, 0.12)",
    },
  },
  tan: {
    id: "tan",
    short: "檀",
    label: "檀纸·藕荷",
    note: "暖棕檀纸 + 藕荷紫。书斋温润；紫是六套里唯一的非冷色彩头",
    light: {
      bg: "#f8f2e7",
      bg2: "#f2eadb",
      bg3: "#e9dfcc",
      fg: "#241d14",
      fg2: "#524636",
      fg3: "#796d58",
      accent: "#6f5486",
      accentStrong: "#5b456e",
      onAccent: "#fbf7ff",
      border: "#e6dbc6",
      borderStrong: "#cbc0aa",
      surface: "#fffcf5",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#eee4d4",
      placeholderFg: "#b8b0a0",
      scrollbarThumb: "#bfb6a7",
      resizerHover: "#c8bfb1",
      trBoxBg: "#e5dcd9",
      accentWeak: "rgba(111, 84, 134, 0.08)",
      accentRing: "rgba(111, 84, 134, 0.3)",
      accentBorder: "rgba(111, 84, 134, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#241f19",
      bg2: "#2d2720",
      bg3: "#3b332a",
      fg: "#ece3d5",
      fg2: "#bcb0a0",
      fg3: "#908676",
      accent: "#c1a3d6",
      accentStrong: "#d8b7f0",
      onAccent: "#1d1526",
      border: "#3c352c",
      borderStrong: "#51493e",
      surface: "#2f2921",
      zhu: "#d98a72",
      onZhu: "#2a1512",
      sepBg: "#342d25",
      placeholderFg: "#635b4f",
      scrollbarThumb: "#534b41",
      resizerHover: "#5a5247",
      trBoxBg: "#4d414a",
      accentWeak: "rgba(193, 163, 214, 0.14)",
      accentRing: "rgba(193, 163, 214, 0.38)",
      accentBorder: "rgba(193, 163, 214, 0.50)",
      zhuWash: "rgba(217, 138, 114, 0.12)",
    },
  },
  ci: {
    id: "ci",
    short: "瓷",
    label: "冷瓷·靛青",
    note: "冷白瓷 + 靛青。现代冷静，类 GitHub/Linear 观感",
    light: {
      bg: "#f5f7f9",
      bg2: "#eef1f4",
      bg3: "#e3e8ed",
      fg: "#1b1f24",
      fg2: "#444b53",
      fg3: "#6a717a",
      accent: "#3b4a85",
      accentStrong: "#303d6d",
      onAccent: "#f7f8fc",
      border: "#e1e7ec",
      borderStrong: "#c3cad0",
      surface: "#ffffff",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#e8ecf0",
      placeholderFg: "#b0b4ba",
      scrollbarThumb: "#b6bbc0",
      resizerHover: "#c0c4c9",
      trBoxBg: "#dbdfe9",
      accentWeak: "rgba(59, 74, 133, 0.08)",
      accentRing: "rgba(59, 74, 133, 0.3)",
      accentBorder: "rgba(59, 74, 133, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#191c21",
      bg2: "#20242a",
      bg3: "#2b3038",
      fg: "#e5e8ec",
      fg2: "#aeb5bd",
      fg3: "#7d858e",
      accent: "#95a4de",
      accentStrong: "#a7b8f9",
      onAccent: "#161a24",
      border: "#2c3138",
      borderStrong: "#40464e",
      surface: "#24282e",
      zhu: "#c96a5c",
      onZhu: "#2a1512",
      sepBg: "#262a31",
      placeholderFg: "#535961",
      scrollbarThumb: "#434950",
      resizerHover: "#4a5057",
      trBoxBg: "#393f52",
      accentWeak: "rgba(149, 164, 222, 0.14)",
      accentRing: "rgba(149, 164, 222, 0.38)",
      accentBorder: "rgba(149, 164, 222, 0.50)",
      zhuWash: "rgba(201, 106, 92, 0.12)",
    },
  },
  ye: {
    id: "ye",
    short: "夜",
    label: "墨底·月白",
    note: "暗色优先。深墨蓝底 + 月白，夜间阅读；light 档为配套克制版",
    light: {
      bg: "#f6f7f9",
      bg2: "#eceef2",
      bg3: "#e0e3e9",
      fg: "#1a1d23",
      fg2: "#464b55",
      fg3: "#6b717c",
      accent: "#3a6f96",
      accentStrong: "#305b7b",
      onAccent: "#f5f9fc",
      border: "#dfe3ea",
      borderStrong: "#c2c6ce",
      surface: "#ffffff",
      zhu: "#b3483a",
      onZhu: "#fdf6ec",
      sepBg: "#e6e8ee",
      placeholderFg: "#b0b4ba",
      scrollbarThumb: "#b7bbc1",
      resizerHover: "#c1c4ca",
      trBoxBg: "#dce4eb",
      accentWeak: "rgba(58, 111, 150, 0.08)",
      accentRing: "rgba(58, 111, 150, 0.3)",
      accentBorder: "rgba(58, 111, 150, 0.50)",
      zhuWash: "rgba(179, 72, 58, 0.08)",
    },
    dark: {
      bg: "#171a20",
      bg2: "#1e222a",
      bg3: "#2a2f3a",
      fg: "#e7e9ef",
      fg2: "#b0b5c0",
      fg3: "#7e8492",
      accent: "#86b8d8",
      accentStrong: "#96cef2",
      onAccent: "#111820",
      border: "#2a2f39",
      borderStrong: "#3f444f",
      surface: "#22262e",
      zhu: "#cf7a6c",
      onZhu: "#2a1512",
      sepBg: "#242832",
      placeholderFg: "#535863",
      scrollbarThumb: "#424752",
      resizerHover: "#494e59",
      trBoxBg: "#344350",
      accentWeak: "rgba(134, 184, 216, 0.14)",
      accentRing: "rgba(134, 184, 216, 0.38)",
      accentBorder: "rgba(134, 184, 216, 0.50)",
      zhuWash: "rgba(207, 122, 108, 0.12)",
    },
  },
};

/** 归一化：任何来路（设置文件 / 广播 / 手改 JSON）的取值都收敛到合法 id。 */
export function normalizePalette(v: unknown): PaletteId {
  return typeof v === "string" && (PALETTE_IDS as string[]).includes(v)
    ? (v as PaletteId)
    : DEFAULT_PALETTE;
}

/** 设置面板色卡的代表色（4 枚：纸面 / 彩头 / 朱砂 / 浮层），按当前明暗档取。 */
export function paletteSwatch(id: PaletteId, mode: "light" | "dark"): string[] {
  const t = PALETTES[id][mode];
  return [t.bg, t.accent, t.zhu, t.surface];
}

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
