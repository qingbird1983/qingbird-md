// 休眠握手（P2-8f 自 App.tsx 纯提取，体逐字）。
// docs/webview-hibernate-plan.md 步骤 6：关窗后空闲 5 分钟，Rust 侧下发
// session-hibernate，前端同步收集快照落盘再回 hibernateReady，随后 WebView 被
// 销毁。Rust 只等 3s，超时就强杀（内存释放优先于草稿完整性），因此这里必须快：
// collectSnapshot 全同步，只有在等 IPC 返回。调用时序契约见 App 的初始化 effect。
import { api } from "../lib/ipc";
import { collectSnapshot } from "../lib/session";

let hibernateRegistered = false;
export function listenHibernateOnce() {
  if (hibernateRegistered) return; // 防 StrictMode 双跑重复注册
  hibernateRegistered = true;
  void api.listenHibernate(async () => {
    try {
      await api.saveSession(collectSnapshot());
      await api.hibernateReady();
    } catch (e) {
      // 落盘失败也要回 ready：让 Rust 立刻销毁，别白等那 3 秒超时。
      console.error("[hibernate] 保存会话快照失败:", e);
      await api.hibernateReady().catch(() => {});
    }
  });
}
