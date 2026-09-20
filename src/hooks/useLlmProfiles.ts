// 大模型配置档案层（P2-8c 自 components/SettingsModal.tsx 纯提取）：档案 CRUD、
// 老用户升级迁移的一次性闩、模型清单拉取与「保存此配置」当场落盘、连接测试。
// 草稿与凭据槽本身归 useSettingsDraft，本 hook 只持 LLM 域的临时反馈状态。
import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "../lib/ipc";
import type { LlmProfile, Settings } from "../types/ipc";
import { errText } from "../stores/useUiStore";
import { useSettingsStore } from "../stores/useSettingsStore";

const LLM_CRED_KEYS = ["baseUrl", "apiKey", "model", "lookup_model"] as const;

/** LLM 厂商预设：**只用来「新建配置」时填初值**，不再是一个并行的下拉。
 *  （改版前它是个「厂商预设」下拉，选中即覆盖 baseUrl 那一份凭据——于是
 *   自定义只能存一套、再选预设就被冲掉。现在预设是「模板」，配置本身可存多套。） */
export const LLM_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-flash", "qwen-plus", "qwen-max"] },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-5.3-flash", "glm-4.7-flash", "glm-5.3"] },
  { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", models: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"] },
  { name: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] },
];

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
export function withCredsInProfile(list: LlmProfile[], id: string, creds: Record<string, string>): LlmProfile[] {
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

export interface LlmProfilesCtx {
  draft: Settings | null;
  setDraft: Dispatch<SetStateAction<Settings | null>>;
  formProvider: string;
  setFormProvider: (k: string) => void;
  formCreds: Record<string, string>;
  setFormCreds: Dispatch<SetStateAction<Record<string, string>>>;
  latest: MutableRefObject<{ draft: Settings | null; formProvider: string; formCreds: Record<string, string> }>;
}

export function useLlmProfiles(ctx: LlmProfilesCtx) {
  const { draft, setDraft, formProvider, setFormProvider, formCreds, setFormCreds, latest } = ctx;
  const [llmMsg, setLlmMsg] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);

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

  const profiles = draft?.llm_profiles ?? [];
  const activeId = draft?.llm_active ?? "";
  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

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

  const modelOptions = useMemo(() => {
    const saved = activeProfile?.models ?? [];
    const preset = LLM_PRESETS.find(
      (p) => p.baseUrl.replace(/\/+$/, "") === (formCreds.baseUrl ?? "").trim().replace(/\/+$/, ""),
    );
    return Array.from(new Set([...saved, ...(preset?.models ?? [])]));
  }, [activeProfile, formCreds.baseUrl]);

  return {
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
  };
}
