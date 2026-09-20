// 设置面板「快捷键」页（P2-8c 自 SettingsModal.tsx 的 reading 分支纯提取）：
// 可自定义快捷键全表 + 恢复出厂 + 冲突标注 + 固定控件键说明。
// 键值改动进草稿（draft.hotkeys），录制交互归 hooks/useHotkeyRecorder。
import { FIXED_HOTKEYS, HOTKEYS, HOTKEY_GROUPS } from "../../lib/hotkeyRegistry";

export interface HotkeysTabProps {
  recording: string | null;
  setRecording: (id: string | null) => void;
  hkMsg: string;
  setHkMsg: (v: string) => void;
  eff: Record<string, string>;
  conflicts: Set<string>;
  resetHotkeys: () => void;
}

export default function HotkeysTab({
  recording,
  setRecording,
  hkMsg,
  setHkMsg,
  eff,
  conflicts,
  resetHotkeys,
}: HotkeysTabProps) {
  return (
    <>
      <div className="set-head-row">
        <div>
          <h3 className="set-sec-title">快捷键</h3>
          {/* 这行与「恢复默认」同行（.set-head-row），**必须压在一行内**：
              长了会把按钮挤成两行、整块变肥大（用户反馈）。被拒的按法
              当场就有提示，规则不必在这里讲全。 */}
          <p className="set-sec-desc">点键位框后直接按组合键，Esc 取消。</p>
        </div>
        <button type="button" className="modal-btn" onClick={resetHotkeys}>
          恢复默认
        </button>
      </div>
      {hkMsg && <div className="modal-test">{hkMsg}</div>}
      {conflicts.size > 0 && (
        <div className="set-warn">
          有 {conflicts.size} 项快捷键冲突：同一组合被多个功能占用，生效时以列表靠前的为准。
        </div>
      )}

      {HOTKEY_GROUPS.map(([g, title]) => {
        const rows = HOTKEYS.filter((h) => h.group === g);
        if (rows.length === 0) return null;
        return (
          <section className="set-sec" key={g}>
            <h4 className="set-grp">{title}</h4>
            {rows.map((h) => (
              <div className="setti" key={h.id}>
                <div className="setti-info">
                  <div className="setti-label">{h.label}</div>
                  {h.global && (
                    <div className="setti-desc">全局生效，程序未聚焦也能用</div>
                  )}
                </div>
                <div className="setti-ctl">
                  <button
                    type="button"
                    id={`set-hk-${h.id}`}
                    className={`hk-box${recording === h.id ? " rec" : ""}${
                      conflicts.has(h.id) ? " bad" : ""
                    }`}
                    aria-label={`${h.label} 快捷键`}
                    onClick={() => {
                      setHkMsg("");
                      setRecording(h.id);
                    }}
                  >
                    {recording === h.id ? "按下快捷键…" : eff[h.id] || "未设置"}
                  </button>
                </div>
              </div>
            ))}
          </section>
        );
      })}

      <section className="set-sec">
        <h4 className="set-grp">控件快捷键（固定）</h4>
        <p className="set-sec-desc">
          由控件自身处理，不参与自定义——这类键要跟着「当前选中哪一行/哪段文字」走，
          重绑只会让它们在该生效的地方失效。
        </p>
        {FIXED_HOTKEYS.map((f) => (
          <div className="setti" key={f.label}>
            <div className="setti-info">
              <div className="setti-label">{f.label}</div>
            </div>
            <div className="setti-ctl">
              <span className="hk-box ro">{f.keys}</span>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
