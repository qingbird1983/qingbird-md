// 文件已被外部修改时的重载确认弹窗（T6）。Promise-based，showReloadConfirm
// 返回用户选择；checkExternalChange 据此决定重载或保留。
//
// 复用 DirtyConfirmDialog 的动态挂载 + Modal 模式（单例，Esc/遮罩=保留——
// 非破坏性默认）。默认焦点"保留我的版本"：重载会丢未保存编辑，属于破坏性
// 操作，绝不作为隐式默认。
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Modal from "./Modal";

type Choice = "reload" | "keep";

function DialogBody({
  name,
  dirty,
  resolve,
}: {
  name: string;
  dirty: boolean;
  resolve: (c: Choice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  const pick = (c: Choice) => () => {
    if (busy) return;
    setBusy(true);
    resolve(c);
  };

  return (
    <Modal title="文件已被外部修改" onClose={pick("keep")}>
      <p style={{ margin: "0 0 12px" }}>
        “<strong>{name}</strong>” 已在磁盘上被外部程序修改。
      </p>
      {dirty && (
        <p style={{ margin: "0 0 12px", color: "var(--warn, #b45309)" }}>
          当前有未保存的更改，重新加载将丢失这些编辑。
        </p>
      )}
      <div className="modal-sep" />
      <div className="modal-actions">
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          ref={keepRef}
          onClick={pick("keep")}
          disabled={busy}
        >
          保留我的版本
        </button>
        <button type="button" className="modal-btn" onClick={pick("reload")} disabled={busy}>
          重新加载
        </button>
      </div>
    </Modal>
  );
}

let liveRoot: Root | null = null;
let liveHost: HTMLDivElement | null = null;

export function showReloadConfirm(name: string, dirty: boolean): Promise<Choice> {
  if (!liveHost) {
    liveHost = document.createElement("div");
    document.body.appendChild(liveHost);
    liveRoot = createRoot(liveHost);
  }
  return new Promise<Choice>((resolve) => {
    liveRoot!.render(
      <DialogBody
        name={name}
        dirty={dirty}
        resolve={(c) => {
          liveRoot!.render(null);
          resolve(c);
        }}
      />,
    );
  });
}
