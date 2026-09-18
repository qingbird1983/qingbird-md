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

  // §五 第 2 步 #9：双语对照导出后端已实现（translate::export::export_bilingual），
  // 入口必须放行——「未实现」的红字提示要在这里消失。
  it("双语模式放行（对照导出后端已实现）", () => {
    const g = exportGate({ ...base, mode: "bilingual", lastRunMode: "bilingual" });
    expect(g.ok).toBe(true);
    expect(g.reason).toBe("");
  });

  it("原文模式不放行", () => {
    expect(exportGate({ ...base, mode: "original" }).ok).toBe(false);
    expect(exportGate({ ...base, mode: "original" }).reason).toContain("原文");
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
  // 而那时表还是上一档的键空间 → 导出错位文件（单语/双语两套键空间）。
  // lastRunMode 是「表与当前模式同源」的最后一道卡口——必须守住。
  it("刚切过模式、表还没重译完时不放行", () => {
    const g = exportGate({ ...base, lastRunMode: "bilingual" });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("刚切换");
  });

  // 双语模式自己也要验 lastRunMode 卡口——单语切到双语、表还在原空间。
  it("双语模式 + 单语表（lastRunMode=translation）不放行", () => {
    const g = exportGate({ ...base, mode: "bilingual", lastRunMode: "translation" });
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