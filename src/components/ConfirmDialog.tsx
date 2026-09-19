// 通用确认弹窗（2026-09-12）：Promise 式 showConfirm(opts) → Promise<boolean>。
//
// 与 DirtyConfirmDialog 的分工：那份是「保存 / 不保存 / 取消」固定语义的三选；
// 这里是通用二选一（删除、清空列表等）。两者共用 createRoot 单例挂载思路，
// 但各自持有独立 host，互不干扰。
//
// 焦点策略：危险操作（danger）默认焦点落在「取消」——回车/空格不会误伤；
// 非危险操作落在「确认」，符合「用户主动发起」的意图。Esc / 点遮罩一律 =
// 取消（Modal 自带行为）。焦点之所以能生效：Modal 是 DialogBody 的子组件，
// 副作用自下而上执行，DialogBody 的 focus 晚于 Modal 容器 focus，最终生效。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import Modal from "./Modal";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作：确认钮走危险配色，且默认焦点落到「取消」 */
  danger?: boolean;
  /** 覆盖默认焦点落点；不传时按 danger 推断（危险 → cancel） */
  defaultFocus?: "confirm" | "cancel";
}

function DialogBody({ opts, resolve }: { opts: ConfirmOptions; resolve: (ok: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focus = opts.defaultFocus ?? (opts.danger ? "cancel" : "confirm");

  useEffect(() => {
    (focus === "cancel" ? cancelRef : confirmRef).current?.focus();
  }, [focus]);

  const pick = (ok: boolean) => () => {
    if (busy) return;
    setBusy(true);
    resolve(ok);
  };

  return (
    <Modal title={opts.title} onClose={pick(false)}>
      <div className="modal-note">{opts.body}</div>
      <div className="modal-sep" />
      <div className="modal-actions">
        <button
          type="button"
          className="modal-btn"
          ref={cancelRef}
          onClick={pick(false)}
          disabled={busy}
        >
          {opts.cancelLabel ?? "取消"}
        </button>
        <button
          type="button"
          className={`modal-btn${opts.danger ? " modal-btn-danger" : " modal-btn-primary"}`}
          ref={confirmRef}
          onClick={pick(true)}
          disabled={busy}
        >
          {opts.confirmLabel ?? "确定"}
        </button>
      </div>
    </Modal>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
/** 应用级「正在显示」闸：持有当前未决弹窗的结算入口；非 null 即有弹窗挂着。 */
let pending: ((ok: boolean) => void) | null = null;

/**
 * 应用级单例确认框；同一时刻至多一个。重复调用时先把前者解析为 false
 * （= 取消，调用方据此中止），再让新弹窗覆盖单例 host——否则前一个
 * Promise 永远无人 resolve，其 awaiter 挂死（审计 REL-4）。
 */
export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  pending?.(false);
  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean) => {
      pending = null;
      root!.render(null);
      resolve(ok);
    };
    pending = settle;
    root!.render(<DialogBody opts={opts} resolve={settle} />);
  });
}
