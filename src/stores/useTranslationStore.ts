// 翻译域：整篇翻译的 gen 时序、进度、划词翻译浮窗结果。
// 阅读模式不在此存——唯一真源是 useDocStore.mode（plan 防双源决议）。
import { create } from "zustand";
import type { DonePayload, Mode, ProgressPayload } from "../types/ipc";
import { api } from "../lib/ipc";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";
import { useSettingsStore } from "./useSettingsStore";

export type TranslationStatus = "idle" | "running" | "error";

interface SelectionState {
  text: string;
  result: string;
  loading: boolean;
}

interface TranslationState {
  status: TranslationStatus;
  progress: { done: number; total: number } | null;
  gen: number;
  lastRunMode: Mode | null; // 上次整篇翻译所用的阅读模式，startIfFresh 判"模式变了需重跑"
  runContent: string | null; // 发起批次时的 doc.content：done 时判内容/文档是否仍一致（防编辑/切档后写入过期产物）
  selection: SelectionState | null;

  translateDocument(): Promise<void>;
  /** switchMode 联动入口：gen 尚未产出 / 无译文缓存 / 模式与上次运行不同 ⇒ 重新起跑。 */
  startIfFresh(): void;
  listenProgress(): void;
  listenDone(): void;
  stop(): void;
  translateSelection(text: string): void;
  clearSelection(): void;
}

// 同步哨兵防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let progressRegistered = false;
let doneRegistered = false;
let selTimer: ReturnType<typeof setTimeout> | undefined;

function handleProgress(p: ProgressPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  useTranslationStore.setState({ progress: { done: p.done, total: p.total } });
}

function handleDone(d: DonePayload) {
  const st = useTranslationStore.getState();
  if (d.gen !== st.gen) return; // 陈旧轮次直接丢弃
  const ui = useUiStore.getState();
  const dd = useDocStore.getState();
  if (!d.ok) {
    useTranslationStore.setState({ status: "error", progress: null });
    ui.addToast("error", d.error ? `翻译失败：${d.error}` : "翻译失败");
    return;
  }
  useTranslationStore.setState({ status: "idle", progress: null });
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与 payload html 全部过期，宁缺勿错不落库。
  // （stop 的迟到 done 已被上方 gen 失配拦住，此处护栏只管"内容变了但 gen 未变"的窗口。）
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (contentFresh) {
    if (d.translations) {
      useDocStore.setState({ translations: new Map(d.translations) });
    }
    // T8ext 契约：translation 批次出 html_translation（run 空间）、bilingual 批次出
    // html_bilingual（块空间），二者只居其一；以字段在否为准判定本轮形态。
    if (d.html_translation || d.html_bilingual) {
      useDocStore.setState({
        doneHtml: {
          contentKey: st.runContent!,
          mode: d.html_translation ? "translation" : "bilingual",
          html: (d.html_translation ?? d.html_bilingual)!,
        },
      });
    }
  }
  ui.addToast("success", `翻译完成（${dd.doc?.name ?? ""}）`);
  // 换挡补跑（startIfFresh 语义的收尾）：跑批期间用户切到另一翻译模式时，
  // 本轮 payload 形态与新模式不匹配 ⇒ 立刻按新模式补跑（后端缓存使重复批次近乎零成本）。
  if (dd.mode !== "original" && st.lastRunMode !== dd.mode) {
    useTranslationStore.getState().startIfFresh();
  }
}

export const useTranslationStore = create<TranslationState>()((set, get) => ({
  status: "idle",
  progress: null,
  gen: 0,
  lastRunMode: null,
  runContent: null,
  selection: null,

  translateDocument: async () => {
    const dd = useDocStore.getState();
    const sp = useSettingsStore.getState().settings;
    if (!dd.doc || !sp || dd.mode === "original") return; // mode 守卫：原文模式无需跑引擎
    if (get().status === "running") return;
    try {
      const g = await api.translateDocument(
        dd.doc.content,
        dd.mode,
        sp.provider,
        useSettingsStore.getState().credsFor(sp.provider),
      );
      // runContent 与 gen 同轮绑定：done 事件据此判 payload 产物是否仍与当前内容一致
      set({
        gen: g,
        status: "running",
        progress: null,
        lastRunMode: dd.mode,
        runContent: dd.doc.content,
      }); // 进度等首个事件
    } catch (e) {
      set({ status: "error" });
      useUiStore.getState().addToast("error", `发起翻译失败：${errText(e)}`);
    }
  },

  startIfFresh: () => {
    const st = get();
    const dd = useDocStore.getState();
    const fresh = st.gen === 0 || dd.translations.size === 0 || st.lastRunMode !== dd.mode;
    if (fresh && st.status !== "running") void get().translateDocument();
  },

  listenProgress: () => {
    if (progressRegistered) return;
    progressRegistered = true;
    void api.listenProgress(handleProgress);
  },

  listenDone: () => {
    if (doneRegistered) return;
    doneRegistered = true;
    void api.listenDone(handleDone);
  },

  stop: () => {
    // gen 前跳使同轮迟到的 done 失配而被丢弃（后端取消会丢弃部分产物）
    set((s) => ({ gen: s.gen + 1, status: "idle", progress: null }));
    api.stopTranslation().catch(() => {});
  },

  translateSelection: (text) => {
    clearTimeout(selTimer);
    if (!text.trim()) {
      set({ selection: null });
      return;
    }
    set({ selection: { text, result: "", loading: true } });
    selTimer = setTimeout(async () => {
      const sp = useSettingsStore.getState().settings;
      try {
        if (!sp) throw new Error("设置尚未加载");
        const r = await api.translateText(
          text,
          sp.provider,
          useSettingsStore.getState().credsFor(sp.provider),
        );
        // 防乱序：只有仍是本次请求在展示时才回填
        const cur = get().selection;
        if (cur?.text === text) set({ selection: { text, result: r, loading: false } });
      } catch (e) {
        const cur = get().selection;
        if (cur?.text === text) set({ selection: { text, result: errText(e), loading: false } });
      }
    }, 300);
  },

  clearSelection: () => {
    clearTimeout(selTimer);
    set({ selection: null });
  },
}));

export { type SelectionState };
