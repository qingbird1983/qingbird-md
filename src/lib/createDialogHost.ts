// 对话框单例 host 工厂（P2-2/CQ-14）：ConfirmDialog / ConflictDialog /
// DirtyConfirmDialog / ReloadDialog 此前各自复制同一套 createRoot 挂载/卸载/
// promise 结算样板，这里收拢为一份。每调用一次 createDialogHost 得到一份
// 独立单例（host 常驻 document.body），各对话框之间互不干扰。
//
// 并发契约（沿袭 ConfirmDialog 的 P1-7/REL-4 语义，推广到全部对话框）：
// 同一时刻至多一个未决弹窗；后到调用先把前者按 coverValue 结算（= 该对话框
// 的「取消」语义，调用方据此中止流程），再接管单例渲染新弹窗——否则被覆盖
// 者的 awaiter 永远无人结算而挂死。
import { useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * 创建一个 Promise 式单例对话框入口。
 * render(props, resolve) 返回要挂到单例 host 上的对话框元素；
 * coverValue 是被后到弹窗覆盖时前者的结算值（取消语义）。
 */
export function createDialogHost<T, P>(
  render: (props: P, resolve: (v: T) => void) => ReactElement,
  coverValue: T,
): (props: P) => Promise<T> {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  /** 应用级「正在显示」闸：持有当前未决弹窗的结算入口；非 null 即有弹窗挂着。 */
  let pending: ((v: T) => void) | null = null;

  return function show(props: P): Promise<T> {
    if (!host) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
    }
    pending?.(coverValue);
    return new Promise<T>((resolve) => {
      const settle = (v: T) => {
        pending = null;
        root!.render(null);
        resolve(v);
      };
      pending = settle;
      root!.render(render(props, settle));
    });
  };
}

/** 对话框按钮防重入闸：结算一次后再点不再重复 resolve（busy 期间按钮禁用）。 */
export function useDialogPick<T>(
  resolve: (v: T) => void,
): [boolean, (v: T) => () => void] {
  const [busy, setBusy] = useState(false);
  const pick = (v: T) => () => {
    if (busy) return;
    setBusy(true);
    resolve(v);
  };
  return [busy, pick];
}
