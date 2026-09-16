// @vitest-environment happy-dom
// 翻译方向（中 ⇄ 英）切换的守卫测试。
//
// 为什么值得单独一个文件：切方向**不是**改一个设置字段，而是换一整套索引空间
// ——`data-bi`（块号）的占号由方向决定（纯中文块在 zh 下不占号、在 en 下占号）。
// 少做任何一步的后果都是"不报错、只给错答案/贴错块"：
//   1) 不清 translations/doneHtml → 旧方向的译文表按新方向渲染 → 错位到别的块
//   2) 不按新方向重解析基础 html → 流式 partial 按 data-bi 贴到了旧编号的 DOM 上
//   3) 起跑不带新方向 → 译文方向不变（用户在等英文，回来的还是中文）
//
// 这三条都在下面按"调用形状"钉住。Rust 侧的同源守卫见
// `translate/providers.rs::every_provider_request_carries_the_direction` 与
// `bridge.rs::render_translated_numbering_follows_the_direction`。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types/ipc";

/** IPC 调用记录（vi.mock 被提升到 import 之前，必须用 vi.hoisted 避免 TDZ）。 */
const h = vi.hoisted(() => ({
  parse: [] as Array<[string, string]>,
  translate: [] as unknown[][],
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      // 只桩掉本文件会走到的四个：其余保持真实实现（本文件不触达）。
      parse: async (c: string, t: string) => {
        h.parse.push([c, t]);
        return { html: `<p data-bi="0">${t}</p>`, outline: [] };
      },
      translateDocument: async (...args: unknown[]) => {
        h.translate.push(args);
        return { kind: "started", gen: 1, first_index: 0, indices: [], indices_blocks: [] };
      },
      saveSettings: async (s: Record<string, unknown>) => {
        h.saved.push(s);
      },
      stopTranslation: async () => {},
    },
  };
});

import { useDocStore } from "./useDocStore";
import { normalizeTarget, useSettingsStore } from "./useSettingsStore";
import { useTranslationStore } from "./useTranslationStore";

const SEED: Settings = {
  provider: "auto",
  providers: {},
  workspace: null,
  last_file: null,
  hotkeys: {},
  selection_translate: true,
  outline: "on",
  nav: "on",
  theme: "light",
  palette: "xuan",
  llm_profiles: [],
  llm_active: "",
  autostart: false,
  translate_target: "zh",
};

const CONTENT = "# 标题\n\n正文段落";

function reset() {
  h.parse.length = 0;
  h.translate.length = 0;
  h.saved.length = 0;
  useDocStore.setState({
    tabs: [],
    activeId: null,
    doc: null,
    view: "preview",
    mode: "original",
    cursorSel: [0, 0],
    isDirty: false,
    parseResult: null,
    htmlCache: null,
    doneHtml: null,
    translations: new Map(),
  });
  useSettingsStore.setState({ settings: { ...SEED }, target: "zh", theme: "light", palette: "xuan" });
  useTranslationStore.setState({
    status: "idle",
    progress: null,
    gen: 0,
    lastRunMode: null,
    runContent: null,
    scope: "off",
    viewport: null,
    lastWindow: null,
    partialBlocks: new Map(),
    partialCursor: 0,
    partialGen: 0,
  });
}

/**
 * 造一个"已经翻译过一轮"的 active tab：双语模式 + 非空译文表 + doneHtml。
 *
 * 为什么要 `await` 两次再 resetDisplay：`switchMode` 到非原文模式会自动起跑
 * 一发翻译（`startIfFresh`），那发的 invoke 响应会在**下一个微任务**里把
 * status 置回 running——若不先让它跑完再 resetDisplay 收干净，后面
 * `setTranslateTarget` 收尾的 `startIfFresh` 就会被 `status === "running"`
 * 挡住，测出来的是"方向没传"的假象。这里是在模拟"上一轮已跑完、用户手上
 * 有一份旧译文"的现场。
 */
async function seedTranslatedTab() {
  useDocStore.getState().newTab();
  useDocStore.getState().applyEdit(CONTENT, [0, 0]);
  useDocStore.getState().switchMode("bilingual");
  await Promise.resolve();
  await Promise.resolve();
  useTranslationStore.getState().resetDisplay(); // status 归位 idle（gen 前跳）
  useDocStore.getState().applyTranslationResult(new Map([[0, "旧译文"]]), {
    contentKey: CONTENT,
    mode: "bilingual",
    html: "<p>旧方向的整树 html</p>",
  });
  expect(useDocStore.getState().translations.size).toBe(1);
}

describe("翻译方向归一化", () => {
  it("只认 en，其余一律回落 zh（与 Rust TargetLang::from_tag 同口径）", () => {
    expect(normalizeTarget("en")).toBe("en");
    expect(normalizeTarget("zh")).toBe("zh");
    // 老配置（空串）/ 手改 / 将来多语种 —— 一律回落改动前行为，不报错。
    for (const junk of [undefined, "", "  ", "EN", "ja", "english"]) {
      expect(normalizeTarget(junk), String(junk)).toBe("zh");
    }
  });
});

describe("useDocStore.setTranslateTarget（切方向 = 换索引空间）", () => {
  beforeEach(reset);

  it("切方向：清显示 + 按新方向重解析 + 用新方向重跑", async () => {
    await seedTranslatedTab();
    h.translate.length = 0; // 上面 switchMode 自动起跑的那一发不算

    await useDocStore.getState().setTranslateTarget("en");

    // 1) 基础 html 按**新方向**重解析：parse_markdown 必须拿到 "en"，
    //    否则 DOM 里还是旧方向的 data-bi 编号，流式译文会贴到别的块上。
    expect(h.parse).toContainEqual([CONTENT, "en"]);

    // 2) 索引空间变了 → 旧译文表 / 旧 doneHtml / 旧显示流 全部作废
    expect(useDocStore.getState().translations.size).toBe(0);
    expect(useDocStore.getState().doneHtml).toBeNull();
    expect(useTranslationStore.getState().gen).toBeGreaterThan(0); // resetDisplay 前跳代

    // 3) 偏好落盘（持久化）+ 起跑带新方向
    expect(useSettingsStore.getState().target).toBe("en");
    expect(h.saved[h.saved.length - 1]).toMatchObject({ translate_target: "en" });
    expect(h.translate.some((a) => a[5] === "en"), "起跑必须带新方向").toBe(true);
  });

  it("重复点同一方向是 no-op（不重解析、不起跑）", async () => {
    await seedTranslatedTab();
    h.translate.length = 0;
    h.parse.length = 0;

    await useDocStore.getState().setTranslateTarget("zh"); // 本来就是 zh

    expect(h.parse).toHaveLength(0);
    expect(h.translate).toHaveLength(0);
    expect(useDocStore.getState().translations.size).toBe(1); // 旧译文原地保留
  });

  it("原文模式下切方向：照样重置索引空间，但不自动起跑", async () => {
    useDocStore.getState().newTab();
    useDocStore.getState().applyEdit(CONTENT, [0, 0]);
    h.translate.length = 0;

    await useDocStore.getState().setTranslateTarget("en");

    expect(h.parse).toContainEqual([CONTENT, "en"]);
    expect(h.translate).toHaveLength(0); // mode === original：翻译入口本就关着
    expect(useSettingsStore.getState().target).toBe("en");
  });

  it("没有文档时只落偏好，不碰索引空间（也不崩）", async () => {
    await useDocStore.getState().setTranslateTarget("en");

    expect(useSettingsStore.getState().target).toBe("en");
    expect(h.parse).toHaveLength(0);
    expect(h.translate).toHaveLength(0);
  });
});
