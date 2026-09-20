// 快捷键录制层（P2-8c 自 components/SettingsModal.tsx 纯提取）：录制态与提示、
// capture 阶段的按键监听、生效键表与冲突派生、恢复出厂。键值写入走草稿
//（draft.hotkeys，关闭弹窗时随 saveAndClose 统一落盘）。
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Settings } from "../types/ipc";
import { allowsBare, keyName } from "../lib/hotkeys";
import {
  HOTKEYS,
  defaultHotkeys,
  effectiveHotkeys,
  findConflicts,
} from "../lib/hotkeyRegistry";

export function useHotkeyRecorder(
  draft: Settings | null,
  setDraft: Dispatch<SetStateAction<Settings | null>>,
) {
  const [recording, setRecording] = useState<string | null>(null);
  const [hkMsg, setHkMsg] = useState("");

  const eff = useMemo(() => effectiveHotkeys(draft?.hotkeys), [draft?.hotkeys]);
  const conflicts = useMemo(() => findConflicts(eff), [eff]);

  // 快捷键录制：capture 阶段吃掉全部按键（含 Esc——壳层按 defaultPrevented
  // 让路）；修饰顺序固定 Ctrl/Alt/Shift，与 Rust hotkey_combo 口径一致。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        setRecording(null);
        setHkMsg("已取消录制");
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (!e.ctrlKey && e.metaKey) parts.push("Meta");
      const name = keyName(e);
      if (!name) return; // 非白名单键（方向键等）：继续等
      if (parts.includes("Meta")) {
        // 录进去也注册不上（Win 键被系统大量占用，Rust registrable 显式拒绝），
        // 与其存下来当摆设，不如当场说清楚。
        setHkMsg("Meta(Win) 键不受支持，请改用 Ctrl / Alt / Shift");
        return;
      }
      if (parts.length === 0 && !allowsBare(name)) {
        setHkMsg(`${name} 需要配合 Ctrl / Alt / Shift 使用`);
        return;
      }
      const combo = [...parts, name].join("+");
      setDraft((d) => (d ? { ...d, hotkeys: { ...d.hotkeys, [recording]: combo } } : d));
      setRecording(null);
      setHkMsg(`已设置「${HOTKEYS.find((h) => h.id === recording)?.label ?? recording}」为 ${combo}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const resetHotkeys = () => {
    setDraft((d) => (d ? { ...d, hotkeys: defaultHotkeys() } : d));
    setHkMsg("已恢复出厂快捷键");
  };

  return { recording, setRecording, hkMsg, setHkMsg, eff, conflicts, resetHotkeys };
}
