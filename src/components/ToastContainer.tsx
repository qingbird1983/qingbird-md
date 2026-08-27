// T27 toast 容器：渲染 ui.toasts 队列（store 端 3s 自动过期，计时器在
// store、不在组件——挂载点为 App 根、随应用生命周期存活，无卸载泄漏面）。
// kind 上色（success/info/error 左侧色条），点击即删（removeToast 幂等）。
import { useUiStore } from "../stores/useUiStore";

export default function ToastContainer() {
  const toasts = useUiStore((s) => s.toasts);
  const removeToast = useUiStore((s) => s.removeToast);
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => removeToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
