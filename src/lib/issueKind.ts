/**
 * 确定性检查 issue 类别的中文短标签 —— **单一真源**。
 *
 * 用 `satisfies Record<IssueKind, string>` 而不是 `Record<string, string>`：
 * Rust 端 `translate/check.rs` 将来加一类问题、`IssueKind` 跟着加成员时，
 * **这里会立刻 tsc 报错**（漏一个类别以前只会静默显示英文键名，没人发现）。
 */
import type { IssueKind } from "../types/ipc";

export const ISSUE_KIND_LABEL = {
  OmittedUntranslated: "漏译",
  EchoOfSource: "译文=原文",
  MarksLost: "标记丢失",
  StructureMismatch: "结构不对等",
  CodeInvaded: "代码被侵入",
} satisfies Record<IssueKind, string>;

/** 短标签，读作「N 处<短标签>」。`||` 兜住前端类型镜像落后于 Rust 的窗口期。 */
export function issueKindLabel(kind: IssueKind): string {
  return ISSUE_KIND_LABEL[kind] || kind;
}

/**
 * S5：AI 语义核查类别短标签（键 = translate/review.rs KINDS 白名单）。
 * AI 类别是纯字符串契约（Rust 端强校验白名单），这里用 Record<string,string>
 * + `||` 兜底，后端将来扩枚举不会把面板打成英文键名。
 */
export const AI_KIND_LABEL: Record<string, string> = {
  term_inconsistency: "术语不一",
  pronoun_reference: "指代不清",
  register: "语域不当",
  number_propernoun: "数字专名",
  syntax_breakdown: "句法崩坏",
};

export function aiKindLabel(kind: string): string {
  return AI_KIND_LABEL[kind] || kind;
}

/** severity → 中文短标签（high/medium/low）。 */
export const SEVERITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

/** S5：AI 问题按 kind 计数（面板计数条的「2 处术语不一 · 1 处语域不当」用）。 */
export function countByAiKind(issues: ReadonlyArray<{ kind: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of issues) out[i.kind] = (out[i.kind] ?? 0) + 1;
  return out;
}
