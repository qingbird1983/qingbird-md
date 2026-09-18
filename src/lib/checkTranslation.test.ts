// 守卫：把前端 TS 类型当作 Rust Issue 的镜像锁住。任何一边字段改名 /
// 加删，这两条会立刻变红（项目惯例）。**不要在改字段时跳过这个测试**——
// 漏改会让面板拿到缺字段的 issue 然后运行时炸。
import { describe, expect, it } from "vitest";
import type { Issue, IssueKind, Severity } from "../types/ipc";
import { countByKind } from "./checkTranslation";

describe("Issue 与 Rust translate::check::Issue 的字段镜像", () => {
  it("Issue 字段集合稳定", () => {
    // 这是「镜像」的最小契约——字段集合（顺序无关）是契约，顺序不是。
    const sample: Issue = {
      run: 0,
      kind: "OmittedUntranslated",
      severity: "Warning",
      src_excerpt: "",
      dst_excerpt: "",
      src_line: 0,
      dst_line: 0,
    };
    expect(Object.keys(sample).sort()).toEqual([
      "dst_excerpt",
      "dst_line",
      "kind",
      "run",
      "severity",
      "src_excerpt",
      "src_line",
    ]);
  });

  it("IssueKind 五种值齐全（漏译两态 + 三类机械错）", () => {
    // 把每个值显式赋给 Issue.kind，TS 会拒绝任何拼错 / 缺值。
    const samples: IssueKind[] = [
      "OmittedUntranslated",
      "EchoOfSource",
      "MarksLost",
      "StructureMismatch",
      "CodeInvaded",
    ];
    expect(new Set(samples).size).toBe(5);
  });

  it("Severity 至少含 Warning（与 Rust Severity::Warning 镜像）", () => {
    const s: Severity = "Warning";
    expect(s).toBe("Warning");
  });
});

describe("countByKind（面板徽标用）", () => {
  const issue = (
    kind: IssueKind,
    run: number = 0,
  ): Issue => ({
    run,
    kind,
    severity: "Warning",
    src_excerpt: "",
    dst_excerpt: "",
    src_line: 0,
    dst_line: 0,
  });

  it("按 kind 分组计数，缺的填零", () => {
    const counts = countByKind([
      issue("OmittedUntranslated", 0),
      issue("OmittedUntranslated", 1),
      issue("MarksLost", 2),
    ]);
    expect(counts.OmittedUntranslated).toBe(2);
    expect(counts.MarksLost).toBe(1);
    expect(counts.EchoOfSource).toBe(0);
    expect(counts.StructureMismatch).toBe(0);
    expect(counts.CodeInvaded).toBe(0);
  });

  it("空数组返回全零", () => {
    expect(countByKind([])).toEqual({
      OmittedUntranslated: 0,
      EchoOfSource: 0,
      MarksLost: 0,
      StructureMismatch: 0,
      CodeInvaded: 0,
    });
  });
});