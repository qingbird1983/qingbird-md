// 保存冲突弹窗（T8）：保存时磁盘 mtime 与打开时不一致 → 覆盖/另存/取消。
// 参考 InkNote FileConflictDialog。复用 DirtyConfirmDialog 的动态挂载 +
// Modal 单例模式；默认焦点"覆盖"——用户本意就是 Ctrl+S，覆盖符合意图，
// 破坏性语义已在正文写明。
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Modal from "./Modal";

type Choice = "overwrite" | "saveas" | "cancel";

function DialogBody({
  name,
  resolve,
}: {
  name: string;
  resolve: (c: Choice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const overwriteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    overwriteRef.current?.focus();
  }, []);

  const pick = (c: Choice) => () => {
    if (busy) return;
    setBusy(true);
    resolve(c);
  };

  return (
    <Modal title="保存冲突" onClose={pick("cancel")}>
      <p style={{ margin: "0 0 12px" }}>
        “<strong>{name}</strong>” 在你打开后已被外部程序修改。覆盖将丢失磁盘上的新版本。
      </p>
      <div className="modal-sep" />
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={pick("cancel")} disabled={busy}>
          取消
        </button>
        <button type="button" className="modal-btn" onClick={pick("saveas")} disabled={busy}>
          另存为…
        </button>
        <button
          type="button"
          className="modal-btn modal-btn-primary"
          ref={overwriteRef}
          onClick={pick("overwrite")}
          disabled={busy}
        >
          覆盖
        </button>
      </div>
    </Modal>
  );
}

let liveRoot: Root | null = null;
let liveHost: HTMLDivElement | null = null;

export function showConflict(name: string): Promise<Choice> {
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
