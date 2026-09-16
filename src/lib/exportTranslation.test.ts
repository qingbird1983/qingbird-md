// @vitest-environment happy-dom
// 判据本身是纯函数，但 import 链会带进 useUiStore（模块顶层读 localStorage），
// 所以需要 DOM 环境——与 useUiStore.test.ts 同款。
import { describe, expect, it } from "vitest";
import { exportGate, translationFileName, type ExportGateInput } from "./exportTranslation";

const base: ExportGateInput = {
  hasDoc: true,
  mode: "translation",
  running: false,
  translationCount: 3,
  lastRunMode: "translation",
};

describe("exportGate", () => {
  it("四项全满足才放行", () => {
    const g = exportGate(base);
    expect(g.ok).toBe(true);
    expect(g.reason).toBe("");
  });

  it("无文档不放行", () => {
    expect(exportGate({ ...base, hasDoc: false }).ok).toBe(false);
  });

  // 这条是**正确性**而不是体验问题：只有单语模式的译文表才是 run 空间
  // （data-ri），双语模式的 key 是块号。当 run 号传进导出命令不会报错，
  // 只会产出「每段都对不上」的文件——所以必须在入口挡住。
  it("双语模式不放行（表是块空间，当 run 空间用会整体错位）", () => {
    const g = exportGate({ ...base, mode: "bilingual" });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("中英对照");
  });

  it("原文模式不放行", () => {
    expect(exportGate({ ...base, mode: "original" }).ok).toBe(false);
  });

  it("翻译进行中不放行（表还在长，导出去是半成品）", () => {
    const g = exportGate({ ...base, running: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("进行中");
  });

  it("无译文不放行", () => {
    const g = exportGate({ ...base, translationCount: 0 });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("还没有译文");
  });

  // mode 是立刻变的，换挡后的重译是异步的。只查 mode 会在这一瞬间放行，
  // 而那时表还是上一档的键空间 → 导出错位文件。两条必须同时成立。
  it("刚切过模式、表还没重译完时不放行", () => {
    const g = exportGate({ ...base, lastRunMode: "bilingual" });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("刚切换");
  });

  it("从未跑过翻译（lastRunMode 为 null）只看其余条件", () => {
    expect(exportGate({ ...base, lastRunMode: null }).ok).toBe(true);
  });
});

describe("translationFileName", () => {
  it("去掉 .md 后缀后接方向标签", () => {
    expect(translationFileName("spec.md", "zh")).toBe("spec.zh.md");
    expect(translationFileName("README.MD", "en")).toBe("README.en.md");
  });

  it("没有后缀时直接接上", () => {
    expect(translationFileName("no-ext", "zh")).toBe("no-ext.zh.md");
  });
});
