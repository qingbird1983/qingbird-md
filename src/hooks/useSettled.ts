// 面板收展的延迟确认（P2-8f 自 App.tsx 纯提取，体逐字）。
import { useEffect, useState } from "react";

/** 延迟确认：hidden 变 true 后等 ms 再返回 true（展开时立即 false）。
 *  用于把「主区跨列吸收空列」推迟到面板宽度过渡播完之后。 */
export function useSettled(hidden: boolean, ms: number) {
  const [settled, setSettled] = useState(hidden);
  useEffect(() => {
    if (!hidden) {
      setSettled(false);
      return;
    }
    const t = window.setTimeout(() => setSettled(true), ms);
    return () => window.clearTimeout(t);
  }, [hidden, ms]);
  return settled;
}
