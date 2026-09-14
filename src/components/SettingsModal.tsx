// T26 设置面板。
//
// 结构（2026-09-14 第三轮改版，按用户逐条反馈）：
//   .set-shell ─┬─ .set-nav（左：大分类）
//               └─ .set-main ─┬─ .set-bar（搜索胶囊 + 关闭叉；分割线只占右栏宽度）
//                             └─ .set-pane（右：详情，自滚）
//   **没有上眉、没有页脚**：标题条与「取消/保存」都去掉了——设置项一律
//   改动即记在草稿里，点右上角叉（或 Esc / 点遮罩）关闭时**自动落盘**。
//   于是「忘了点保存」这种事故从设计上就不存在了。
//
// 两种语义，别混：
//   ① 即时生效类（「外观」页：明暗 / 配色 / 正文宽度）——点即写盘，不进草稿。
//      明暗与配色走 useSettingsStore.save；正文宽度是纯 UI 偏好，走 useUiStore
//      + localStorage（不进 Rust 设置文件）。
//   ② 草稿类（翻译源 / 凭据 / 快捷键 / 划词 / 大模型档案）——改动进本地 draft，
//      关闭时统一落盘。这样后端广播（settings-updated）不会打翻正在编辑的表单。
//
// 保命细节（saveAndClose 里）：draft 是打开弹窗那一刻的快照，里面也带着旧的
// theme/palette。若整包写回，用户「先切配色 → 再关闭」就会把旧配色覆盖回去。
// 所以落盘时这两项一律取 store 的当前值。
//
// 安全：凭据输入框一律 password 型（secret 字段），绝不打印 / toast 任何载荷。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  Database,
  ExternalLink,
  FolderOpen,
  Info,
  Keyboard,
  Languages,
  Palette as PaletteIcon,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib/ipc";
import type { LlmProfile, ProviderInfo, Settings } from "../types/ipc";
import { isDarkTheme, useSettingsStore, type Theme } from "../stores/useSettingsStore";
import { PALETTES, PALETTE_IDS, paletteSwatch } from "../lib/paletteSeeds";
import { allowsBare, keyName } from "../lib/hotkeys";
import {
  FIXED_HOTKEYS,
  HOTKEYS,
  HOTKEY_GROUPS,
  defaultHotkeys,
  effectiveHotkeys,
  findConflicts,
} from "../lib/hotkeyRegistry";
import {
  CONTENT_WIDTHS,
  CONTENT_WIDTH_LABEL,
  errText,
  useUiStore,
} from "../stores/useUiStore";

/** 关于页的作者仓库入口。先只放 Gitee（用户要求）；GitHub 与「检查更新」
 *  后续按同样的形状加进 `.about-links` 那一行即可。
 *  链接交给 `api.openExternal`（Rust 侧 open_external 会做协议白名单校验）。 */
const AUTHOR_REPO = {
  label: "作者仓库 · Gitee",
  url: "https://gitee.com/muyan1983/qingbird-md",
};

const THEME_OPTIONS: Array<[Theme, string]> = [
  ["light", "浅色"],
  ["dark", "深色"],
  ["auto", "跟随系统"],
];

/** 左栏大分类。id 同时也是「当前页」的唯一键。 */
type CatId = "look" | "translate" | "reading" | "data" | "about";

const CATS: Array<{ id: CatId; label: string; icon: typeof PaletteIcon; keys: string[] }> = [
  {
    id: "look",
    label: "外观",
    icon: PaletteIcon,
    keys: ["明暗", "主题", "深浅", "系统", "配色", "纸色", "正文宽度", "宽度", "语种"],
  },
  {
    id: "translate",
    label: "翻译与模型",
    icon: Languages,
    keys: [
      "翻译源", "引擎", "免费", "专业", "llm", "大模型", "模型", "凭据",
      "密钥", "api", "地址", "配置", "档案", "划词", "连接测试", "测试",
    ],
  },
  {
    id: "reading",
    label: "快捷键",
    icon: Keyboard,
    keys: ["快捷键", "按键", "组合键", "hotkey", "恢复默认"],
  },
  {
    id: "data",
    label: "数据与维护",
    icon: Database,
    keys: ["缓存", "数据", "目录", "清理", "维护", "存储"],
  },
  { id: "about", label: "关于", icon: Info, keys: ["关于", "版本", "说明"] },
];

/** 翻译源三分组。分组**不写死在后端**：按 DTO 现成字段推——
 *  llm 单列，其余「要密钥 = 专业源 / 不要密钥 = 免费源」，后端以后加源自动归位，
 *  不会出现「注册表加了、前端漏分组」的两处同步问题。 */
type ProvGroup = "free" | "pro" | "llm";

const PROV_GROUPS: Array<[ProvGroup, string]> = [
  ["free", "免费源"],
  ["pro", "专业源"],
  ["llm", "LLM大模型"],
];

function groupOf(m: ProviderInfo): ProvGroup {
  if (m.key === "llm") return "llm";
  return m.needs_key ? "pro" : "free";
}

