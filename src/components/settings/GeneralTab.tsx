// 设置面板「常规」页：启动/正文/列表/导出等杂项偏好，全部「点即生效」，
// 不进草稿。正文宽度与层级引线自「外观」迁入（2026-09-24 用户分类重整），
// 导出时重排版自「翻译与模型」迁入并改点即生效。
import { Info } from "lucide-react";
import { api } from "../../lib/ipc";
import { CONTENT_WIDTHS, CONTENT_WIDTH_LABEL, errText, useUiStore, type ContentWidth } from "../../stores/useUiStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { Seg } from "../ui/Seg";
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
  // autostart / capture_enabled 走订阅（不订阅就不重渲染）
  const autostart = useSettingsStore((s) => s.settings?.autostart ?? false);
  const captureOn = useSettingsStore((s) => s.settings?.capture_enabled ?? true);
  // 开机自启不走整包 save：专用命令 apply 插件 + 落盘（与托盘同口径）；
  // 成功后只本地镜像 autostart 一处，避免把别的表单草稿整包覆写回去。
  const setAutostart = async (v: boolean) => {
    try {
      await api.setAutostart(v);
    } catch (e) {
      useUiStore.getState().addToast("error", `设置开机自启失败：${errText(e)}`);
      return;
    }
    const cur = useSettingsStore.getState().settings;
    if (cur) useSettingsStore.setState({ settings: { ...cur, autostart: v } });
  };

  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">启动与截图</h3>
        <SwitchRow label="开机自启"
          desc="登录后自动启动青鸟。关闭后随系统登录不再拉起（托盘菜单里的同名勾选项与此同源）。"
          checked={autostart} onChange={(v) => void setAutostart(v)} />
        <SwitchRow label="截图翻译"
          desc="全局截图翻译的总开关。关闭后：截图热键不再响应、托盘菜单「截图翻译」不再触发；快捷键录制与翻译配置不受影响。"
          checked={captureOn}
          onChange={(v) => { const cur = useSettingsStore.getState().settings;
            if (cur) void useSettingsStore.getState().save({ ...cur, capture_enabled: v }); }} />
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">正文宽度</h3>
        <p className="set-sec-desc">预览区正文列的宽度。也可以直接拖预览区的边缘自由调宽。</p>
        {/* customWidth !== null（拖拽得到的自由宽度）时传空串哨兵：
            匹配不到任何按钮 → 滑块隐藏，语义同旧「无 .on」。 */}
        <Seg variant="setseg" ariaLabel="正文宽度"
          value={(customWidth === null ? contentWidth : "") as ContentWidth}
          onChange={(w) => setContentWidth(w)}
          options={CONTENT_WIDTHS.map((w) => ({ value: w, label: CONTENT_WIDTH_LABEL[w] }))} />
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
