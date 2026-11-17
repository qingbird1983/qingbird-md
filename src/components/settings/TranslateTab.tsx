// 设置面板「翻译与模型」页（P2-8c 自 SettingsModal.tsx 的 translate 分支纯提取）：
// 翻译方向 / 翻译源分组 / 凭据 / 划词翻译 / 连接测试。
// 即时生效类（翻译方向）直写 useDocStore；其余改动进草稿，关窗统一落盘。
// 注：原「LLM 大模型」分组与配置档案已随 AI 功能移除。
import { Info } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { ProviderInfo, Settings, TargetLang } from "../../types/ipc";
import { useDocStore } from "../../stores/useDocStore";
import { Seg } from "../ui/Seg";
import { SwitchRow } from "./SettingsParts";

/** 翻译方向选项（与 TargetLang 一一对应；数组顺序 = 面板里的显示顺序）。 */
const TARGET_OPTIONS: Array<[TargetLang, string]> = [
  ["zh", "译成中文"],
  ["en", "译成英文"],
];

/** 翻译源分组：按 DTO 现成字段推——要密钥 = 专业源 / 不要密钥 = 免费源，
 *  后端以后加源自动归位，不会出现「注册表加了、前端漏分组」的两处同步问题。 */
export type ProvGroup = "free" | "pro";

export const PROV_GROUPS: Array<[ProvGroup, string]> = [
  ["free", "免费源"],
  ["pro", "专业源"],
];

export function groupOf(m: ProviderInfo): ProvGroup {
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
  draft: Settings;
  setDraft: Dispatch<SetStateAction<Settings | null>>;
  formCreds: Record<string, string>;
  setFormCreds: Dispatch<SetStateAction<Record<string, string>>>;
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
  draft,
  setDraft,
  formCreds,
  setFormCreds,
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
        <Seg variant="setseg" ariaLabel="翻译方向" value={translateTarget}
          onChange={(v) => void useDocStore.getState().setTranslateTarget(v)}
          options={TARGET_OPTIONS.map(([v, label]) => ({ value: v, label }))} />
      </section>

      <section className="set-sec">
        <h3 className="set-sec-title">翻译源</h3>
        <p className="set-sec-desc">
          按来源分两类：免费源开箱即用，专业源需要填自己的密钥。
        </p>
        <Seg variant="setseg" ariaLabel="翻译源分组" value={grp} onChange={changeGroup}
          options={PROV_GROUPS.map(([g, label]) => ({ value: g, label }))} />
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
        {meta && (
          <div className="set-hint">
            <Info size={13} />
            <span>{meta.note}</span>
          </div>
        )}
      </section>

      {meta && meta.fields.length > 0 && (
        <section className="set-sec">
          <div className="set-head-row">
            <div>
              <h3 className="set-sec-title">凭据</h3>
              <p className="set-sec-desc">
                只保存在本机配置文件里；密钥输入框不回显明文。
              </p>
            </div>
          </div>
          {meta.fields.map((f) => (
            <div className="set-field" key={f.key}>
              <label htmlFor={`set-f-${f.key}`}>{f.label}</label>
              <input
                id={`set-f-${f.key}`}
                type={f.secret ? "password" : "text"}
                value={formCreds[f.key] ?? ""}
                placeholder={f.placeholder}
                title={f.placeholder}
                autoComplete="off"
                onChange={(e) =>
                  setFormCreds((c) => ({ ...c, [f.key]: e.target.value }))
                }
              />
            </div>
          ))}
        </section>
      )}

      {/* 划词翻译归在本页（它复用上面这份翻译凭据，和快捷键不是一类事）；
          「导出时重排版」已迁去「常规」页并改为点即生效（2026-09-24） */}
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
  );
}
