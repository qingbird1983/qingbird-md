// 文件已被外部修改时的重载确认弹窗（T6）。Promise-based，showReloadConfirm
// 返回用户选择；checkExternalChange 据此决定重载或保留。
//
// 单例挂载经共享工厂 createDialogHost（P2-2 收拢原复制的 createRoot 样板；
// Esc/遮罩=保留——非破坏性默认）。默认焦点"保留我的版本"：重载会丢未保存
// 编辑，属于破坏性操作，绝不作为隐式默认。并发二次调用时前者按「保留」
// 结算（P2-2 收口；原实现前者 awaiter 挂死）。
import { useEffect, useRef } from "react";
import Modal from "./Modal";
import { createDialogHost, useDialogPick } from "../lib/createDialogHost";

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
  const [busy, pick] = useDialogPick(resolve);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);

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

const openReloadConfirm = createDialogHost<
  Choice,
  { name: string; dirty: boolean }
>(({ name, dirty }, resolve) => <DialogBody name={name} dirty={dirty} resolve={resolve} />, "keep");

export function showReloadConfirm(name: string, dirty: boolean): Promise<Choice> {
  return openReloadConfirm({ name, dirty });
}
