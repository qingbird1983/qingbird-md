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
