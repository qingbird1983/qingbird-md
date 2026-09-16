// 译文另存为（Step 2）：把当前译文表落成一份独立 Markdown 文件。
//
// 复用「导出 HTML」的同一套路——保存走现有 pick_save_path + save_file，
// 唯一的后端新命令是 export_translation（translations → md 文本）。
//
// 前置断言见 exportGate（单一判据，缺一不可）。
//
// 译文**不回写 content**：导出只读 doc.content 与 translations，不碰编辑器、
// 不影响 isDirty，与「译文绝不进 content」那条红线一致。
import { api } from "./ipc";
import { useDocStore } from "../stores/useDocStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useUiStore } from "../stores/useUiStore";
import type { Mode } from "../types/ipc";

/** 导出目标文件名：`原名.<方向>.md`（如 `spec.zh.md`），方向取当前设置。 */
export function translationFileName(docName: string, target: string): string {
  return `${docName.replace(/\.md$/i, "")}.${target}.md`;
}

export interface ExportGateInput {
  hasDoc: boolean;
  mode: Mode;
  running: boolean;
  translationCount: number;
  /** 产出当前译文表的那一轮所用模式（useTranslationStore.lastRunMode）。 */
  lastRunMode: Mode | null;
}

/**
 * 导出启用的**单一判据**——菜单项启用态、tooltip 文案、执行前复检三处共用
 * （组件传响应式值，流程函数取 store 快照，条件本身只有这一份）。
 *
 * 为什么必须限定 `mode === "translation"`：**只有单语模式的译文表才是
 * run 空间**（`data-ri`）；双语模式的 key 是块号，当 run 号传给导出命令
 * 会整体错位，产出的是「看起来正常但每段都对不上」的文件。双语导出
 * （原文 + 译文并列）尚未实现，这里显式挡住而不是静默降级。
 *
 * 为什么还要看 `lastRunMode`：`mode` 是**立刻**变的，而换挡后的重译是
 * 异步的。切模式的那一瞬间，表还是上一档的键空间 → 只查 `mode` 会放行，
 * 导出的就是错位文件。两者一致才说明表与当前模式同源。
 */
export function exportGate(i: ExportGateInput): { ok: boolean; reason: string } {
  if (!i.hasDoc) return { ok: false, reason: "没有打开的文档" };
  if (i.mode !== "translation") {
    return { ok: false, reason: "仅「译文」模式可导出（中英对照导出尚未实现）" };
  }
  if (i.lastRunMode !== null && i.lastRunMode !== i.mode) {
    return { ok: false, reason: "阅读模式刚切换，请等这次翻译完成后再导出" };
  }
  if (i.running) return { ok: false, reason: "翻译进行中，请等待完成" };
  if (i.translationCount === 0) return { ok: false, reason: "当前还没有译文，请先翻译" };
  return { ok: true, reason: "" };
}

/** 非响应式快照判定（执行前复检用；组件里请用 exportGate + 响应式 selector）。 */
export function canExportTranslation(): { ok: boolean; reason: string } {
  const dd = useDocStore.getState();
  const st = useTranslationStore.getState();
  return exportGate({
    hasDoc: !!dd.doc,
    mode: dd.mode,
    running: st.status === "running",
    translationCount: dd.translations.size,
    lastRunMode: st.lastRunMode,
  });
}

/**
 * 导出流程一体式：弹原生保存框（默认名 = `原名.<方向>.md`）→ 后端拼装
 * Markdown → 落盘。返回是否实际保存（取消/false、成功/true）。
 */
export async function exportActiveTranslation(): Promise<boolean> {
  const { addToast } = useUiStore.getState();
  const gate = canExportTranslation();
  if (!gate.ok) {
    addToast("info", gate.reason);
    return false;
  }
  const dd = useDocStore.getState();
  const doc = dd.doc!;
  const target = useSettingsStore.getState().target;
  const count = dd.translations.size;
  try {
    const path = await api.pickSavePath(translationFileName(doc.name, target));
    if (!path) return false;
    const md = await api.exportTranslation(doc.content, Array.from(dd.translations.entries()));
    await api.saveFile(path, md);
    // 表可能只是部分译文（按需翻译只译了视口内的块），未译处保留原文——
    // 必须说清楚，否则用户拿到文件会以为整篇都译好了。
    addToast("success", `已导出译文（${count} 处已译，其余保留原文）`);
    return true;
  } catch (e) {
    addToast("error", `导出译文失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
