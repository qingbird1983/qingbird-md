// @vitest-environment happy-dom
// S5：useSemanticReview 的状态机与守卫——面板冒烟测不了的内部账，在这里按帧对：
//   1. 发起 → running → 落定 done（issues 带序号、summary 带模型与指纹）
//   2. 接受 = renderTranslated + applyTranslationResult 写回（run 键、建议文本）
//   3. 漂移守卫：文档在核查后变过 → accept 拒绝执行（renderTranslated 一次都不该被调）
//   4. 译文表被外部换掉 → 清单整体归零（自己 accept 写回的表除外）
//   5. 拒绝：纯标记不碰数据
// 探针必须**真订阅** doc store（照 ReviewPanel 的字段级订阅）——漂移守卫的
// stale 派生靠重渲染读到新 content，不订阅就永远拿旧值，测不出真行为。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  review: vi.fn(),
  render: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      reviewSemantic: h.review,
      renderTranslated: h.render,
      stopTranslation: h.stop,
      listenReviewProgress: async () => () => {},
    },
  };
});

import { useSemanticReview } from "./useSemanticReview";
import { useDocStore } from "../stores/useDocStore";
import type { DocDTO } from "../types/ipc";

const DOC: DocDTO = {
  name: "demo.md",
  path: "F:/tmp/demo.md",
  content: "Hello world",
  base_dir: null,
  char_count: 11,
  line_count: 1,
  encoding: "UTF-8",
  mtime: null,
  parse: { html: "", outline: [] },
};

const ISSUE = {
  run: 7,
  kind: "register" as const,
  severity: "high" as const,
  current: "old",
  suggested: "new",
  reason: "r",
};

/** 探针：字段级订阅 doc store（同 ReviewPanel），hook 返回拍平成快照。 */
let latest: ReturnType<typeof useSemanticReview>;
function Probe() {
  const docContent = useDocStore((s) => s.doc?.content ?? null);
  const translations = useDocStore((s) => s.translations);
  latest = useSemanticReview({
    docContent,
    translations,
    mode: "translation",
    target: "zh",
    creds: { baseUrl: "https://x", model: "m", apiKey: "k" },
    llmReady: true,
    translating: false,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // 走**公开写路径**造活动 tab（EditorView 的警告：绕过投影的 setState 会让
  // doc/translations 不再是 tabs 的投影，写动作全部落空）。
  act(() => {
    useDocStore.getState().openExampleTab("demo.md", "Hello world");
    useDocStore.getState().switchMode("translation");
    useDocStore.getState().applyTranslationResult(new Map([[7, "old"]]), null);
  });
  h.review.mockResolvedValue({
    issues: [ISSUE],
    fingerprint: "review-v1",
    batch_total: 1,
    batch_failed: 0,
    model: "m",
  });
  h.render.mockResolvedValue({ html: "<p>new</p>", outline: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDocStore.setState({ tabs: [], activeId: null, doc: null, translations: new Map(), mode: "original" });
  vi.clearAllMocks();
});

function boot() {
  act(() => {
    root.render(<Probe />);
  });
}

describe("useSemanticReview", () => {
  it("发起 → done：清单带序号，summary 带模型与指纹，instruction 缺省为 null", async () => {
    boot();
    act(() => latest.start());
    expect(latest.phase).toBe("running");
    await act(async () => {});
    expect(latest.phase).toBe("done");
    expect(h.review).toHaveBeenCalledTimes(1);
    const arg = h.review.mock.calls[0] as unknown[];
    expect(arg[0]).toBe("Hello world");
    expect(arg[4]).toBeNull();
    expect(latest.issues).toHaveLength(1);
    expect(latest.issues[0]!.seq).toBe(1);
    expect(latest.summary).toContain("review-v1");
  });

  it("接受：按建议写回 run=7 并重建 done html", async () => {
    boot();
    act(() => latest.start());
    await act(async () => {});
    let ok = false;
    await act(async () => {
      ok = await latest.accept(1);
    });
    expect(ok).toBe(true);
    const st = useDocStore.getState();
    expect(st.translations.get(7)).toBe("new");
    expect(st.doneHtml?.html).toBe("<p>new</p>");
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(latest.issues[0]!.status).toBe("accepted");
  });

  it("漂移守卫：文档在核查后变过 → stale 置位，accept 拒绝执行", async () => {
    boot();
    act(() => latest.start());
    await act(async () => {});
    act(() => {
      useDocStore.setState({ doc: { ...DOC, content: "Hello changed world" } });
    });
    expect(latest.stale).toBe(true);
    let ok = true;
    await act(async () => {
      ok = await latest.accept(1);
    });
    expect(ok).toBe(false);
    expect(h.render).not.toHaveBeenCalled();
    expect(useDocStore.getState().translations.get(7)).toBe("old");
  });

  it("译文表被外部换掉 → 清单归零（自己 accept 写回的表除外）", async () => {
    boot();
    act(() => latest.start());
    await act(async () => {});
    await act(async () => {
      await latest.accept(1);
    });
    expect(latest.issues).toHaveLength(1);
    act(() => {
      useDocStore.setState({ translations: new Map([[7, "external"]]) });
    });
    expect(latest.phase).toBe("idle");
    expect(latest.issues).toHaveLength(0);
  });

  it("拒绝：纯标记不碰数据", async () => {
    boot();
    act(() => latest.start());
    await act(async () => {});
    act(() => latest.reject(1));
    expect(latest.issues[0]!.status).toBe("rejected");
    expect(h.render).not.toHaveBeenCalled();
    expect(useDocStore.getState().translations.get(7)).toBe("old");
  });
});
