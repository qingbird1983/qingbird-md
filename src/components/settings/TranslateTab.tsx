// 设置面板「翻译与模型」页（P2-8c 自 SettingsModal.tsx 的 translate 分支纯提取）：
// 翻译方向 / 翻译源分组 / 大模型配置档案 / 凭据 / 划词翻译 / 连接测试。
// 即时生效类（翻译方向）直写 useDocStore；其余改动进草稿，关窗统一落盘。
import { Info, RefreshCw, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { LlmProfile, ProviderInfo, Settings, TargetLang } from "../../types/ipc";
import { useDocStore } from "../../stores/useDocStore";
import { LLM_PRESETS } from "../../hooks/useLlmProfiles";
import { SwitchRow } from "../SettingsModal";

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

/** 翻译方向选项（与 TargetLang 一一对应；数组顺序 = 面板里的显示顺序）。 */
const TARGET_OPTIONS: Array<[TargetLang, string]> = [
  ["zh", "译成中文"],
  ["en", "译成英文"],
];

/** 翻译源三分组。分组**不写死在后端**：按 DTO 现成字段推——
 *  llm 单列，其余「要密钥 = 专业源 / 不要密钥 = 免费源」，后端以后加源自动归位，
 *  不会出现「注册表加了、前端漏分组」的两处同步问题。 */
export type ProvGroup = "free" | "pro" | "llm";

export const PROV_GROUPS: Array<[ProvGroup, string]> = [
  ["free", "免费源"],
  ["pro", "专业源"],
  ["llm", "LLM大模型"],
];

export function groupOf(m: ProviderInfo): ProvGroup {
  if (m.key === "llm") return "llm";
  return m.needs_key ? "pro" : "free";
}

export interface TranslateTabProps {
  translateTarget: TargetLang;
  grp: ProvGroup;
  changeGroup: (g: ProvGroup) => void;
  formProvider: string;
  changeProvider: (k: string) => void;
  metas: ProviderInfo[];
  meta: ProviderInfo | null;
  isLlm: boolean;
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings | null>>;
  formCreds: Record<string, string>;
  profiles: LlmProfile[];
  activeId: string;
  activeProfile: LlmProfile | null;
  useProfile: (p: LlmProfile) => void;
  renameProfile: (id: string, name: string) => void;
  deleteProfile: (id: string) => void;
  createProfile: (presetUrl: string) => void;
  saveProfile: () => Promise<void>;
  setFormCreds: Dispatch<SetStateAction<Record<string, string>>>;
  fetching: boolean;
  fetchModels: () => Promise<void>;
  modelOptions: string[];
  llmMsg: string;
  testing: boolean;
  testConn: () => Promise<void>;
  testResult: string;
}

export default function TranslateTab({
  translateTarget,
  grp,
  changeGroup,
  formProvider,
  changeProvider,
  metas,
  meta,
  isLlm,
  draft,
  setDraft,
  formCreds,
  profiles,
  activeId,
  activeProfile,
  useProfile,
  renameProfile,
  deleteProfile,
  createProfile,
  saveProfile,
  setFormCreds,
  fetching,
  fetchModels,
  modelOptions,
  llmMsg,
  testing,
  testConn,
  testResult,
}: TranslateTabProps) {
  return (
    <>
      <section className="set-sec">
        <h3 className="set-sec-title">翻译方向</h3>
        <p className="set-sec-desc">
          决定整篇译文的目标语言，也决定「译文另存为」的文件名后缀。
          切换会立即作废当前译文并按新方向重新翻译。
        </p>
        <div className="setseg" role="group" aria-label="翻译方向">
          {TARGET_OPTIONS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={translateTarget === v ? "on" : ""}
              onClick={() => void useDocStore.getState().setTranslateTarget(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

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
            const isModelField =
              isLlm && (f.key === "model" || f.key === "lookup_model" || f.key === "review_model");
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
        <SwitchRow
          label="导出时重排版"
          desc="另存为 .md 时对译文施加确定性排版：中英间距、标点全/半角、省略号、破折号。只影响导出文件，不改屏幕上的译文。"
          checked={draft.relayout_on_export}
          onChange={(v) =>
            setDraft((d) => (d ? { ...d, relayout_on_export: v } : d))
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
  );
}
