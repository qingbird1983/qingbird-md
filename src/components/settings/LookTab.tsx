// 设置面板「外观」页（P2-8c 自 SettingsModal.tsx 的 look 分支纯提取）：
// 明暗 / 配色 / 正文宽度，全部是「点即生效」类（不进草稿，直接写 store / UI 偏好）。
import { type CSSProperties } from "react";
import { Check, Info } from "lucide-react";
import type { Theme } from "../../stores/useSettingsStore";
import { PALETTES, PALETTE_IDS, paletteSwatch, type PaletteId } from "../../lib/paletteSeeds";
import {
  CONTENT_WIDTHS,
  CONTENT_WIDTH_LABEL,
  useUiStore,
  type ContentWidth,
} from "../../stores/useUiStore";
// 与 TranslateTab 同路（那边也用这一件）：SettingsModal 是唯一出处，环形 import
// 早已存在且工作正常。
import { SwitchRow } from "../SettingsModal";

const THEME_OPTIONS: Array<[Theme, string]> = [
  ["light", "浅色"],
  ["dark", "深色"],
  ["auto", "跟随系统"],
];

export interface LookTabProps {
  theme: Theme;
  setTheme: (v: Theme) => void;
  palette: PaletteId;
  setPalette: (id: PaletteId) => void;
  pvMode: "light" | "dark";
  setPvMode: (v: "light" | "dark") => void;
  contentWidth: ContentWidth;
  customWidth: number | null;
  setContentWidth: (w: ContentWidth) => void;
}

export default function LookTab({
  theme,
  setTheme,
  palette,
  setPalette,
  pvMode,
  setPvMode,
  contentWidth,
  customWidth,
  setContentWidth,
}: LookTabProps) {
  // 层级引线是**纯外观偏好**，与正文宽度同类（点即生效 + localStorage 记忆）。
  // 直接订阅 store、不从 SettingsModal 透传：那份文件的**生产行数已冻结**在
  // codeSizeBudget 的 GRANDFATHERED 快照（455 行）上，多一行就判红。
  const listGuide = useUiStore((s) => s.listGuide);
  const setListGuide = useUiStore((s) => s.setListGuide);

  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">明暗</h3>
        <p className="set-sec-desc">「跟随系统」会随操作系统的浅色/深色外观实时切换。</p>
        <div className="setseg">
          {THEME_OPTIONS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={theme === v ? "on" : ""}
              onClick={() => setTheme(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">配色</h3>
        <p className="set-sec-desc">
          纸色与彩头成套切换，朱砂印保持不变。卡上的小样就是该配色真实的纸面、
          侧栏、彩头与朱砂。
        </p>
        <div className="setseg sm">
          <button
            type="button"
            className={pvMode === "light" ? "on" : ""}
            onClick={() => setPvMode("light")}
          >
            浅色预览
          </button>
          <button
            type="button"
            className={pvMode === "dark" ? "on" : ""}
            onClick={() => setPvMode("dark")}
          >
            深色预览
          </button>
        </div>
        <div className="pal-grid">
          {PALETTE_IDS.map((id) => {
            const p = PALETTES[id];
            const t = p[pvMode];
            const on = palette === id;
            const pv = {
              "--pv-bg": t.bg,
              "--pv-bg2": t.bg2,
              "--pv-border": t.border,
              "--pv-fg": t.fg,
              "--pv-accent": t.accent,
              "--pv-zhu": t.zhu,
              "--pv-surface": t.surface,
            } as CSSProperties;
            return (
              <button
                key={id}
                type="button"
                className={`pal-card${on ? " on" : ""}`}
                aria-pressed={on}
                onClick={() => setPalette(id)}
              >
                <Check className="pal-check" size={14} strokeWidth={3} />
                <div className="pal-preview" style={pv}>
                  <div className="side">
                    <span className="dot" />
                    <span className="seal" />
                  </div>
                  <div className="body">
                    <span className="ln" />
                    <span className="ln dim" />
                    <div className="row">
                      <i className="a" />
                      <i className="z" />
                      <i className="s" />
                    </div>
                  </div>
                </div>
                <div className="pal-card-head">
                  <span className="pal-card-short">{p.short}</span>
                  <span className="pal-card-name">{p.label}</span>
                </div>
                <div className="pal-swatches">
                  {paletteSwatch(id, pvMode).map((c, i) => (
                    <i key={i} style={{ background: c }} />
                  ))}
                </div>
                <div className="pal-card-note">{p.note}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">正文宽度</h3>
        <p className="set-sec-desc">
          预览区正文列的宽度。也可以直接拖预览区的边缘自由调宽。
        </p>
        <div className="setseg">
          {CONTENT_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={customWidth === null && contentWidth === w ? "on" : ""}
              onClick={() => setContentWidth(w)}
            >
              {CONTENT_WIDTH_LABEL[w]}
            </button>
          ))}
        </div>
        {customWidth !== null && (
          <div className="set-hint">
            <Info size={13} />
            <span>
              当前是拖拽得到的自由宽度 {customWidth}px。
              <button
                type="button"
                className="set-link"
                onClick={() => setContentWidth(contentWidth)}
              >
                恢复为「{CONTENT_WIDTH_LABEL[contentWidth]}」档
              </button>
            </span>
          </div>
        )}
      </section>
      <section className="set-sec">
        <h3 className="set-sec-title">列表</h3>
        <SwitchRow
          label="层级引线"
          desc="给多级列表画出层级竖线，同级圆点串成一根发丝细的线，嵌套关系一眼可见。关掉即恢复无竖线的列表。"
          checked={listGuide}
          onChange={setListGuide}
        />
      </section>
    </>
  );
}
