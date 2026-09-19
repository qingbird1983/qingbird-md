// 关闭脏标签时的三选一确认弹窗。Promise-based，showDirtyConfirm 返回用户的选择；
// closeTab 据此决定保存 / 不保存 / 中止关闭。
//
// 设计要点：
//   - 单例挂载经共享工厂 createDialogHost（P2-2 收拢原复制的 createRoot 样板）。
//   - 复用现有 Modal 组件，沿用 SettingsModal 的 .modal-actions/.modal-btn/
//     .modal-btn-primary 按钮样式（Modal 自身没有 footer prop，按钮放在 children 内）。
//   - 默认焦点"保存"——大多数用户意图是保存；Esc / 点遮罩走取消（Modal 自带行为）。
//   - 标签名出现在正文里，给用户具体对象（多个标签时一眼能认出是哪个）。
import { useEffect, useRef } from "react";
import Modal from "./Modal";
import { createDialogHost, useDialogPick } from "../lib/createDialogHost";

type Choice = "save" | "discard" | "cancel";

function DialogBody({
  name,
  resolve,
}: {
  name: string;
  resolve: (c: Choice) => void;
}) {
  const [busy, pick] = useDialogPick(resolve);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  return (
    <Modal title="未保存的更改" onClose={pick("cancel")}>
      <p style={{ margin: "0 0 12px" }}>
        “<strong>{name}</strong>” 有未保存的更改，是否保存？
      </p>
      <div className="modal-sep" />
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={pick("cancel")} disabled={busy}>
          取消
        </button>
        <button type="button" className="modal-btn" onClick={pick("discard")} disabled={busy}>
          不保存
        </button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          ref={saveRef}
          onClick={pick("save")}
          disabled={busy}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

const openDirtyConfirm = createDialogHost<Choice, { name: string }>(
  ({ name }, resolve) => <DialogBody name={name} resolve={resolve} />,
  "cancel",
);

/**
 * 单例关闭确认框；同一时刻至多一个。并发二次调用先把前者按「取消」结算
 * （调用方据此中止关闭流程），再接管单例——原实现被覆盖者的 awaiter 永不
 * settle（P2-2 顺带修复，原注释「不会出现两次叠加」只对了渲染一半）。
 */
export function showDirtyConfirm(name: string): Promise<Choice> {
  return openDirtyConfirm({ name });
}