/** 大模型接口协议。**只有 OpenAI 兼容这一种真能用**；Anthropic 先占位。
 *
 *  用户明确要求「先摆出来，后期再支持」，所以是**禁用**而不是不渲染——看得见
 *  才知道有这条路。真正的实现点在 `providers_meta.rs` 的 LLM_FIELDS 与请求构造
 *  （OpenAI 走 /chat/completions、Anthropic 走 /v1/messages 且鉴权头不同），
 *  将来支持时别只把这里的 supported 翻成 true。
 *
 *  为什么放在这里而不是继续用下拉框：LLM 组里注册表只有一个源，单选项下拉是
 *  伪选择；协议才是这一栏真正的选择维度。 */
const LLM_PROTOCOLS: Array<{ id: string; label: string; supported: boolean }> = [
  { id: "openai", label: "OpenAI 兼容", supported: true },
  { id: "anthropic", label: "Anthropic 兼容", supported: false },
];

/** LLM 厂商预设：**只用来「新建配置」时填初值**，不再是一个并行的下拉。
 *  （改版前它是个「厂商预设」下拉，选中即覆盖 baseUrl 那一份凭据——于是
 *   自定义只能存一套、再选预设就被冲掉。现在预设是「模板」，配置本身可存多套。） */
const LLM_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-flash", "qwen-plus", "qwen-max"] },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3-flash", "glm-4.7-flash", "glm-5.3"] },
  { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", models: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"] },
  { name: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] },
];

const LLM_CRED_KEYS = ["baseUrl", "apiKey", "model", "lookup_model"] as const;

/** 配置档案 id：时间戳 + 随机后缀，与内容无关（改名不改 id）。 */
function newProfileId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function profileFromCreds(id: string, name: string, creds: Record<string, string>): LlmProfile {
  return {
    id,
    name,
    base_url: creds.baseUrl ?? "",
    api_key: creds.apiKey ?? "",
    model: creds.model ?? "",
    lookup_model: creds.lookup_model ?? "",
    models: [],
  };
}

/** 档案 → 凭据槽（流水线只认 providers["llm"] 这一份，档案是「攒下来的几套」）。 */
function credsFromProfile(p: LlmProfile): Record<string, string> {
  return {
    baseUrl: p.base_url,
    apiKey: p.api_key,
    model: p.model,
    lookup_model: p.lookup_model,
  };
}

/** 把当前凭据槽写回档案（关闭弹窗与「保存此配置」都走这条路，避免两处口径）。 */
function withCredsInProfile(list: LlmProfile[], id: string, creds: Record<string, string>): LlmProfile[] {
  return list.map((p) =>
    p.id === id
      ? {
          ...p,
          base_url: creds.baseUrl ?? "",
          api_key: creds.apiKey ?? "",
          model: creds.model ?? "",
          lookup_model: creds.lookup_model ?? "",
        }
      : p,
  );
}

