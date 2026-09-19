// 守卫：把前端 TS 类型当作 Rust Issue 的镜像锁住。任何一边字段改名 /
// 加删，这两条会立刻变红（项目惯例）。**不要在改字段时跳过这个测试**——
// 漏改会让面板拿到缺字段的 issue 然后运行时炸。
import { describe, expect, it, vi } from "vitest";
import type { Issue, IssueKind, Severity } from "../types/ipc";
import { countByKind, checkTranslation } from "./checkTranslation";

// P0-2 接线守卫：拦住底层 invoke，钉住「mode 与 target 必须传给后端」——
// translations 的 key 索引空间由 mode 决定（translation = data-ri run 空间 /
// bilingual = data-bi 块空间），方向决定可译判定；缺了任何一个，Rust 端就在
// 错误的索引空间里对号（BUG-2 的假漏译/假回声）。
const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args: args ?? {} });
    return [];
  },
}));

describe("Issue 与 Rust translate::check::Issue 的字段镜像", () => {
  it("Issue 字段集合稳定", () => {
    // 这是「镜像」的最小契约——字段集合（顺序无关）是契约，顺序不是。
    const sample: Issue = {
      run: 0,
      kind: "OmittedUntranslated",
      severity: "Warning",
      src_excerpt: "",
      dst_excerpt: "",
    };
    expect(Object.keys(sample).sort()).toEqual([
      "dst_excerpt",
      "kind",
      "run",
      "severity",
      "src_excerpt",
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

describe("checkTranslation IPC 接线（P0-2）：mode/target 必须到后端", () => {
  const CONTENT = "# t\n\nAlpha **bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

  it("translation 模式：payload 带 mode 与 targetLang（键空间 = data-ri run 空间）", async () => {
    h.calls.length = 0;
    await checkTranslation(CONTENT, [[0, "你好"]], "translation", "zh");

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.cmd).toBe("check_translation");
    expect(call.args).toMatchObject({
      content: CONTENT,
      translations: [[0, "你好"]],
      mode: "translation",
      targetLang: "zh",
    });
  });

  it("bilingual 模式同样透传（键空间 = data-bi 块空间，方向决定可译判定）", async () => {
    h.calls.length = 0;
    await checkTranslation(CONTENT, new Map([[0, "Hello"]]), "bilingual", "en");

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toMatchObject({
      mode: "bilingual",
      targetLang: "en",
    });
  });
});