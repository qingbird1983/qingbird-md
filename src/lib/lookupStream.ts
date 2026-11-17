// 划词翻译的防抖单例（P2-8a 自 stores/useTranslationStore 纯提取）：
// 选中文本 → 300ms 防抖 → 走全局翻译源译出纯文本 → 回填浮窗。
// selection 状态本身是 React 可见状态，仍落 useTranslationStore；本类只持有
// 不可 React 化的 selTimer 单例。
// 注：原有的「LLM 富结果（音标/词性/例句）」与流式 delta 已随 AI 功能移除。
import { api } from "./ipc";
import { errText } from "../stores/useUiStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";

/** 划词查词流的可变单例容器：字段=原模块级 let selTimer。 */
export class LookupStream {
  private selTimer: ReturnType<typeof setTimeout> | undefined;

  /** 划词翻译请求（300ms 防抖 + 乱序守卫，走当前全局翻译源）。 */
  request(text: string) {
    const store = useTranslationStore;
    clearTimeout(this.selTimer);
    if (!text.trim()) {
      store.setState({ selection: null });
      return;
    }
    store.setState({ selection: { text, loading: true, plain: null, error: null } });
    this.selTimer = setTimeout(async () => {
      const sp = useSettingsStore.getState().settings;
      const cur = () => store.getState().selection;
      const settle = (patch: { plain: string | null; error: string | null }) => {
        // 防乱序：只有仍是本次请求在展示时才回填
        if (cur()?.text === text) store.setState({ selection: { text, loading: false, ...patch } });
      };
      if (!sp) {
        settle({ plain: null, error: "设置尚未加载" });
        return;
      }
      try {
        const r = await api.translateText(text, sp.provider, useSettingsStore.getState().credsFor(sp.provider));
        settle({ plain: r, error: null });
      } catch (e) {
        settle({ plain: null, error: errText(e) });
      }
    }, 300);
  }

  /** 清浮窗。 */
  cancel() {
    clearTimeout(this.selTimer);
    useTranslationStore.setState({ selection: null });
  }
}

export const lookupStream = new LookupStream();
