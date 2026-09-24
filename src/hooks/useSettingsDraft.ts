// 设置弹窗的草稿合并层（P2-8c 自 components/SettingsModal.tsx 纯提取）：
// 草稿三件套（draft / formProvider / formCreds）的初始化与补种、「最新值」ref，
// 以及关窗前统一落盘的 saveAndClose（REL-12：乐观写 + 失败回滚 + toast，闭窗不等 I/O）。
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Settings } from "../types/ipc";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore } from "../stores/useUiStore";
import { withCredsInProfile } from "./useLlmProfiles";

export interface SettingsDraft {
  close: () => void;
  live: Settings | null;
  draft: Settings | null;
  setDraft: Dispatch<SetStateAction<Settings | null>>;
  formProvider: string;
  setFormProvider: (k: string) => void;
  formCreds: Record<string, string>;
  setFormCreds: Dispatch<SetStateAction<Record<string, string>>>;
  latest: MutableRefObject<{ draft: Settings | null; formProvider: string; formCreds: Record<string, string> }>;
  saveAndClose: () => void;
}

export function useSettingsDraft(): SettingsDraft {
  const close = useUiStore((s) => s.closeSettings);
  const live = useSettingsStore((s) => s.settings);

  // ---- 草稿类状态 ----
  const [draft, setDraft] = useState<Settings | null>(() =>
    live ? { ...live, providers: { ...live.providers } } : null,
  );
  const [formProvider, setFormProvider] = useState(() => live?.provider ?? "");
  const [formCreds, setFormCreds] = useState<Record<string, string>>(() =>
    live ? (live.providers[live.provider] ?? {}) : {},
  );

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

  // Task 12：一键恢复全局默认后 load() 把 settings 整包换回出厂值，而 draft /
  // formProvider / formCreds 还是恢复前的快照——不重种草，关窗时 saveAndClose
  // 会把旧 provider/凭据/热键整包写回盘，等于把恢复作废（Task 10/11「点即生效
  // 字段被旧草稿覆盖」的全量版）。订阅 loadGeneration（只有 load() 递增，
  // 广播 echo 与 save 都不动它，所以不会打翻正常编辑中的表单）重种草草稿三件套。
  const epoch = useSettingsStore((s) => s.loadGeneration);
  const seededEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === seededEpoch.current) return;
    seededEpoch.current = epoch;
    const cur = useSettingsStore.getState().settings;
    if (!cur) return;
    setDraft({ ...cur, providers: { ...cur.providers } });
    setFormProvider(cur.provider);
    setFormCreds(cur.providers[cur.provider] ?? {});
  }, [epoch]);

  /** 关窗前统一落盘（这就是「取消/保存」两个按钮的替代品）。 */
  const saveAndClose = useCallback(() => {
    const { draft: d, formProvider: fp, formCreds: fc } = latest.current;
    if (d) {
      // theme / palette / translate_target 是「点即生效」字段：以 store 的当前值为准
      // （用户可能刚在「外观」页点过配色、或在「翻译」页换过方向，而 draft 是打开
      // 弹窗时的旧快照）。不这样覆盖的话，「切了配色/方向 → 关窗」会把旧值写回盘。
      // 「常规」页三个点即生效字段同病同治（Task 10）：开机自启 / 截图翻译 /
      // 导出重排版都直写 store，不覆盖就会被关窗时的旧草稿整包打回原值。
      // close_action（Task 11）同理——关窗询问弹窗勾「记住」也是直写 store。
      const cur = useSettingsStore.getState().settings;
      // 当前这栏凭据顺手写回它对应的档案（用户可能改了字段却直接关窗）
      const llmProfiles = d.llm_active
        ? withCredsInProfile(d.llm_profiles, d.llm_active, fc)
        : d.llm_profiles;
      const next: Settings = {
        ...d,
        theme: cur?.theme ?? d.theme,
        palette: cur?.palette ?? d.palette,
        translate_target: cur?.translate_target ?? d.translate_target,
        autostart: cur?.autostart ?? d.autostart,
        capture_enabled: cur?.capture_enabled ?? d.capture_enabled,
        relayout_on_export: cur?.relayout_on_export ?? d.relayout_on_export,
        close_action: cur?.close_action ?? d.close_action,
        provider: fp,
        providers: { ...d.providers, [fp]: fc },
        llm_profiles: llmProfiles,
      };
      // store.save：乐观写 + 失败回滚 + toast，不必等它（关窗不该让用户等 I/O）
      void useSettingsStore.getState().save(next);
    }
    close();
  }, [close]);

  return { close, live, draft, setDraft, formProvider, setFormProvider, formCreds, setFormCreds, latest, saveAndClose };
}
