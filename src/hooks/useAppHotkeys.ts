// 应用内快捷键（P2-8f 自 App.tsx 纯提取，体逐字）：执行体表 + keydown 收口 +
// Rust 系统热键（模式切换）回调。接线行为不变——T29 快捷键收口的唯一入口。
import { useEffect } from "react";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useDocStore } from "../stores/useDocStore";
import { useUiStore } from "../stores/useUiStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { openFile } from "../components/commands";
import { exportActiveTranslation } from "../lib/exportTranslation";
import { ensureReviewPanelOpen, revealReviewIssues } from "../lib/reviewPanel";
import { comboMatches } from "../lib/hotkeys";
import { HOTKEYS, effectiveHotkeys, type AppHotkeyId } from "../lib/hotkeyRegistry";
import { api } from "../lib/ipc";
import type { Mode } from "../types/ipc";

/**
 * 应用内快捷键的**执行体**：键 = lib/hotkeyRegistry 的 id。
 *
 * 这里只回答「做什么」，「什么键触发」全在注册表里（含用户改键）。
 * 系统级的项（截图翻译、三个模式键）不出现在这张表：
 *   · capture → Rust 侧注册，触发截图流程，前端不参与；
 *   · 模式键 → 上面 onKey 里的 group === "mode" 分支统一处理。
 * 类型写成 `Record<AppHotkeyId, …>`：注册表加了 id 却忘了写执行体时
 * `tsc` 直接报错（漏项不会再变成「按了没反应」的静默故障）。
 */
const APP_ACTIONS: Record<AppHotkeyId, () => void> = {
  open_file: () => void openFile(),
  open_folder: () => void useWorkspaceStore.getState().openWorkspace(),
  new_file: () => {
    // 新建文件落当前活动文件夹；没有文件夹时不静默吞键，给一句提示
    const ws = useWorkspaceStore.getState();
    if (!ws.activePath) {
      useUiStore.getState().addToast("info", "先打开一个文件夹，再新建文件");
      return;
    }
    const n = window.prompt("新文件名（创建于当前文件夹）：", "未命名.md");
    if (n?.trim()) void ws.createFileIn(null, n.trim());
  },
  save: () => void useDocStore.getState().saveDoc(false),
  // 不可导出时（无译文 / 双语模式 / 翻译中）与菜单同款：给一句说明的 toast，
  // 而不是静默无动作——快捷键路径没有禁用态可看，不提示就等于"按了没反应"。
  export_translation: () => void exportActiveTranslation(),
  refresh_ws: () => {
    if (useWorkspaceStore.getState().folders.length > 0) {
      void useWorkspaceStore.getState().refresh();
    }
  },
  toggle_view: () => {
    const dd = useDocStore.getState();
    dd.switchView(dd.view === "source" ? "preview" : "source");
  },
  split_view: () => useDocStore.getState().switchView("split"),
  palette: () => useUiStore.getState().openPalette(),
  // AI 核查面板开关（§八）：Ctrl+J 与 Guanmo 同键。
  // 开着 → 收起；关着 → **先开面板、等布局落定再把 issue 清单滚进视野**。
  // 顺序不能反：面板是条件挂载的，立刻 scrollIntoView 会按"主区还没变窄"的
  // 旧布局算落点，滚完偏一截（见 lib/reviewPanel.ts 文件头）。
  toggle_review: () => {
    const ui = useUiStore.getState();
    if (ui.showReview) {
      ui.setReviewOpen(false);
      return;
    }
    ensureReviewPanelOpen(() => {
      revealReviewIssues();
    });
  },
  bold: () => void useDocStore.getState().applyFormat("bold"),
  italic: () => void useDocStore.getState().applyFormat("italic"),
};

export function useAppHotkeys() {
  useEffect(() => {
    // T29 快捷键收口：应用内全部组合键唯一入口。
    // 2026-09-14 改成**表驱动**：键位清单一律查 lib/hotkeyRegistry.ts
    // （settings.hotkeys 里录过就用用户的，没录过用出厂默认），这里只留
    // 「按 id 做什么」的执行体——旧版每个键一个 if/switch 分支，加键要改两处。
    // - 总闸：IME 组合期按键不是快捷键意图（T28 先例）；defaultPrevented =
    //   编辑器/内层已处理（CM keymap 的 Mod+S/B/I 走 preventDefault），不重复
    //   触发——防 CM 与本 handler 双发的唯一闸门。
    // - requireModifier=false：F5 这类键天生没有修饰键（扩展白名单见
    //   lib/hotkeys.ts allowsBare）。模式热键带修饰，两种取值结果一致。
    // - global 项（截图翻译、模式键的系统级注册）由 Rust 侧负责，
    //   这里 **先跳过再 preventDefault**，否则会把全局触发也吞掉。
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      // WebView2 加速键 Ctrl+R 会整页重载（未保存文档全丢），无条件拦下。
      // 同族的 F5 已收进注册表（默认仍是 F5），不再在这里特判。
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyR") {
        e.preventDefault();
        return;
      }
      const hk = effectiveHotkeys(useSettingsStore.getState().settings?.hotkeys);
      for (const def of HOTKEYS) {
        const combo = hk[def.id];
        if (!combo || def.global) continue; // 空串=用户禁用；global 交给 Rust
        if (!comboMatches(e, combo, false)) continue;
        e.preventDefault();
        if (def.group === "mode") {
          useDocStore.getState().switchMode(def.id as Mode);
          return;
        }
        // 非模式组必然是 AppHotkeyId（global 项上面已 continue）。
        // 仍留 `?.` 兜一层：注册表若哪天多出个非 app 分组，宁可无动作也别崩。
        APP_ACTIONS[def.id as AppHotkeyId]?.();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // T29 全局热键（Rust 侧注册，程序未聚焦也可换模式）：回调 emit `hotkey-mode`
    // （payload = 模式字符串）→ switchMode。StrictMode 双跑安全：listen promise
    // 晚到且已卸载时由 alive 闩立刻解绑。
    let un: (() => void) | undefined;
    let alive = true;
    void api.listenHotkeyMode((m) => {
      if (m === "original" || m === "translation" || m === "bilingual") {
        useDocStore.getState().switchMode(m);
      }
    }).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);
}
