// @vitest-environment happy-dom
// 设置面板冒烟（2026-09-14 第三轮改版：无眉头无页脚 / 搜索条 / 关叉即存 /
// 行式排版 / 快捷键全表 / 大模型多套档案）。
//
// 为什么必须走 createRoot + act 而不是 renderToStaticMarkup：zustand 给 SSR 用的
// 快照是 **initialState**（防 hydration 不一致），静态渲染下所有 selector 都读不到
// setState 后的值，测出来的是「设置尚未加载」那一屏。客户端渲染才是真路径。
//
// 为什么要有这个测试：分类是条件渲染的六个分支，任一分支 JSX 写错 tsc 不一定拦得住，
// 但挂上去就会炸；点一圈是最便宜的兜底。另外「关闭即保存」是行为约定而不是样式，
// 只能靠这里钉住——它一旦退化成「关窗丢改动」，用户是事后才发现的。
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 翻译源注册表与数据目录都来自 IPC，测试环境没有后端 → 必须打桩，
// 否则「凭据」整段不渲染，大模型档案那几条测不到真实路径。
// 元数据在工厂内部自建：vi.mock 会被提升到 import 之前执行，
// 引用模块顶层的常量会撞 TDZ。
vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    api: {
      ...real.api,
      getProviders: async () => [
        // 免费组也给一个：这样「llm 组走协议胶囊 / 其余组走下拉」两条分支都测得到。
        {
          key: "auto",
          label: "免费自动（腾讯→金山→MyMemory 兜底）",
          note: "免密钥，开箱可用。",
          needs_key: false,
          max_len: 1000,
          max_concurrency: 3,
          fields: [],
        },
        {
          key: "llm",
          label: "自定义大模型（OpenAI 兼容）",
          note: "目前仅支持 OpenAI 兼容接口。",
          needs_key: false,
          max_len: 3000,
          max_concurrency: 6,
          fields: [
            { key: "baseUrl", label: "API 地址 (Base URL)", secret: false, placeholder: "" },
            { key: "apiKey", label: "API Key", secret: true, placeholder: "" },
            { key: "model", label: "模型名", secret: false, placeholder: "" },
            {
              key: "lookup_model",
              label: "查词模型（可选，留空同翻译模型）",
              secret: false,
              placeholder: "",
            },
          ],
        },
      ],
      userDataDir: async () => "C:/Users/x/AppData/Roaming/qingbird-md",
      // 显示形态与真后端一致：折成环境变量写法（用户要求别露本机绝对路径）
      dataDirLabel: async () => "%APPDATA%\\qingbird-md",
      llmListModels: async () => ["fetched-a", "fetched-b", "fetched-c"],
    },
  };
});

import SettingsModal from "./SettingsModal";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";
import { PALETTE_IDS, PALETTES } from "../lib/paletteSeeds";
import { HOTKEYS, defaultHotkeys } from "../lib/hotkeyRegistry";
import type { Settings } from "../types/ipc";

const SEED: Settings = {
  provider: "llm",
  providers: { llm: { baseUrl: "https://api.deepseek.com", apiKey: "sk-test", model: "m" } },
  workspace: null,
  last_file: null,
  hotkeys: { original: "Ctrl+1", translation: "", bilingual: "", capture: "" },
  selection_translate: true,
  outline: "off",
  nav: "on",
  theme: "light",
  palette: "qing",
  llm_profiles: [],
  llm_active: "",
  autostart: false,
  translate_target: "zh",
  relayout_on_export: true,
};

let host: HTMLDivElement;
let root: Root;

const pane = () => host.querySelector(".set-pane")!;
const navs = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".set-nav-item"));
/** 点左栏第 i 个分类（同步 flush，之后即可断言右栏） */
const goCat = (i: number) => act(() => navs()[i]!.click());

/**
 * 往受控输入框里「打字」。React 在 input 上挂了 value tracker：直接改 el.value
 * 再派发 input，React 会认为值没变而不触发 onChange（经典坑）。必须走原型上的
 * 原生 setter 改值，tracker 才会读到差异。
 */
const typeInto = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

/** 合成按键（录制器监听的是 window 上的 capture 阶段） */
const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });

const seed = (patch: Partial<Settings> = {}) => {
  const s: Settings = {
    ...SEED,
    ...patch,
    providers: { ...SEED.providers, ...(patch.providers ?? {}) },
    hotkeys: { ...SEED.hotkeys, ...(patch.hotkeys ?? {}) },
  };
  useSettingsStore.setState({ settings: s, theme: "light", palette: "qing" });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  seed();
  useUiStore.setState({ settingsOpen: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(<SettingsModal />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("设置面板骨架", () => {
  it("没有上眉、没有页脚：只留左右两栏", () => {
    expect(host.querySelector(".modal-title")).toBeNull();
    expect(host.querySelector(".set-foot")).toBeNull();
    expect(pane().textContent).not.toContain("明暗 / 配色 / 正文宽度点即生效");
    // 左右两栏都在
    expect(host.querySelector(".set-nav")).not.toBeNull();
    expect(host.querySelector(".set-main")).not.toBeNull();
  });

  it("右栏顶部是胶囊搜索框 + 关闭叉；分割线长在右栏里（不通到左栏）", () => {
    const bar = host.querySelector(".set-bar")!;
    expect(bar.querySelector("input[type='search']")).not.toBeNull();
    expect(bar.querySelector(".set-x")).not.toBeNull();
    // 关键结构断言：工具条必须是 .set-main（右栏）的孩子，
    // 这样它的 border-bottom 天然只跨右栏宽度——放进 .set-shell 就会通到左边
    expect(bar.parentElement!.className).toContain("set-main");
  });

  it("六个分类 + 六张配色卡，默认落在常规页", () => {
    expect(navs().map((n) => n.textContent)).toEqual([
      "常规",
      "外观",
      "翻译与模型",
      "快捷键",
      "数据与维护",
      "关于",
    ]);
    expect(host.querySelectorAll(".set-nav-item.on").length).toBe(1);
    expect(navs()[0]!.className).toContain("on");
    // 「常规」页三节（2026-09-24 分类重整：正文宽度/列表自外观迁入、导出重排版自翻译迁入）
    expect(pane().textContent).toContain("正文宽度");
    expect(pane().textContent).toContain("层级引线");
    expect(pane().textContent).toContain("导出时重排版");
    goCat(1); // 配色卡在「外观」页
    expect(host.querySelectorAll(".pal-card").length).toBe(PALETTE_IDS.length);
    const on = host.querySelectorAll(".pal-card.on");
    expect(on.length).toBe(1);
    expect(on[0]!.textContent).toContain(PALETTES.qing.label);
  });

  it("搜索过滤分类；无命中时给空态", () => {
    const box = host.querySelector<HTMLInputElement>(".set-bar input")!;
    // 「正文宽度」的搜索键已随这一节挪到「常规」分类
    act(() => typeInto(box, "正文宽度"));
    expect(navs().map((n) => n.textContent)).toEqual(["常规"]);
    expect(pane().textContent).toContain("正文宽度");

    act(() => typeInto(box, "缓存"));
    expect(navs().map((n) => n.textContent)).toEqual(["数据与维护"]);

    act(() => typeInto(box, "zzzz"));
    expect(navs().length).toBe(0);
    expect(host.querySelector(".set-nav-empty")).not.toBeNull();
    expect(pane().textContent).toContain("没有找到");
  });

  it("点关闭叉 = 自动保存 + 关窗（没有取消/保存按钮可点）", () => {
    const save = vi.spyOn(useSettingsStore.getState(), "save").mockResolvedValue(undefined);
    // 改一处草稿类设置：划词翻译
    goCat(2);
    const sw = host.querySelector<HTMLButtonElement>(".sw")!;
    act(() => sw.click());
    act(() => host.querySelector<HTMLButtonElement>(".set-x")!.click());

    expect(save).toHaveBeenCalledTimes(1);
    const written = save.mock.calls[0]![0] as Settings;
    expect(written.selection_translate).toBe(false); // 草稿改动确实落进去了
    expect(useUiStore.getState().settingsOpen).toBe(false); // 窗口关了
    save.mockRestore();
  });

  it("关窗时 theme/palette 取 store 现值，不吃 draft 里的旧快照", () => {
    // 打开弹窗后用户又去切了配色（真实路径：draft 是更早的快照）
    useSettingsStore.setState({ settings: { ...SEED, palette: "tan" }, palette: "tan" });
    const save = vi.spyOn(useSettingsStore.getState(), "save").mockResolvedValue(undefined);
    act(() => host.querySelector<HTMLButtonElement>(".set-x")!.click());
    expect((save.mock.calls[0]![0] as Settings).palette).toBe("tan");
    save.mockRestore();
  });
});

describe("翻译与模型页", () => {
  /** 按内容取分段控件——本页已有两处（翻译方向 / 翻译源分组），
   *  写 `querySelector(".setseg")` 取到的是"页面第一个"，往上加一栏就会取错。 */
  const segByText = (t: string) =>
    Array.from(host.querySelectorAll<HTMLDivElement>(".setseg")).find((s) =>
      (s.textContent ?? "").includes(t),
    )!;

  it("三分组分段控件 + 划词开关 + 连接测试", () => {
    goCat(2);
    const seg = segByText("免费源");
    expect(Array.from(seg.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      "免费源",
      "专业源",
      "LLM大模型",
    ]);
    expect(seg.querySelectorAll("button.on").length).toBe(1);
    expect(pane().textContent).toContain("划词翻译");
    expect(pane().textContent).toContain("连接测试");
    expect(pane().textContent).toContain("测试连接");
  });

  // 互译方向此前只有状态栏那个切换按钮，设置面板里没有入口（与「划词翻译」
  // 主界面开关 + 设置项的双入口不对称）。这里钉住设置项的存在与默认态；
  // 切换行为本身（reset 索引空间 + 重译）由 useDocStore.direction.test.ts 覆盖，
  // 不在这份 UI 测试里重复。
  it("翻译方向：分段控件两个选项，默认选中译成中文", () => {
    goCat(2);
    const btns = Array.from(segByText("译成中文").querySelectorAll<HTMLButtonElement>("button"));
    expect(btns.map((b) => b.textContent)).toEqual(["译成中文", "译成英文"]);
    expect(btns[0]!.className).toContain("on");
    expect(btns[1]!.className).not.toContain("on");
  });

  // 用户第 1 条：LLM 组的下拉是「伪选择」（注册表里这一组只有一个源），
  // 换成协议胶囊；Anthropic 先占位、禁用。
  it("LLM 组用协议胶囊而非下拉，Anthropic 占位且禁用", () => {
    goCat(2);
    expect(host.querySelector("#set-provider")).toBeNull();

    const proto = Array.from(host.querySelectorAll<HTMLDivElement>(".setseg")).find((b) =>
      (b.textContent ?? "").includes("OpenAI 兼容"),
    )!;
    const btns = Array.from(proto.querySelectorAll<HTMLButtonElement>("button"));
    expect(btns.map((b) => b.textContent!.replace("暂未支持", "").trim())).toEqual([
      "OpenAI 兼容",
      "Anthropic 兼容",
    ]);
    // 选中恒为 OpenAI（唯一能用的那个）
    expect(btns[0]!.className).toContain("on");
    expect(btns[0]!.disabled).toBe(false);
    // 占位项：看得见、按不动、带标识
    expect(btns[1]!.disabled).toBe(true);
    expect(btns[1]!.textContent).toContain("暂未支持");
    // 说明必须点明「只支持 OpenAI 兼容」（旧的长段落已删）
    expect(pane().textContent).toContain("仅支持 OpenAI 兼容接口");
  });

  it("非 LLM 组仍走下拉（源多，下拉才是有意义的）", () => {
    goCat(2);
    const free = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".setseg button"),
    ).find((b) => b.textContent === "免费源")!;
    act(() => free.click());
    expect(host.querySelector("#set-provider")).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll<HTMLOptionElement>("#set-provider option")).map(
        (o) => o.value,
      ),
    ).toContain("auto");
  });

  it("划词翻译是胶囊开关，且左名称右开关（不再用 checkbox）", () => {
    goCat(2);
    expect(pane().querySelector(".modal-check")).toBeNull();
    const sw = host.querySelector<HTMLButtonElement>(".sw")!;
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    // 行式排版：名称在左、控件在右
    const row = sw.closest(".setti")!;
    expect(row.querySelector(".setti-label")!.textContent).toBe("划词翻译");
    expect(row.querySelector(".setti-ctl")!.contains(sw)).toBe(true);
    act(() => sw.click());
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("连接测试左右对齐：说明在左、按钮在右", () => {
    goCat(2);
    const btn = Array.from(pane().querySelectorAll<HTMLButtonElement>(".modal-btn")).find(
      (b) => b.textContent === "测试连接",
    )!;
    const row = btn.closest(".setti")!;
    expect(row.querySelector(".setti-label")!.textContent).toBe("连接测试");
    expect(row.querySelector(".setti-ctl")!.contains(btn)).toBe(true);
  });
});

describe("大模型配置档案", () => {
  it("升级迁移：providers.llm 里已有的凭据被收编成一套档案", () => {
    goCat(2);
    // SEED 的 providers.llm 非空、llm_profiles 为空 → 自动收编，不是「还没有配置」
    const rows = host.querySelectorAll(".prof");
    expect(rows.length).toBe(1);
    expect(rows[0]!.querySelector<HTMLInputElement>(".prof-name")!.value).toBe("原有配置");
    expect(rows[0]!.textContent).toContain("https://api.deepseek.com");
    expect(rows[0]!.querySelector(".prof-tag")!.textContent).toBe("使用中");
    expect(pane().textContent).not.toContain("还没有配置");
  });

  it("没有历史凭据时显示空态而不是假装有一套配置", () => {
    act(() => root.unmount());
    seed({ providers: { llm: {} } });
    root = createRoot(host);
    act(() => {
      root.render(<SettingsModal />);
    });
    goCat(2);
    expect(host.querySelectorAll(".prof").length).toBe(0);
    expect(pane().textContent).toContain("还没有配置");
  });

  it("可以并存多套：新建 → 两行；点另一行切换「使用中」", () => {
    goCat(2);
    const sel = host.querySelector<HTMLSelectElement>("#set-llm-new")!;
    act(() => {
      sel.value = "https://api.deepseek.com";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const rows = () => Array.from(host.querySelectorAll(".prof"));
    expect(rows().length).toBe(2);
    // 新建的这套成为「使用中」，且只此一处
    expect(rows().filter((r) => r.querySelector(".prof-tag")).length).toBe(1);
    expect(rows()[1]!.querySelector(".prof-tag")).not.toBeNull();
    // 点第一行切回去（多套并存的核心诉求：随时切换、互不覆盖）
    act(() => (rows()[0]! as HTMLElement).click());
    expect(rows()[0]!.querySelector(".prof-tag")).not.toBeNull();
    expect(rows()[1]!.querySelector(".prof-tag")).toBeNull();
  });

  it("删除当前配置：行消失、凭据栏清空、不再有「使用中」", () => {
    goCat(2);
    act(() => host.querySelector<HTMLButtonElement>(".prof-del")!.click());
    expect(host.querySelectorAll(".prof").length).toBe(0);
    expect(pane().textContent).toContain("已删除当前配置");
    expect(host.querySelector<HTMLInputElement>("#set-f-baseUrl")!.value).toBe("");
  });

  it("厂商预设不再是并行的下拉（翻译源与预设重复的问题）", () => {
    goCat(2);
    // 旧结构里有个 id="set-llm-preset" 的下拉，选中即覆盖 baseUrl
    expect(host.querySelector("#set-llm-preset")).toBeNull();
    // 预设改成了「新建配置」的模板入口
    expect(host.querySelector("#set-llm-new")).not.toBeNull();
  });

  it("拉取模型：清单写进当前档案并随关闭落盘，模型名可下拉选用", async () => {
    goCat(2);
    // 预设里正好含 deepseek-*，所以这里用一批「只可能来自拉取」的名字来断言
    const btn = Array.from(pane().querySelectorAll<HTMLButtonElement>(".modal-btn")).find((b) =>
      (b.textContent ?? "").includes("拉取模型"),
    )!;
    await act(async () => {
      btn.click();
    });
    expect(pane().textContent).toContain("已拉取 3 个模型");
    expect(pane().textContent).toContain("已存 3 个模型");
    const opts = Array.from(
      host.querySelectorAll<HTMLOptionElement>("#llm-model-list option"),
    ).map((o) => o.value);
    expect(opts).toContain("fetched-a");
    expect(host.querySelector<HTMLInputElement>("#set-f-model")!.getAttribute("list")).toBe(
      "llm-model-list",
    );

    // 关窗时这份清单必须跟着档案一起进 save 载荷（否则重启就没了）
    const save = vi.spyOn(useSettingsStore.getState(), "save").mockResolvedValue(undefined);
    act(() => host.querySelector<HTMLButtonElement>(".set-x")!.click());
    const written = save.mock.calls[0]![0] as Settings;
    expect(written.llm_profiles[0]!.models).toEqual(["fetched-a", "fetched-b", "fetched-c"]);
    save.mockRestore();
  });

  it("「保存此配置」当场落盘（不等关窗），并保留其它套档案", async () => {
    goCat(2);
    const save = vi.spyOn(useSettingsStore.getState(), "save").mockResolvedValue(undefined);
    const btn = Array.from(pane().querySelectorAll<HTMLButtonElement>(".modal-btn")).find(
      (b) => b.textContent === "保存此配置",
    )!;
    await act(async () => {
      btn.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![0] as Settings).llm_profiles.length).toBe(1);
    expect(pane().textContent).toContain("配置已保存");
    save.mockRestore();
  });
});

describe("快捷键页", () => {
  // 用户第 2 条：说明太长会把同行的「恢复默认」挤成两行、整块变肥大。
  // 这里钉住「说明足够短」这个前提；CSS 侧另有 `.set-head-row > .modal-btn`
  // 的 nowrap/flex:none 兜底——两道保险，任一道松了都不会退化。
  it("说明压在一行内，不会把「恢复默认」挤成两行", () => {
    goCat(3);
    const head = pane().querySelector(".set-head-row")!;
    expect(head.querySelector(".set-sec-desc")!.textContent!.length).toBeLessThanOrEqual(24);
    expect(head.querySelector(".modal-btn")!.textContent).toBe("恢复默认");
  });

  it("全部快捷键都在，且都是统一宽度的键位框", () => {
    goCat(3);
    const boxes = Array.from(host.querySelectorAll(".hk-box"));
    // 可自定义的全表 + 固定的控件键
    expect(host.querySelectorAll("[id^='set-hk-']").length).toBe(HOTKEYS.length);
    expect(boxes.length).toBeGreaterThanOrEqual(HOTKEYS.length);
    for (const b of boxes) expect(b.className).toContain("hk-box");
  });

  it("生效值：录过的用用户值，没录过的回落到出厂默认", () => {
    goCat(3);
    expect(host.querySelector("#set-hk-original")!.textContent).toBe("Ctrl+1");
    // SEED 里 translation 是空串 = 用户主动禁用，不回填默认
    expect(host.querySelector("#set-hk-translation")!.textContent).toBe("未设置");
    expect(host.querySelector("#set-hk-save")!.textContent).toBe("Ctrl+S");
    expect(host.querySelector("#set-hk-refresh_ws")!.textContent).toBe("F5");
  });

  it("每条快捷键一行、名称在左键位在右，行间靠 .setti 的细线分隔", () => {
    goCat(3);
    const row = host.querySelector("#set-hk-save")!.closest(".setti")!;
    expect(row.querySelector(".setti-label")!.textContent).toBe("保存文档");
    expect(row.querySelector(".setti-ctl")!.contains(host.querySelector("#set-hk-save"))).toBe(true);
  });

  it("「恢复默认」把整表写回出厂值", () => {
    goCat(3);
    const btn = Array.from(pane().querySelectorAll<HTMLButtonElement>(".modal-btn")).find(
      (b) => b.textContent === "恢复默认",
    )!;
    act(() => btn.click());
    expect(host.querySelector("#set-hk-original")!.textContent).toBe("Ctrl+Alt+1");
    // 原来被显式清空的 translation 也被默认值补上
    expect(host.querySelector("#set-hk-translation")!.textContent).toBe(defaultHotkeys().translation);
    expect(pane().textContent).toContain("已恢复出厂快捷键");
  });

  it("录制：按下组合键写入草稿并回显；裸字母被拒并给出说明", () => {
    goCat(3);
    const box = host.querySelector<HTMLButtonElement>("#set-hk-italic")!;
    act(() => box.click());
    expect(box.textContent).toBe("按下快捷键…");

    // 裸字母：拒绝（会抢走正常打字），且录制继续等着——用户可以直接换个键
    press({ code: "KeyK", key: "k" });
    expect(pane().textContent).toContain("需要配合 Ctrl / Alt / Shift");
    expect(box.textContent).toBe("按下快捷键…");

    // 带修饰：写入并回显
    press({ code: "KeyK", key: "k", ctrlKey: true, shiftKey: true });
    expect(host.querySelector("#set-hk-italic")!.textContent).toBe("Ctrl+Shift+K");
  });

  it("Meta(Win) 组合当场拒绝，不写进配置", () => {
    goCat(3);
    act(() => host.querySelector<HTMLButtonElement>("#set-hk-italic")!.click());
    press({ code: "KeyJ", key: "j", metaKey: true });
    expect(pane().textContent).toContain("Meta(Win) 键不受支持");
    // 仍在等键状态：按 Esc 取消后应回显原值（没被改写）
    press({ key: "Escape" });
    expect(host.querySelector("#set-hk-italic")!.textContent).toBe("Ctrl+I");
  });

  it("冲突的键位框会被标出来", () => {
    act(() => root.unmount());
    // italic 抢了 save 的默认键 Ctrl+S → 两项都该被标红
    seed({ hotkeys: { ...SEED.hotkeys, italic: "Ctrl+S" } });
    root = createRoot(host);
    act(() => {
      root.render(<SettingsModal />);
    });
    goCat(3);
    expect(host.querySelector("#set-hk-italic")!.className).toContain("bad");
    expect(host.querySelector("#set-hk-save")!.className).toContain("bad");
    expect(pane().textContent).toContain("快捷键冲突");
  });

  it("控件自带键单独一组、只读", () => {
    goCat(3);
    expect(pane().textContent).toContain("控件快捷键（固定）");
    const ro = host.querySelectorAll(".hk-box.ro");
    expect(ro.length).toBeGreaterThan(0);
    expect(ro[0]!.tagName).toBe("SPAN");
  });
});

describe("其余分类", () => {
  // 用户第 4 条：左栏最上方加印章 logo，只有印、不带任何文字。
  it("左栏最上方是印章 logo，且整条左栏没有多余文字", () => {
    const nav = host.querySelector(".set-nav")!;
    const seal = nav.querySelector(".set-nav-seal")!;
    expect(seal).not.toBeNull();
    expect(seal.textContent).toBe("青");
    // 装饰性：不走读屏，也不冒充分类项
    expect(seal.getAttribute("aria-hidden")).toBe("true");
    expect(navs().some((b) => b.contains(seal))).toBe(false);
    expect(nav.firstElementChild).toBe(seal);
    // 左栏文本 = 「青」+ 各分类名，中间**没有**任何附加说明文字
    expect(nav.textContent).toBe("青" + navs().map((b) => b.textContent).join(""));
  });

  it("数据与维护：清除缓存 + 打开缓存目录都在；目录显示为环境变量形态", () => {
    goCat(4);
    const labels = Array.from(pane().querySelectorAll(".modal-btn")).map((b) => b.textContent ?? "");
    expect(labels).toContain("清除翻译缓存");
    expect(labels.some((t) => t.includes("打开缓存目录"))).toBe(true);
    // 用户第 3 条：**不能显示本机绝对路径**——那串里带着本机用户名，换台电脑
    // 看到会以为路径写错了。后端给的是 %APPDATA%\qingbird-md。
    const path = host.querySelector(".set-path")!.textContent!;
    expect(path).toContain("qingbird-md");
    expect(path).not.toMatch(/^[A-Za-z]:[\\/]/); // 不是盘符开头的绝对路径
    expect(path).not.toContain("Users");
  });

  // 用户第 5 条：关于页内容下方加作者仓库入口，先只放 Gitee。
  it("关于页：品牌印 + 版本号 + 作者仓库入口，且没有页脚", async () => {
    const { api } = await import("../lib/ipc");
    const opened: string[] = [];
    const spy = vi.spyOn(api, "openExternal").mockImplementation(async (u: string) => {
      opened.push(u);
    });

    goCat(5);
    expect(host.querySelector(".about-seal")!.textContent).toBe("青");
    expect(host.querySelector(".about-name")!.textContent).toBe("青鸟 Markdown");
    expect(host.querySelector(".about-ver")!.textContent).toMatch(/^v\d+\.\d+\.\d+/);
    expect(host.querySelector(".set-foot")).toBeNull();

    const links = pane().querySelectorAll<HTMLButtonElement>(".about-links button");
    expect(links.length).toBe(1);
    expect(links[0]!.textContent).toContain("Gitee");
    await act(async () => {
      links[0]!.click();
    });
    expect(opened).toEqual(["https://gitee.com/muyan1983/qingbird-md"]);
    spy.mockRestore();
  });

  it("六个分类逐个点开都能渲染出内容，高亮跟着走", () => {
    const markers = ["正文宽度", "配色", "翻译源", "快捷键", "清除翻译缓存", "青鸟 Markdown"];
    markers.forEach((marker, i) => {
      goCat(i);
      expect(navs()[i]!.className).toContain("on");
      expect(host.querySelectorAll(".set-nav-item.on").length).toBe(1);
      expect(pane().textContent).toContain(marker);
    });
  });

  it("设置未加载时不炸，给出提示", () => {
    // 必须重挂：draft 是挂载那一刻的快照，settings 事后变 null 不影响已渲染实例
    act(() => root.unmount());
    useSettingsStore.setState({ settings: null });
    root = createRoot(host);
    act(() => {
      root.render(<SettingsModal />);
    });
    expect(host.textContent).toContain("设置尚未加载");
  });
});
