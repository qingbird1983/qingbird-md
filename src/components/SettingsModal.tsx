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
//   ① 即时生效类（「常规」页：开机自启 / 截图翻译 / 正文宽度 / 层级引线 / 导出重排版；
//      「外观」页：
//      明暗 / 配色；「翻译」页：翻译方向）
//      ——点即写盘，不进草稿。明暗 / 配色 / 导出重排版走 useSettingsStore.save；
//      正文宽度与层级引线是纯 UI 偏好，走 useUiStore + localStorage（不进 Rust
//      设置文件）；翻译方向必须
//      走 useDocStore.setTranslateTarget（它带索引空间 reset + 重译，直调
//      useSettingsStore.setTarget 会留下"方向变了、旧译文还在"的错位态）。
//   ② 草稿类（翻译源 / 凭据 / 快捷键 / 划词 / 大模型档案）——改动进本地 draft，
//      关闭时统一落盘。这样后端广播（settings-updated）不会打翻正在编辑的表单。
//
// 保命细节（saveAndClose 里）：draft 是打开弹窗那一刻的快照，里面也带着旧的
// theme/palette/translate_target 与常规页三开关（开机自启/截图翻译/导出重排版）。
// 若整包写回，用户「先切配色/方向/开关 → 再关闭」就会把旧值覆盖回去。
// 所以落盘时这些点即生效字段一律取 store 的当前值。
//
// 安全：凭据输入框一律 password 型（secret 字段），绝不打印 / toast 任何载荷。
//
// （P2-8c 拆分）草稿三件套与关窗落盘在 hooks/useSettingsDraft，大模型档案
// CRUD 在 hooks/useLlmProfiles，快捷键录制在 hooks/useHotkeyRecorder；六个
// 分类的详情在 components/settings/*Tab.tsx（JSX 逐字）。本文件只留导航、
// 搜索、即时生效类订阅与跨页共享的临时状态（pvMode 等）；可复用的
// Bar / SwitchRow 小件见 components/settings/SettingsParts.tsx（2026-09-24 迁出）。

import { useEffect, useMemo, useState } from "react";
import {
  Database,
  Info,
  Keyboard,
  Languages,
  Palette as PaletteIcon,
  SlidersHorizontal,
} from "lucide-react";
import Modal from "./Modal";
import { api } from "../lib/ipc";
import type { ProviderInfo } from "../types/ipc";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { errText, useUiStore } from "../stores/useUiStore";
import { useSettingsDraft } from "../hooks/useSettingsDraft";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { useHotkeyRecorder } from "../hooks/useHotkeyRecorder";
import { Bar } from "./settings/SettingsParts";
import GeneralTab from "./settings/GeneralTab";
import LookTab from "./settings/LookTab";
import TranslateTab, { groupOf, type ProvGroup } from "./settings/TranslateTab";
import HotkeysTab from "./settings/HotkeysTab";
import DataTab from "./settings/DataTab";
import AboutTab from "./settings/AboutTab";

/** 左栏大分类。id 同时也是「当前页」的唯一键。 */
type CatId = "general" | "look" | "translate" | "reading" | "data" | "about";

