// 右上角关闭=「退出还是常驻托盘？」询问框（close_action=ask 时由后端
// close-requested 事件唤起）。勾「记住我的选择」即把 close_action 落盘，
// 下次关窗直接执行不再弹框；改回来在 设置→常规→关闭行为。
// 挂载方式：App.tsx 以 ui.closeAskOpen 条件挂载（同 SettingsModal），
// 组件本体不含门卫——卸载即归零，remember 勾选态绝不跨开合残留。
import { useState } from "react";
import Modal from "./Modal";
import { api } from "../lib/ipc";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore, errText } from "../stores/useUiStore";

export default function CloseAskDialog() {
  const setOpen = useUiStore((s) => s.setCloseAskOpen);
  const [remember, setRemember] = useState(false);
  const decide = (action: "tray" | "exit") => {
    if (remember) {
      const cur = useSettingsStore.getState().settings;
      if (cur) void useSettingsStore.getState().save({ ...cur, close_action: action });
    }
    setOpen(false);
    void api.applyCloseDecision(action).catch((e) =>
      useUiStore.getState().addToast("error", `关闭窗口失败：${errText(e)}`));
  };
  return (
    <Modal title="关闭窗口" onClose={() => setOpen(false)} ariaLabel="关闭窗口">
      <p className="modal-note">关闭窗口时，你想退出应用，还是隐藏到底部托盘常驻？</p>
      <label className="close-ask-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        记住我的选择，下次不再询问
      </label>
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={() => setOpen(false)}>取消</button>
        <button type="button" className="modal-btn" onClick={() => decide("tray")}>隐藏到托盘</button>
        <button type="button" className="modal-btn modal-btn-primary" onClick={() => decide("exit")}>退出应用</button>
      </div>
    </Modal>
  );
}
