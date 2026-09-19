// 保存冲突弹窗（T8）：保存时磁盘 mtime 与打开时不一致 → 覆盖/另存/取消。
// 参考 InkNote FileConflictDialog。单例挂载经共享工厂 createDialogHost
// （P2-2 收拢原复制的 createRoot 样板）；默认焦点"覆盖"——用户本意就是
// Ctrl+S，覆盖符合意图，破坏性语义已在正文写明。并发二次调用时前者按
// 「取消」结算（P2-2 收口；原实现前者 awaiter 挂死）。
import { useEffect, useRef } from "react";
import Modal from "./Modal";
import { createDialogHost, useDialogPick } from "../lib/createDialogHost";

type Choice = "overwrite" | "saveas" | "cancel";

function DialogBody({
  name,
  resolve,
}: {
  name: string;
  resolve: (c: Choice) => void;
}) {
  const [busy, pick] = useDialogPick(resolve);
  const overwriteRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    overwriteRef.current?.focus();
  }, []);

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

/** 单例保存冲突框；并发二次调用先把前者按「取消」结算，再接管单例（P2-2）。 */
const openConflict = createDialogHost<Choice, { name: string }>(
  ({ name }, resolve) => <DialogBody name={name} resolve={resolve} />,
  "cancel",
);

export function showConflict(name: string): Promise<Choice> {
  return openConflict({ name });
}
