// 关闭脏标签时的三选一确认弹窗。Promise-based，showDirtyConfirm 返回用户的选择；
// closeTab 据此决定保存 / 不保存 / 中止关闭。
//
// 设计要点：
//   - 动态挂载（createRoot），避免污染 App 树的渲染顺序。
//   - 复用现有 Modal 组件，沿用 SettingsModal 的 .modal-actions/.modal-btn/
//     .modal-btn-primary 按钮样式（Modal 自身没有 footer prop，按钮放在 children 内）。
//   - 默认焦点"保存"——大多数用户意图是保存；Esc / 点遮罩走取消（Modal 自带行为）。
//   - 标签名出现在正文里，给用户具体对象（多个标签时一眼能认出是哪个）。
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Modal from "./Modal";

type Choice = "save" | "discard" | "cancel";

function DialogBody({
  name,
  resolve,
}: {
  name: string;
  resolve: (c: Choice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  const pick = (c: Choice) => () => {
    if (busy) return;
    setBusy(true);
    resolve(c);
  };

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

let liveRoot: Root | null = null;
let liveHost: HTMLDivElement | null = null;

export function showDirtyConfirm(name: string): Promise<Choice> {
  // 同一时刻至多一个确认框（应用级单例）。如已有遗留则覆盖——不会出现两次叠加。
  if (!liveHost) {
    liveHost = document.createElement("div");
    document.body.appendChild(liveHost);
    liveRoot = createRoot(liveHost);
  }
  return new Promise<Choice>((resolve) => {
    liveRoot!.render(
      <DialogBody
        name={name}
        resolve={(c) => {
          liveRoot!.render(null);
          resolve(c);
        }}
      />,
    );
  });
}
