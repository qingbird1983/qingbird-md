// 译文另存为（Step 2）：把当前译文表落成一份独立 Markdown 文件。
//
// 复用「导出 HTML」的同一套路——保存走现有 pick_save_path + save_file，
// 后端命令 `export_translation` 负责「translations → md 字符串」（单语/双语
// 共用同一个命令，按 `mode` 分发到 cmark 或 translate::export::export_bilingual）。
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
 * §五 第 2 步 #9：现在「译文」与「中英对照」模式都允许导出——单语走 cmark
 * 路径（run 空间）、双语走 `translate::export::export_bilingual` 路径（块
 * 空间）。**只有「原文」模式**没有译文可导出，挡下。
 *
 * 为什么还要看 `lastRunMode`：`mode` 是**立刻**变的，而换挡后的重译是
 * 异步的。切模式的那一瞬间，表还是上一档的键空间 → 只查 `mode` 会放行，
 * 导出的就是错位文件（单语/双语两套键空间）。两者一致才说明表与当前模式
 * 同源——这是后端命令不再做"键空间适配"后唯一守住"表与模式匹配"的卡口。
 */
export function exportGate(i: ExportGateInput): { ok: boolean; reason: string } {
  if (!i.hasDoc) return { ok: false, reason: "没有打开的文档" };
  if (i.mode === "original") {
    return { ok: false, reason: "「原文」模式没有译文可导出" };
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
 *
 * `mode` 决定后端走哪条路径、目标文件后缀（§五 第 2 步 #9 已实现双语对照
 * 导出，后端按 `mode` 分发到 cmark / `translate::export::export_bilingual`）。
 * `target` 是当前翻译方向——双语模式必须传（块空间方向相关，见 IPC 注释）。
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
  // 导出时重排版开关（S6）；设置未加载时按默认「开」，与 storage.rs 的
  // `default_true` 同口径，避免首帧导出静默丢掉规范化。
  const relayout = useSettingsStore.getState().settings?.relayout_on_export ?? true;
  // exportGate 已挡下 "original"——剩下的是可导出的两种模式
  // （"translation" / "bilingual"）。这里再 narrow 一次让 tsc 满意。
  const mode = dd.mode === "bilingual" ? "bilingual" : "translation";
  const count = dd.translations.size;
  try {
    // 双语模式文件加 `.bilingual` 后缀，避免与单语 .md 文件混淆：
    // 两份文件都是合法 Markdown 但格式语义不同，不加分隔用户不知道哪个是哪个。
    const baseName = translationFileName(doc.name, target);
    const finalName = mode === "bilingual" ? baseName.replace(/\.md$/, ".bilingual.md") : baseName;
    const path = await api.pickSavePath(finalName);
    if (!path) return false;
    const md = await api.exportTranslation(
      doc.content,
      Array.from(dd.translations.entries()),
      mode,
      target,
      relayout,
    );
    await api.saveFile(path, md);
    // 表可能只是部分译文（按需翻译只译了视口内的块），未译处保留原文——
    // 必须说清楚，否则用户拿到文件会以为整篇都译好了。
    const tag = mode === "bilingual" ? "双语对照" : "译文";
    addToast("success", `已导出${tag}（${count} 处已译，其余保留原文）`);
    return true;
  } catch (e) {
    addToast("error", `导出译文失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