export default function SettingsModal() {
  const close = useUiStore((s) => s.closeSettings);
  const live = useSettingsStore((s) => s.settings);

  // ---- 即时生效类：全部直读 store（不做草稿），点即落盘 ----
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const palette = useSettingsStore((s) => s.palette);
  const setPalette = useSettingsStore((s) => s.setPalette);
  const contentWidth = useUiStore((s) => s.contentWidth);
  const customWidth = useUiStore((s) => s.customWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);

  // ---- 导航 + 搜索 ----
  const [cat, setCat] = useState<CatId>("look");
  const [query, setQuery] = useState("");

  // ---- 草稿类状态 ----
  const [draft, setDraft] = useState<Settings | null>(() =>
    live ? { ...live, providers: { ...live.providers } } : null,
  );
  const [formProvider, setFormProvider] = useState(() => live?.provider ?? "");
  const [formCreds, setFormCreds] = useState<Record<string, string>>(() =>
    live ? (live.providers[live.provider] ?? {}) : {},
  );
  const [metas, setMetas] = useState<ProviderInfo[]>([]);
  const [grp, setGrp] = useState<ProvGroup>("free");
  // 色卡的预览档：默认跟随当前明暗，也可手动翻到另一档先看效果
  const [pvMode, setPvMode] = useState<"light" | "dark">(() =>
    isDarkTheme() ? "dark" : "light",
  );
  const [recording, setRecording] = useState<string | null>(null);
  const [hkMsg, setHkMsg] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [llmMsg, setLlmMsg] = useState("");
  const [fetching, setFetching] = useState(false);
  const [dataDir, setDataDir] = useState("");
  // 给人看的那份（`%APPDATA%\qingbird-md`）。**不要拿它去开目录**。
  const [dirLabel, setDirLabel] = useState("");

  // 关闭时要用「最新」的草稿/表单（onClose 的依赖不能跟着每次按键变，
  // 否则 Modal 的 Esc 监听每次渲染都重订阅）。ref 每轮渲染刷新一次即可。
  const latest = useRef({ draft, formProvider, formCreds });
  latest.current = { draft, formProvider, formCreds };

  // 理论竞态兜底：设置尚未加载完就打开弹窗（live 到达后补种草稿一次）
  useEffect(() => {
    if (live && !draft) {
      setDraft({ ...live, providers: { ...live.providers } });
      setFormProvider(live.provider);
      setFormCreds(live.providers[live.provider] ?? {});
    }
  }, [live, draft]);

  // 切明暗时色卡预览跟着走（手动翻档只在明暗没动时保留）
  useEffect(() => {
    setPvMode(isDarkTheme() ? "dark" : "light");
  }, [theme]);

  // 翻译源元数据（label/note/fields）来自后端注册表，打开时拉一次
  useEffect(() => {
    let alive = true;
    api
      .getProviders()
      .then((m) => {
        if (alive) setMetas(m);
      })
      .catch((e) => {
        if (alive) useUiStore.getState().addToast("error", `读取翻译源失败：${errText(e)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 分组跟着当前翻译源走：元数据到达或换源后归位（组内换源时是空操作，
  // setState 同值直接被 React 跳过，不会多渲染）。
  useEffect(() => {
    const m = metas.find((x) => x.key === formProvider);
    if (m) setGrp(groupOf(m));
  }, [metas, formProvider]);

  // 数据目录（设置 / 翻译缓存 / 凭据同处一室）：打开弹窗时拉一次。
  // 取两份**用途不同**的值，别互相顶替：
  //   userDataDir()  绝对路径 —— 「打开缓存目录」的跳转目标（喂给 revealPath）
  //   dataDirLabel() 显示形态 —— 只写进提示文案（`%APPDATA%\qingbird-md`）
  // 显示不用绝对路径的原因：那串路径里带着**本机的用户名**，用户看到会以为路径
  // 被写死在配置里、换台电脑就不对了。两个请求互不依赖，一起发出、各自失败各自静默。
  useEffect(() => {
    let alive = true;
    api
      .userDataDir()
      .then((d) => {
        if (alive) setDataDir(d);
      })
      .catch(() => {
        /* 拿不到就只藏路径那一行，按钮仍走后端现取，不必打扰用户 */
      });
    api
      .dataDirLabel()
      .then((d) => {
        if (alive) setDirLabel(d);
      })
      .catch(() => {
        /* 同上：拿不到就整行不显示，不影响其它功能 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 老用户升级迁移：本版之前大模型凭据只存在 providers["llm"] 一份，
  // 没有「档案」概念。首次打开且档案库为空时，把它收编成一套档案——
  // 否则界面上会显示「还没有配置」，看着像配置丢了（其实还在用着）。
  // 收编后写入 draft（关闭时才落盘），不改用户已有的翻译行为。
  //
  // **一次性闩**（migrated）：不能只看「档案库为空」——用户把最后一套配置删掉时
  // 档案库同样为空，而 providers["llm"] 那一刻还在，无闩就会**把刚删掉的配置
  // 原样复活**（真踩过：删了又出现，看着像删除失效）。
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || !draft) return;
    if (draft.llm_profiles.length > 0) {
      migrated.current = true;
      return;
    }
    const c = draft.providers.llm ?? {};
    if (!LLM_CRED_KEYS.some((k) => (c[k] ?? "").trim() !== "")) {
      migrated.current = true;
      return;
    }
    migrated.current = true;
    const profile = profileFromCreds("p-migrated", "原有配置", c);
    setDraft((d) => (d ? { ...d, llm_profiles: [profile], llm_active: profile.id } : d));
  }, [draft]);

  const meta = metas.find((m) => m.key === formProvider) ?? null;
  const isLlm = formProvider === "llm";
  const profiles = draft?.llm_profiles ?? [];
  const activeId = draft?.llm_active ?? "";
  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

  const eff = useMemo(() => effectiveHotkeys(draft?.hotkeys), [draft?.hotkeys]);
  const conflicts = useMemo(() => findConflicts(eff), [eff]);

  /** 关窗前统一落盘（这就是「取消/保存」两个按钮的替代品）。 */
  const saveAndClose = useCallback(() => {
    const { draft: d, formProvider: fp, formCreds: fc } = latest.current;
    if (d) {
      // theme / palette 是「点即生效」字段：以 store 的当前值为准（用户可能刚在
      // 「外观」页点过配色，而 draft 是打开弹窗时的旧快照）。不这样覆盖的话，
      // 「切了配色 → 关窗」会把旧配色写回盘。
      const cur = useSettingsStore.getState().settings;
      // 当前这栏凭据顺手写回它对应的档案（用户可能改了字段却直接关窗）
      const llmProfiles = d.llm_active
        ? withCredsInProfile(d.llm_profiles, d.llm_active, fc)
        : d.llm_profiles;
      const next: Settings = {
        ...d,
        theme: cur?.theme ?? d.theme,
        palette: cur?.palette ?? d.palette,
        provider: fp,
        providers: { ...d.providers, [fp]: fc },
        llm_profiles: llmProfiles,
      };
      // store.save：乐观写 + 失败回滚 + toast，不必等它（关窗不该让用户等 I/O）
      void useSettingsStore.getState().save(next);
    }
    close();
  }, [close]);

  // 快捷键录制：capture 阶段吃掉全部按键（含 Esc——壳层按 defaultPrevented
  // 让路）；修饰顺序固定 Ctrl/Alt/Shift，与 Rust hotkey_combo 口径一致。
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        setRecording(null);
        setHkMsg("已取消录制");
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (!e.ctrlKey && e.metaKey) parts.push("Meta");
      const name = keyName(e);
      if (!name) return; // 非白名单键（方向键等）：继续等
      if (parts.includes("Meta")) {
        // 录进去也注册不上（Win 键被系统大量占用，Rust registrable 显式拒绝），
        // 与其存下来当摆设，不如当场说清楚。
        setHkMsg("Meta(Win) 键不受支持，请改用 Ctrl / Alt / Shift");
        return;
      }
      if (parts.length === 0 && !allowsBare(name)) {
        setHkMsg(`${name} 需要配合 Ctrl / Alt / Shift 使用`);
        return;
      }
      const combo = [...parts, name].join("+");
      setDraft((d) => (d ? { ...d, hotkeys: { ...d.hotkeys, [recording]: combo } } : d));
      setRecording(null);
      setHkMsg(`已设置「${HOTKEYS.find((h) => h.id === recording)?.label ?? recording}」为 ${combo}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const resetHotkeys = () => {
    setDraft((d) => (d ? { ...d, hotkeys: defaultHotkeys() } : d));
    setHkMsg("已恢复出厂快捷键");
  };

  const changeProvider = (k: string) => {
    setFormProvider(k);
    // 切回大模型时若无生效档案但有历史凭据，仍以 providers 里的那份为准
    setFormCreds(draft?.providers[k] ?? {});
    setTestResult("");
    setLlmMsg("");
  };

  /** 切分组：直接选中该组第一个源（凭据/连接测试都跟着它走）。
   *  组内没有源时不动——否则高亮分到空组、下方列表却还是旧源，看着像坏了。 */
  const changeGroup = (g: ProvGroup) => {
    const first = metas.find((m) => groupOf(m) === g);
    if (!first) return;
    changeProvider(first.key);
    setGrp(g);
  };

  // ── 大模型配置档案 ──

  /** 选中一套档案：值灌进凭据栏，流水线立刻用它（providers["llm"] 关窗时落盘）。 */
  const useProfile = (p: LlmProfile) => {
    if (!draft) return;
    setFormProvider("llm");
    setFormCreds(credsFromProfile(p));
    setDraft((d) => (d ? { ...d, llm_active: p.id } : d));
    setLlmMsg(`已切换到「${p.name}」`);
    setTestResult("");
  };

  /** 从预设（或空白）新建一套档案并立刻启用。 */
  const createProfile = (presetUrl: string) => {
    if (!draft) return;
    const preset = LLM_PRESETS.find((p) => p.baseUrl === presetUrl);
    const id = newProfileId();
    const profile: LlmProfile = {
      id,
      name: preset ? preset.name : `配置 ${draft.llm_profiles.length + 1}`,
      base_url: preset?.baseUrl ?? "",
      api_key: "",
      model: preset?.models[0] ?? "",
      lookup_model: "",
      models: [],
    };
    setDraft((d) => (d ? { ...d, llm_profiles: [...d.llm_profiles, profile], llm_active: id } : d));
    setFormProvider("llm");
    setFormCreds(credsFromProfile(profile));
    setLlmMsg(`已新建「${profile.name}」，填好凭据后点「保存此配置」`);
    setTestResult("");
  };

  /** 改名：自定义 ID 名就是给人认的，随时可改。 */
  const renameProfile = (id: string, name: string) => {
    setDraft((d) =>
      d ? { ...d, llm_profiles: d.llm_profiles.map((p) => (p.id === id ? { ...p, name } : p)) } : d,
    );
  };

  const deleteProfile = (id: string) => {
    setDraft((d) => {
      if (!d) return d;
      const rest = d.llm_profiles.filter((p) => p.id !== id);
      return {
        ...d,
        llm_profiles: rest,
        llm_active: d.llm_active === id ? "" : d.llm_active,
      };
    });
    if (activeId === id) {
      setFormProvider("llm");
      setFormCreds({});
      setLlmMsg("已删除当前配置");
    } else {
      setLlmMsg("已删除该配置");
    }
  };

  /** 「保存此配置」：字段写回档案并**立刻落盘**（不等关窗）——用户明确要
   *  一个「我就是要现在存下来」的动作，给一个不心虚的按钮。 */
  const saveProfile = async () => {
    const d = latest.current.draft;
    if (!d) return;
    let next: Settings;
    if (d.llm_active) {
      next = { ...d, llm_profiles: withCredsInProfile(d.llm_profiles, d.llm_active, formCreds) };
    } else {
      // 没有生效档案（比如删光了又直接填了字段）：按「另存为新配置」处理，
      // 免得用户以为保存了、其实什么都没落下。
      const profile = profileFromCreds(newProfileId(), `配置 ${d.llm_profiles.length + 1}`, formCreds);
      next = { ...d, llm_profiles: [...d.llm_profiles, profile], llm_active: profile.id };
    }
    next = { ...next, provider: formProvider, providers: { ...next.providers, [formProvider]: formCreds } };
    setDraft(next);
    await useSettingsStore.getState().save(next);
    setLlmMsg("配置已保存");
  };

  const testConn = async () => {
    setTesting(true);
    setTestResult("测试中…");
    try {
      const out = await api.translateText("Hello, this is a translation test.", formProvider, formCreds);
      setTestResult(`成功：${out}`);
    } catch (e) {
      setTestResult(`失败：${errText(e)}`);
    } finally {
      setTesting(false);
    }
  };

  /** 拉取 OpenAI 兼容 /models。结果**写进当前档案并持久化**（重启后还能选），
   *  所以换机器/重启都不必重新拉。没选中档案时只作临时候选，提示先存配置。 */
  const fetchModels = async () => {
    const baseUrl = (formCreds.baseUrl ?? "").trim();
    if (!baseUrl) {
      setLlmMsg("请先填写 API 地址 (Base URL)");
      return;
    }
    // 有没有生效档案决定这份清单能不能长期留下：没有档案就没有落盘的地方，
    // 提示里要说清楚，免得用户以为拉过一次就永远都在。
    const persist = !!latest.current.draft?.llm_active;
    setFetching(true);
    try {
      const list = await api.llmListModels(baseUrl, formCreds.apiKey ?? "");
      setDraft((d) =>
        d
          ? {
              ...d,
              llm_profiles: d.llm_profiles.map((p) =>
                p.id === d.llm_active ? { ...p, models: list } : p,
              ),
            }
          : d,
      );
      setLlmMsg(
        persist
          ? `已拉取 ${list.length} 个模型并存入当前配置，模型名输入框可直接下拉选择。`
          : `已拉取 ${list.length} 个模型；当前没有生效配置，先「存为新配置」才会长期保存。`,
      );
    } catch (e) {
      setLlmMsg(`拉取失败：${errText(e)}（仍可手动填写模型名）`);
    } finally {
      setFetching(false);
    }
  };

  // 缓存清理用 toast 报结果（本页没有可用的提示行）
  const clearCache = async () => {
    try {
      await api.clearCache();
      useUiStore.getState().addToast("success", "翻译缓存已清除");
    } catch (e) {
      useUiStore.getState().addToast("error", `清除缓存失败：${errText(e)}`);
    }
  };

  /** 在资源管理器中打开数据目录（缓存文件 qingbird-cache.json 就在里面）。
   *  reveal_path 对目录是「直接打开」语义；路径不存在由后端报错，这里只转 toast。 */
  const openCacheDir = async () => {
    try {
      const dir = dataDir || (await api.userDataDir());
      await api.revealPath(dir);
    } catch (e) {
      useUiStore.getState().addToast("error", `打开缓存目录失败：${errText(e)}`);
    }
  };

  // ── 搜索过滤（分类级）──
  const visibleCats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATS;
    return CATS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.keys.some((k) => k.toLowerCase().includes(q)),
    );
  }, [query]);
  const activeCat = visibleCats.some((c) => c.id === cat) ? cat : (visibleCats[0]?.id ?? cat);

  const modelOptions = useMemo(() => {
    const saved = activeProfile?.models ?? [];
    const preset = LLM_PRESETS.find(
      (p) => p.baseUrl.replace(/\/+$/, "") === (formCreds.baseUrl ?? "").trim().replace(/\/+$/, ""),
    );
    return Array.from(new Set([...saved, ...(preset?.models ?? [])]));
  }, [activeProfile, formCreds.baseUrl]);

  if (!draft) {
    return (
      <Modal onClose={saveAndClose} size="lg" ariaLabel="设置">
        <div className="set-shell">
          <div className="set-main">
            <Bar query={query} setQuery={setQuery} onClose={saveAndClose} />
            <div className="set-pane">
              <div className="modal-note">设置尚未加载。</div>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={saveAndClose} size="lg" ariaLabel="设置">
      <div className="set-shell">
        {/* ── 左：大分类 ── */}
        <nav className="set-nav" aria-label="设置分类">
          {/* 印章 logo：全应用统一的朱砂「青」印（标题栏 / 欢迎页 / 关于页同款）。
              只放印本身，旁边不加任何文字（用户要求「就光 logo 不用写什么字」）。 */}
          <div className="set-nav-seal" aria-hidden>
            青
          </div>
          {visibleCats.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`set-nav-item${activeCat === id ? " on" : ""}`}
              aria-current={activeCat === id ? "page" : undefined}
              onClick={() => {
                // 离开这一页就清掉本页的临时反馈（提示行同时被「连接测试」与
                // 「快捷键录制」用，不清就会串场到另一页）；顺带收掉进行中的录制，
                // 免得录到一半切页、结果落在别的页面上。
                setRecording(null);
                setHkMsg("");
                setTestResult("");
                setLlmMsg("");
                setCat(id);
              }}
            >
              <Icon className="set-nav-ico" size={15} />
              {label}
            </button>
          ))}
          {visibleCats.length === 0 && <div className="set-nav-empty">没有匹配的设置项</div>}
        </nav>

        {/* ── 右：工具条 + 详情 ── */}
        <div className="set-main">
          <Bar query={query} setQuery={setQuery} onClose={saveAndClose} />

          <div className="set-pane">
            {visibleCats.length === 0 && (
              <div className="set-empty">没有找到与「{query.trim()}」相关的设置项。</div>
            )}

            {activeCat === "look" && (
              <>
                <section className="set-sec">
                  <h3 className="set-sec-title">明暗</h3>
                  <p className="set-sec-desc">「跟随系统」会随操作系统的浅色/深色外观实时切换。</p>
                  <div className="setseg">
                    {THEME_OPTIONS.map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        className={theme === v ? "on" : ""}
                        onClick={() => setTheme(v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="set-sec">
                  <h3 className="set-sec-title">配色</h3>
                  <p className="set-sec-desc">
                    纸色与彩头成套切换，朱砂印保持不变。卡上的小样就是该配色真实的纸面、
                    侧栏、彩头与朱砂。
                  </p>
                  <div className="setseg sm">
                    <button
                      type="button"
                      className={pvMode === "light" ? "on" : ""}
                      onClick={() => setPvMode("light")}
                    >
                      浅色预览
                    </button>
                    <button
                      type="button"
                      className={pvMode === "dark" ? "on" : ""}
                      onClick={() => setPvMode("dark")}
                    >
                      深色预览
                    </button>
                  </div>
                  <div className="pal-grid">
                    {PALETTE_IDS.map((id) => {
                      const p = PALETTES[id];
                      const t = p[pvMode];
                      const on = palette === id;
                      const pv = {
                        "--pv-bg": t.bg,
                        "--pv-bg2": t.bg2,
                        "--pv-border": t.border,
                        "--pv-fg": t.fg,
                        "--pv-accent": t.accent,
                        "--pv-zhu": t.zhu,
                        "--pv-surface": t.surface,
                      } as CSSProperties;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`pal-card${on ? " on" : ""}`}
                          aria-pressed={on}
                          onClick={() => setPalette(id)}
                        >
                          <Check className="pal-check" size={14} strokeWidth={3} />
                          <div className="pal-preview" style={pv}>
                            <div className="side">
                              <span className="dot" />
                              <span className="seal" />
                            </div>
                            <div className="body">
                              <span className="ln" />
                              <span className="ln dim" />
                              <div className="row">
                                <i className="a" />
                                <i className="z" />
                                <i className="s" />
                              </div>
                            </div>
                          </div>
                          <div className="pal-card-head">
                            <span className="pal-card-short">{p.short}</span>
                            <span className="pal-card-name">{p.label}</span>
                          </div>
                          <div className="pal-swatches">
                            {paletteSwatch(id, pvMode).map((c, i) => (
                              <i key={i} style={{ background: c }} />
                            ))}
                          </div>
                          <div className="pal-card-note">{p.note}</div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="set-sec">
                  <h3 className="set-sec-title">正文宽度</h3>
                  <p className="set-sec-desc">
                    预览区正文列的宽度。也可以直接拖预览区的边缘自由调宽。
                  </p>
                  <div className="setseg">
                    {CONTENT_WIDTHS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={customWidth === null && contentWidth === w ? "on" : ""}
                        onClick={() => setContentWidth(w)}
                      >
                        {CONTENT_WIDTH_LABEL[w]}
                      </button>
                    ))}
                  </div>
                  {customWidth !== null && (
                    <div className="set-hint">
                      <Info size={13} />
                      <span>
                        当前是拖拽得到的自由宽度 {customWidth}px。
                        <button
                          type="button"
                          className="set-link"
                          onClick={() => setContentWidth(contentWidth)}
                        >
                          恢复为「{CONTENT_WIDTH_LABEL[contentWidth]}」档
                        </button>
                      </span>
                    </div>
                  )}
                </section>
              </>
            )}

            {activeCat === "translate" && (
              <>
                <section className="set-sec">
                  <h3 className="set-sec-title">翻译源</h3>
                  <p className="set-sec-desc">
                    按来源分三类：免密钥的可以直接用，专业源与大模型需要填自己的凭据。
                  </p>
                  <div className="setseg">
                    {PROV_GROUPS.map(([g, label]) => (
                      <button
                        key={g}
                        type="button"
                        className={grp === g ? "on" : ""}
                        onClick={() => changeGroup(g)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* LLM 组的下拉是**伪选择**——注册表里这一组只有 `llm` 一个源，
                      选项永远只有一项。这里真正要选的是「接口协议」，所以换成胶囊；
                      其余组源多，照旧用下拉。 */}
                  {grp === "llm" ? (
                    <div className="set-field">
                      <label>接口协议</label>
                      <div className="setseg" role="group" aria-label="接口协议">
                        {LLM_PROTOCOLS.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            className={p.supported ? "on" : ""}
                            disabled={!p.supported}
                            title={p.supported ? undefined : "暂未支持，后续版本再考虑"}
                          >
                            {p.label}
                            {!p.supported && <span className="setseg-tag">暂未支持</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="set-field">
                      <label htmlFor="set-provider">翻译源</label>
                      <select
                        id="set-provider"
                        value={formProvider}
                        onChange={(e) => changeProvider(e.target.value)}
                      >
                        {metas
                          .filter((m) => groupOf(m) === grp)
                          .map((m) => (
                            <option key={m.key} value={m.key}>
                              {m.label}
                            </option>
                          ))}
                        {/* 注册表还没到（或该源已下线）时兜底，别让下拉空着 */}
                        {!metas.some((m) => m.key === formProvider && groupOf(m) === grp) && (
                          <option value={formProvider}>{formProvider}</option>
                        )}
                      </select>
                    </div>
                  )}
                  {meta && (
                    <div className="set-hint">
                      <Info size={13} />
                      <span>{meta.note}</span>
                    </div>
                  )}
                </section>

                {/* ── 大模型配置档案（只有 llm 源才出现）── */}
                {isLlm && (
                  <section className="set-sec">
                    <div className="set-head-row">
                      <div>
                        <h3 className="set-sec-title">配置档案</h3>
                        <p className="set-sec-desc">
                          可以攒任意多套（云端 / 本地各一份都行），点一下即可切换；删除只影响这里，
                          不动磁盘上别的东西。
                        </p>
                      </div>
                      <select
                        id="set-llm-new"
                        className="set-mini-select"
                        value=""
                        aria-label="新建配置"
                        onChange={(e) => {
                          if (e.target.value !== "") createProfile(e.target.value);
                          e.target.value = "";
                        }}
                      >
                        <option value="">＋ 新建配置…</option>
                        <option value="@blank">空白配置</option>
                        {LLM_PRESETS.map((p) => (
                          <option key={p.baseUrl} value={p.baseUrl}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {profiles.length === 0 ? (
                      <div className="set-hint">
                        <Info size={13} />
                        <span>还没有配置。用右上角「新建配置」从预设开一套，或直接填下面的字段后「存为新配置」。</span>
                      </div>
                    ) : (
                      <div className="prof-list">
                        {profiles.map((p) => (
                          <div
                            key={p.id}
                            className={`prof${p.id === activeId ? " on" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => useProfile(p)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                useProfile(p);
                              }
                            }}
                          >
                            <div className="prof-main">
                              <input
                                className="prof-name"
                                value={p.name}
                                aria-label="配置名称"
                                placeholder="给这套配置起个名"
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => renameProfile(p.id, e.target.value)}
                              />
                              <div className="prof-sub">
                                {p.base_url || "未填 API 地址"}
                                {p.model ? ` · ${p.model}` : ""}
                                {p.models.length > 0 ? ` · 已存 ${p.models.length} 个模型` : ""}
                              </div>
                            </div>
                            {p.id === activeId && <span className="prof-tag">使用中</span>}
                            <button
                              type="button"
                              className="prof-del"
                              title="删除这套配置"
                              aria-label={`删除配置 ${p.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteProfile(p.id);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}

                {meta && meta.fields.length > 0 && (
                  <section className="set-sec">
                    <div className="set-head-row">
                      <div>
                        <h3 className="set-sec-title">凭据</h3>
                        <p className="set-sec-desc">
                          只保存在本机配置文件里；密钥输入框不回显明文。
                        </p>
                      </div>
                      {isLlm && (
                        <button type="button" className="modal-btn" onClick={() => void saveProfile()}>
                          {activeProfile ? "保存此配置" : "存为新配置"}
                        </button>
                      )}
                    </div>
                    {meta.fields.map((f) => {
                      const isModelField = isLlm && (f.key === "model" || f.key === "lookup_model");
                      return (
                        <div className="set-field" key={f.key}>
                          <label htmlFor={`set-f-${f.key}`}>{f.label}</label>
                          <input
                            id={`set-f-${f.key}`}
                            type={f.secret ? "password" : "text"}
                            value={formCreds[f.key] ?? ""}
                            placeholder={f.placeholder}
                            title={f.placeholder}
                            autoComplete="off"
                            list={isModelField ? "llm-model-list" : undefined}
                            onChange={(e) =>
                              setFormCreds((c) => ({ ...c, [f.key]: e.target.value }))
                            }
                          />
                          {isModelField && (
                            <button
                              type="button"
                              className="modal-btn set-ico"
                              disabled={fetching}
                              onClick={() => void fetchModels()}
                            >
                              <RefreshCw size={13} />
                              {fetching ? "拉取中…" : "拉取模型"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {isLlm && (
                      <datalist id="llm-model-list">
                        {modelOptions.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    )}
                    {isLlm && llmMsg && <div className="modal-test">{llmMsg}</div>}
                  </section>
                )}

                {/* 划词翻译归在本页（它复用上面这份翻译凭据，和快捷键不是一类事） */}
                <section className="set-sec">
                  <SwitchRow
                    label="划词翻译"
                    desc="预览区选中文字后就地弹出译文。"
                    checked={draft.selection_translate}
                    onChange={(v) =>
                      setDraft((d) => (d ? { ...d, selection_translate: v } : d))
                    }
                  />
                </section>

                <section className="set-sec">
                  <div className="setti">
                    <div className="setti-info">
                      <div className="setti-label">连接测试</div>
                      <div className="setti-desc">用一句话试翻，确认地址与密钥可用。</div>
                    </div>
                    <div className="setti-ctl">
                      <button
                        type="button"
                        className="modal-btn"
                        disabled={testing}
                        onClick={() => void testConn()}
                      >
                        {testing ? "测试中…" : "测试连接"}
                      </button>
                    </div>
                  </div>
                  {testResult && <div className="modal-test">{testResult}</div>}
                </section>
              </>
            )}

            {activeCat === "reading" && (
              <>
                <div className="set-head-row">
                  <div>
                    <h3 className="set-sec-title">快捷键</h3>
                    {/* 这行与「恢复默认」同行（.set-head-row），**必须压在一行内**：
                        长了会把按钮挤成两行、整块变肥大（用户反馈）。被拒的按法
                        当场就有提示，规则不必在这里讲全。 */}
                    <p className="set-sec-desc">点键位框后直接按组合键，Esc 取消。</p>
                  </div>
                  <button type="button" className="modal-btn" onClick={resetHotkeys}>
                    恢复默认
                  </button>
                </div>
                {hkMsg && <div className="modal-test">{hkMsg}</div>}
                {conflicts.size > 0 && (
                  <div className="set-warn">
                    有 {conflicts.size} 项快捷键冲突：同一组合被多个功能占用，生效时以列表靠前的为准。
                  </div>
                )}

                {HOTKEY_GROUPS.map(([g, title]) => {
                  const rows = HOTKEYS.filter((h) => h.group === g);
                  if (rows.length === 0) return null;
                  return (
                    <section className="set-sec" key={g}>
                      <h4 className="set-grp">{title}</h4>
                      {rows.map((h) => (
                        <div className="setti" key={h.id}>
                          <div className="setti-info">
                            <div className="setti-label">{h.label}</div>
                            {h.global && (
                              <div className="setti-desc">全局生效，程序未聚焦也能用</div>
                            )}
                          </div>
                          <div className="setti-ctl">
                            <button
                              type="button"
                              id={`set-hk-${h.id}`}
                              className={`hk-box${recording === h.id ? " rec" : ""}${
                                conflicts.has(h.id) ? " bad" : ""
                              }`}
                              aria-label={`${h.label} 快捷键`}
                              onClick={() => {
                                setHkMsg("");
                                setRecording(h.id);
                              }}
                            >
                              {recording === h.id ? "按下快捷键…" : eff[h.id] || "未设置"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </section>
                  );
                })}

                <section className="set-sec">
                  <h4 className="set-grp">控件快捷键（固定）</h4>
                  <p className="set-sec-desc">
                    由控件自身处理，不参与自定义——这类键要跟着「当前选中哪一行/哪段文字」走，
                    重绑只会让它们在该生效的地方失效。
                  </p>
                  {FIXED_HOTKEYS.map((f) => (
                    <div className="setti" key={f.label}>
                      <div className="setti-info">
                        <div className="setti-label">{f.label}</div>
                      </div>
                      <div className="setti-ctl">
                        <span className="hk-box ro">{f.keys}</span>
                      </div>
                    </div>
                  ))}
                </section>
              </>
            )}

            {activeCat === "data" && (
              <>
                <section className="set-sec">
                  <div className="setti">
                    <div className="setti-info">
                      <div className="setti-label">翻译缓存</div>
                      <div className="setti-desc">
                        译文按「内容 + 模型 + 提示词版本」哈希缓存，重复段落秒回；清空后下次翻译重新请求。
                      </div>
                    </div>
                    <div className="setti-ctl">
                      <button type="button" className="modal-btn" onClick={() => void clearCache()}>
                        清除翻译缓存
                      </button>
                      <button
                        type="button"
                        className="modal-btn set-ico"
                        onClick={() => void openCacheDir()}
                      >
                        <FolderOpen size={13} />
                        打开缓存目录
                      </button>
                    </div>
                  </div>
                  <div className="setti">
                    <div className="setti-info">
                      <div className="setti-label">数据存放</div>
                      <div className="setti-desc">
                        文档、翻译缓存与接口凭据全部留在本机用户目录，不上传任何服务器；
                        只有翻译请求会发往你自己配置的接口。
                      </div>
                    </div>
                  </div>
                  {/* 显示用的是「环境变量形态」（%APPDATA%\qingbird-md）而不是绝对路径：
                      绝对路径里带着本机用户名，换台电脑看到会以为路径不对。实际路径
                      是每次启动现算的，本来就不会错——这里改的是**观感**。 */}
                  {dirLabel && (
                    <div className="set-hint">
                      <Info size={13} />
                      <span>
                        数据目录：<span className="set-path">{dirLabel}</span>
                        （缓存文件 <span className="set-path">qingbird-cache.json</span> 就在里面）
                      </span>
                    </div>
                  )}
                </section>
              </>
            )}

            {activeCat === "about" && (
              /* 排版对齐欢迎页：居中一列（.about-wrap 负责整块在详情栏里垂直居中） */
              <div className="about-wrap">
                <div className="about-inner">
                  <div className="about-seal" aria-hidden>
                    青
                  </div>
                  <div className="about-name">青鸟 Markdown</div>
                  <div className="about-ver">v{__APP_VERSION__} · Tauri + React</div>
                  <p className="about-desc">
                    本地优先的 Markdown 阅读与翻译工具：流式译文边出边看，
                    分段对照，代码块与表格原样保留。
                  </p>
                  {/* 仓库入口在内容下方、居中。将来加 GitHub / 检查更新就并排加按钮。 */}
                  <div className="about-links">
                    <button
                      type="button"
                      className="modal-btn set-ico"
                      onClick={() => {
                        // 打不开就静默：这是可选的外链，弹错反而打扰阅读
                        api.openExternal(AUTHOR_REPO.url).catch(() => {});
                      }}
                    >
                      <ExternalLink size={13} />
                      {AUTHOR_REPO.label}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 详情栏顶部的工具条：胶囊搜索框 + 关闭叉。
 *  它长在 .set-main 里面而不是横跨整框——用户要的「分割线只占右边宽度、
 *  不通到左边」就是靠这条 border-bottom 落在右栏容器上实现的。 */
function Bar({
  query,
  setQuery,
  onClose,
}: {
  query: string;
  setQuery: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="set-bar">
      <div className="set-search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          placeholder="搜索设置项"
          aria-label="搜索设置项"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <button type="button" className="set-x" onClick={onClose} aria-label="关闭设置" title="关闭（改动自动保存）">
        <X size={16} />
      </button>
    </div>
  );
}

/** 统一的「左名称+说明 / 右胶囊开关」行（划词翻译等布尔项）。 */
function SwitchRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setti">
      <div className="setti-info">
        <div className="setti-label">{label}</div>
        {desc && <div className="setti-desc">{desc}</div>}
      </div>
      <div className="setti-ctl">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          className={`sw${checked ? " on" : ""}`}
          onClick={() => onChange(!checked)}
        >
          <span className="sw-thumb" />
        </button>
      </div>
    </div>
  );
}

/** .set-ico 的图标位由 lucide 直接提供，见文件头 import。 */
