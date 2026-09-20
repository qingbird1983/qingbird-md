// 主题配色「种子」——palette 的唯一真源（2026-09-14）。
//
// 为什么是「种子」而不是直接写 CSS：6 套 × 明暗 2 档 × 23 枚令牌 = 276 个色值，
// 手抄必漂移。本目录是唯一真源（种子表按 id 分文件在 ./<id>.ts，本文件汇聚），
// `scripts/gen-palettes.mjs` 由它生成 `src/styles/palettes.css`，
// `paletteSeeds.test.ts` 双重守卫：
//   ① 全部 12 档逐项过对比度门槛（主墨≥10 / 次墨≥7 / 弱墨·彩头·朱砂≥4.5）
//   ② 生成出来的 palettes.css 必须逐字节等于本文件的输出（防「改了种子忘跑生成」）
//   ③ xuan 一档必须与 theme.css 的 :root / dark 块逐一相等（默认外观零漂移）
//
// 改配色的正确姿势：只改 ./<id>.ts → `npm run gen:palettes` → `npm run test`。
// 不要手改 palettes.css（会被下次生成覆盖，且测试会拦下）。
//
// （P2-8g 拆分）种子表数据按 id 分文件；CSS 生成算法在 ../paletteCss.ts（经本
// 文件 re-export，消费方 import 路径不变）；PALETTE_IDS 顺序为持久化契约，不变。
import { ciPalette } from "./ci.ts";
import { qingPalette } from "./qing.ts";
import { suPalette } from "./su.ts";
import { tanPalette } from "./tan.ts";
import { xuanPalette } from "./xuan.ts";
import { yePalette } from "./ye.ts";

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
  xuan: xuanPalette,
  su: suPalette,
  qing: qingPalette,
  tan: tanPalette,
  ci: ciPalette,
  ye: yePalette,
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

export { TOKEN_ORDER, cssVarName, paletteSelector, paletteCss } from "../paletteCss.ts";