const CATS: Array<{ id: CatId; label: string; icon: typeof PaletteIcon; keys: string[] }> = [
  {
    id: "general",
    label: "常规",
    icon: SlidersHorizontal,
    keys: ["常规", "正文宽度", "宽度", "列表", "引线", "导出", "重排", "开机自启", "截图", "关闭", "托盘"],
  },
  {
    id: "look",
    label: "外观",
    icon: PaletteIcon,
    keys: ["明暗", "主题", "深浅", "系统", "配色", "纸色", "语种"],
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

export default function SettingsModal() {
  const {
    draft,
    setDraft,
    formProvider,
    setFormProvider,
    formCreds,
    setFormCreds,
    latest,
    saveAndClose,
  } = useSettingsDraft();

  // ---- 即时生效类：全部直读 store（不做草稿），点即落盘 ----
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const palette = useSettingsStore((s) => s.palette);
  const setPalette = useSettingsStore((s) => s.setPalette);
  // 正文宽度/层级引线/导出重排版归「常规」页（GeneralTab 自取 store，不经这里）
  // 翻译方向同属「点即生效」：它要连带 reset 索引空间 + 重译，所以只能走
  // `useDocStore.setTranslateTarget`（`useSettingsStore.setTarget` 只负责落盘，
  // 直调会造出「方向变了、旧译文还在」的错位态，见那个 store 的注释）。
  const translateTarget = useSettingsStore((s) => s.target);

  // ---- 导航 + 搜索 ----
  const [cat, setCat] = useState<CatId>("general");
  const [query, setQuery] = useState("");

  const [metas, setMetas] = useState<ProviderInfo[]>([]);
  const [grp, setGrp] = useState<ProvGroup>("free");
  // 色卡的预览档：默认跟随当前明暗，也可手动翻到另一档先看效果
  const [pvMode, setPvMode] = useState<"light" | "dark">(() =>
    isDarkTheme() ? "dark" : "light",
  );
  const [dataDir, setDataDir] = useState("");
  // 给人看的那份（`%APPDATA%\qingbird-md`）。**不要拿它去开目录**。
  const [dirLabel, setDirLabel] = useState("");

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

  // ── 大模型配置档案 + 快捷键录制 ──
  const {
    profiles,
    activeId,
    activeProfile,
    llmMsg,
    setLlmMsg,
    testResult,
    setTestResult,
    testing,
    fetching,
    useProfile,
    createProfile,
    renameProfile,
    deleteProfile,
    saveProfile,
    testConn,
    fetchModels,
    modelOptions,
  } = useLlmProfiles({ draft, setDraft, formProvider, setFormProvider, formCreds, setFormCreds, latest });
  const { recording, setRecording, hkMsg, setHkMsg, eff, conflicts, resetHotkeys } =
    useHotkeyRecorder(draft, setDraft);

  const meta = metas.find((m) => m.key === formProvider) ?? null;
  const isLlm = formProvider === "llm";

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

            {activeCat === "general" && <GeneralTab />}

            {activeCat === "look" && (
              <LookTab
                theme={theme}
                setTheme={setTheme}
                palette={palette}
                setPalette={setPalette}
                pvMode={pvMode}
                setPvMode={setPvMode}
              />
            )}

            {activeCat === "translate" && (
              <TranslateTab
                translateTarget={translateTarget}
                grp={grp}
                changeGroup={changeGroup}
                formProvider={formProvider}
                changeProvider={changeProvider}
                metas={metas}
                meta={meta}
                isLlm={isLlm}
                draft={draft}
                setDraft={setDraft}
                formCreds={formCreds}
                profiles={profiles}
                activeId={activeId}
                activeProfile={activeProfile}
                useProfile={useProfile}
                renameProfile={renameProfile}
                deleteProfile={deleteProfile}
                createProfile={createProfile}
                saveProfile={saveProfile}
                setFormCreds={setFormCreds}
                fetching={fetching}
                fetchModels={fetchModels}
                modelOptions={modelOptions}
                llmMsg={llmMsg}
                testing={testing}
                testConn={testConn}
                testResult={testResult}
              />
            )}

            {activeCat === "reading" && (
              <HotkeysTab
                recording={recording}
                setRecording={setRecording}
                hkMsg={hkMsg}
                setHkMsg={setHkMsg}
                eff={eff}
                conflicts={conflicts}
                resetHotkeys={resetHotkeys}
              />
            )}

            {activeCat === "data" && (
              <DataTab dirLabel={dirLabel} clearCache={clearCache} openCacheDir={openCacheDir} />
            )}

            {activeCat === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** .set-ico 的图标位由 lucide 直接提供，见文件头 import。 */
