// 确定性检查（Step 3 #15）：把当前文档与已收集的译文表交给 Rust 端，
// 拿回「漏译 / 标记丢失 / 结构不对等 / 代码被侵入」四类问题的清单。
//
// 零 AI 成本——纯结构对比，不调任何大模型。面板拿到这份数据后，可以决定
// 要展示哪些 issue、哪些需要追问 AI（语义核查是另一条路径，见
// docs/superpowers/plans/2026-09-16-translation-correctness.md §七）。
//
// 字段顺序 / 命名必须与 Rust 端 `translate::check::Issue` 严格一致；
// 守卫测试见同目录的 checkTranslation.test.ts。
import { api } from "./ipc";
import type { Issue, IssueKind } from "../types/ipc";

/** 调后端跑一遍确定性检查。`translations` 的 key 是 `data-ri` run 空间。 */
export async function checkTranslation(
  content: string,
  translations: ReadonlyMap<number, string> | ReadonlyArray<[number, string]>,
): Promise<Issue[]> {
  // 两路统一走 Array.from 让 TS 在目的端推断元素类型，避免联合 narrow 失败。
  const entries: Array<[number, string]> = Array.from(translations);
  return api.checkTranslation(content, entries);
}

/** 按 issue kind 分组计数；用于面板顶部「3 处漏译 / 1 处结构错」类徽标。 */
export function countByKind(issues: ReadonlyArray<Issue>): Record<IssueKind, number> {
  const out: Record<IssueKind, number> = {
    OmittedUntranslated: 0,
    EchoOfSource: 0,
    MarksLost: 0,
    StructureMismatch: 0,
    CodeInvaded: 0,
  };
  for (const i of issues) out[i.kind] += 1;
  return out;
}