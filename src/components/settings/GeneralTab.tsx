// 设置面板「常规」页：启动/正文/列表/导出等杂项偏好，全部「点即生效」，
// 不进草稿。正文宽度与层级引线自「外观」迁入（2026-09-24 用户分类重整），
// 导出时重排版自「翻译与模型」迁入并改点即生效。
import { Info } from "lucide-react";
import { CONTENT_WIDTHS, CONTENT_WIDTH_LABEL, useUiStore } from "../../stores/useUiStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { SwitchRow } from "./SettingsParts";

export default function GeneralTab() {
  const contentWidth = useUiStore((s) => s.contentWidth);
  const customWidth = useUiStore((s) => s.customWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);
  const listGuide = useUiStore((s) => s.listGuide);
  const setListGuide = useUiStore((s) => s.setListGuide);
  const relayout = useSettingsStore((s) => s.settings?.relayout_on_export ?? true);
  const setRelayout = (v: boolean) => {
    const cur = useSettingsStore.getState().settings;
    if (cur) void useSettingsStore.getState().save({ ...cur, relayout_on_export: v });
  };

  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">正文宽度</h3>
        <p className="set-sec-desc">预览区正文列的宽度。也可以直接拖预览区的边缘自由调宽。</p>
        <div className="setseg">
          {CONTENT_WIDTHS.map((w) => (
            <button key={w} type="button"
              className={customWidth === null && contentWidth === w ? "on" : ""}
              onClick={() => setContentWidth(w)}>
              {CONTENT_WIDTH_LABEL[w]}
            </button>
          ))}
        </div>
        {customWidth !== null && (
          <div className="set-hint">
            <Info size={13} />
            <span>
              当前是拖拽得到的自由宽度 {customWidth}px。
              <button type="button" className="set-link" onClick={() => setContentWidth(contentWidth)}>
                恢复为「{CONTENT_WIDTH_LABEL[contentWidth]}」档
              </button>
            </span>
          </div>
        )}
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">列表</h3>
        <SwitchRow label="层级引线"
          desc="给多级列表画出层级竖线，同级圆点串成一根发丝细的线，嵌套关系一眼可见。关掉即恢复无竖线的列表。"
          checked={listGuide} onChange={setListGuide} />
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">导出</h3>
        <SwitchRow label="导出时重排版"
          desc="另存为 .md 时对译文施加确定性排版：中英间距、标点全/半角、省略号、破折号。只影响导出文件，不改屏幕上的译文。"
          checked={relayout} onChange={setRelayout} />
      </section>
    </>
  );
}
