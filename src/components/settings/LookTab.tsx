// 设置面板「外观」页（P2-8c 自 SettingsModal.tsx 的 look 分支纯提取）：
// 明暗 / 配色，全部是「点即生效」类（不进草稿，直接写 store）。
// 正文宽度与层级引线已迁入「常规」页（GeneralTab，2026-09-24 用户分类重整）。
import { type CSSProperties } from "react";
import { Check } from "lucide-react";
import type { Theme } from "../../stores/useSettingsStore";
import { PALETTES, PALETTE_IDS, paletteSwatch, type PaletteId } from "../../lib/paletteSeeds";
import { Seg } from "../ui/Seg";

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
}

export default function LookTab({
  theme,
  setTheme,
  palette,
  setPalette,
  pvMode,
  setPvMode,
}: LookTabProps) {
  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">明暗</h3>
        <p className="set-sec-desc">「跟随系统」会随操作系统的浅色/深色外观实时切换。</p>
        <Seg variant="setseg" ariaLabel="明暗" value={theme} onChange={setTheme}
          options={THEME_OPTIONS.map(([v, label]) => ({ value: v, label }))} />
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">配色</h3>
        <p className="set-sec-desc">
          纸色与彩头成套切换，朱砂印保持不变。卡上的小样就是该配色真实的纸面、
          侧栏、彩头与朱砂。
        </p>
        <Seg variant="setseg sm" ariaLabel="配色预览档" value={pvMode} onChange={setPvMode}
          options={[{ value: "light", label: "浅色预览" }, { value: "dark", label: "深色预览" }]} />
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
    </>
  );
}
