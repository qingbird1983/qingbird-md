// 翻译域：整篇翻译的 gen 时序、进度、划词翻译浮窗结果。
// 阅读模式不在此存——唯一真源是 useDocStore.mode（plan 防双源决议）。
import { create } from "zustand";
import type {
  DonePayload,
  Mode,
  ProgressPayload,
  TranslationPartialPayload,
  WordLookupDTO,
  LookupDeltaPayload,
} from "../types/ipc";
import { api } from "../lib/ipc";
import { typewriterPush, typewriterStart, type TypewriterState } from "../lib/typewriter";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";
import { useSettingsStore } from "./useSettingsStore";

export type TranslationStatus = "idle" | "running" | "error";

interface SelectionState {
  text: string;
  loading: boolean;
  streaming: boolean; // 查词请求在途且 delta 仍可刷新（最终 DTO 到达即置 false）
  plain: string | null; // 现状路径结果（未配 LLM 时走全局翻译源）
  rich: WordLookupDTO | null; // LLM 查词富结果（流式期间为部分 DTO）
  error: string | null; // 显式失败（不静默回落，spec §9.2）
}

interface TranslationState {
  status: TranslationStatus;
  progress: { done: number; total: number } | null;
  gen: number;
  lastRunMode: Mode | null; // 上次整篇翻译所用的阅读模式，startIfFresh 判"模式变了需重跑"
  runContent: string | null; // 发起批次时的 doc.content：done 时判内容/文档是否仍一致（防编辑/切档后写入过期产物）
  selection: SelectionState | null;
  /** 已按文档序放行的块/run 译文（index 语义随当前 run 模式：runs 或 块） */
  partialBlocks: Map<number, string>;
  /** 已放行的连续前缀上界（exclusive）；PreviewView 的 patch 水位参照 */
  partialCursor: number;
  /** partial 流所属轮次；0 = 无流 */
  partialGen: number;

  translateDocument(): Promise<void>;
  /** switchMode 联动入口：gen 尚未产出 / 无译文缓存 / 模式与上次运行不同 ⇒ 重新起跑。 */
  startIfFresh(): void;
  listenPartial(): void;
  listenProgress(): void;
  listenDone(): void;
  listenLookupDelta(): void;
  stop(): void;
  translateSelection(text: string): void;
  clearSelection(): void;
}

// 同步哨兵防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
let progressRegistered = false;
let doneRegistered = false;
let deltaRegistered = false;
let selTimer: ReturnType<typeof setTimeout> | undefined;
// 打字机缓冲（不进 React state：pending 不驱动渲染，只有放行结果才 set）
let twState: TypewriterState = typewriterStart();
let partialRegistered = false;

/**
 * 截断 JSON 的渐进字段提取（流式渲染用）：从可能中途截断的 LLM 输出里
 * 抠出已完成/生成中的字符串字段。只解析渐进卡片用到的键（type/translation/
 * phonetic/partOfSpeech）；usage 及以下等完整 DTO 到了再整体替换。
 * 返回 null = 尚无可见字段（继续转圈）。
 */
export function parsePartialLookup(raw: string): WordLookupDTO | null {
  const s = raw.trim();
  if (s.startsWith("```")) {
    const inner = s.slice(3).split("\n").slice(1).join("\n");
    const fenced = inner.lastIndexOf("```") >= 0 ? inner.slice(0, inner.lastIndexOf("```")) : inner;
    if (fenced.trim()) return parsePartialLookup(fenced);
  }
  // 字符串值读取：处理转义（含截断在转义/\\uXXX 中间的情况），未闭合也返回已生成部分
  const strVal = (key: string): string | null => {
    const ki = s.indexOf(`"${key}"`);
    if (ki === -1) return null;
    let i = s.indexOf(":", ki + key.length + 2);
    if (i === -1) return null;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '"') return null;
    i++;
    let out = "";
    while (i < s.length) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        if (n === undefined) break;
        if (n === "u") {
          const hex = s.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          break;
        }
        out += { n: "\n", t: "\t", r: "\r" }[n] ?? n;
        i += 2;
        continue;
      }
      if (c === '"') return out; // 已闭合
      out += c;
      i++;
    }
    return out; // 截断中：返回已生成部分
  };
  const translation = strVal("translation");
  if (translation === null) return null;
  return {
    kind: s.includes('"type":"sentence"') ? "sentence" : "word",
    translation,
    phonetic: strVal("phonetic"),
    part_of_speech: strVal("partOfSpeech"),
    usage: null,
    examples: [],
    terms: [],
  };
}

function handleLookupDelta(p: LookupDeltaPayload) {
  const st = useTranslationStore.getState();
  const sel = st.selection;
  // 防乱序：事件按归一（trim）文本匹配当前浮窗，且仅流式在途时刷新；
  // 最终 DTO（settle，streaming=false）到达后的迟到 delta 不再覆盖
  if (!sel || !sel.streaming || sel.text.trim() !== p.text) return;
  const partial = parsePartialLookup(p.content);
  if (partial) {
    useTranslationStore.setState({ selection: { ...sel, loading: false, rich: partial } });
  }
}

function handleProgress(p: ProgressPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  useTranslationStore.setState({ progress: { done: p.done, total: p.total } });
}

/** translation-partial → 打字机缓冲 → 放行结果落 store（PreviewView patch 消费）。 */
function handlePartial(p: TranslationPartialPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与当前内容错位，宁缺勿错
  // （与 handleDone 的 runContent 护栏同一口径）。
  if (useDocStore.getState().doc?.content !== st.runContent) return;
  // 模式护栏：批次期间切换阅读模式 ⇒ partial 的 index 空间（runs/块）与当前
  // 预览锚点错位，宁缺勿错（与上方 runContent 护栏同口径；换挡补跑由 done 处理）。
  if (useDocStore.getState().mode !== st.lastRunMode) return;
  const next = typewriterPush(twState, p.index, p.text);
  twState = next.state;
  if (next.released.length === 0) return;
  const blocks = new Map(st.partialBlocks);
  for (const r of next.released) blocks.set(r.index, r.text);
  useTranslationStore.setState({
    partialBlocks: blocks,
    partialCursor: twState.cursor,
    partialGen: p.gen,
  });
}

/** 清空 partial 流（起跑/收尾共用）：React 状态 + 模块级打字机缓冲。 */
function clearPartial() {
  twState = typewriterStart();
  useTranslationStore.setState({
    partialBlocks: new Map(),
    partialCursor: 0,
    partialGen: 0,
  });
}

/** done payload → 标签化落库形态（事件路径与缓存同步路径共用同一组装） */
function doneHtmlOf(d: DonePayload, contentKey: string) {
  return d.html_translation || d.html_bilingual
    ? {
        contentKey,
        mode: (d.html_translation ? "translation" : "bilingual") as Exclude<Mode, "original">,
        html: (d.html_translation ?? d.html_bilingual)!,
      }
    : null;
}

function handleDone(d: DonePayload) {
  const st = useTranslationStore.getState();
  if (d.gen !== st.gen) return; // 陈旧轮次直接丢弃
  const ui = useUiStore.getState();
  const dd = useDocStore.getState();
  if (!d.ok) {
    clearPartial();
    useTranslationStore.setState({ status: "error", progress: null });
    ui.addToast("error", d.error ? `翻译失败：${d.error}` : "翻译失败");
    return;
  }
  clearPartial();
  useTranslationStore.setState({ status: "idle", progress: null });
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与 payload html 全部过期，宁缺勿错不落库。
  // 改走标签化 applyTranslationResult —— 翻译产物的归宿是当前 active tab。
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (contentFresh) {
    const translations = d.translations ? new Map(d.translations) : new Map<number, string>();
    useDocStore.getState().applyTranslationResult(translations, doneHtmlOf(d, st.runContent!));
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
  partialBlocks: new Map(),
  partialCursor: 0,
  partialGen: 0,
  selection: null,

  translateDocument: async () => {
    const dd = useDocStore.getState();
    const sp = useSettingsStore.getState().settings;
    if (!dd.doc || !sp || dd.mode === "original") return; // mode 守卫：原文模式无需跑引擎
    if (get().status === "running") return;
    try {
      const r = await api.translateDocument(
        dd.doc.content,
        dd.mode,
        sp.provider,
        useSettingsStore.getState().credsFor(sp.provider),
      );
      if (r.kind === "cached") {
        // 缓存全命中：产物随返回值同步直达（不经事件通道），直接落库展示，
        // 不进 running 态——进度条不出场，也无 done/invoke 到达顺序竞态。
        const d = r.done;
        useDocStore.getState().applyTranslationResult(new Map(d.translations ?? []), doneHtmlOf(d, dd.doc.content));
        useUiStore.getState().addToast("success", `翻译完成（${dd.doc.name}·缓存）`);
        return;
      }
      // runContent 与 gen 同轮绑定：done 事件据此判 payload 产物是否仍与当前内容一致
      clearPartial(); // 新一轮起跑清残留
      set({
        gen: r.gen,
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

  listenPartial: () => {
    if (partialRegistered) return;
    partialRegistered = true;
    void api.listenPartial(handlePartial);
  },

  listenLookupDelta: () => {
    if (deltaRegistered) return;
    deltaRegistered = true;
    void api.listenLookupDelta(handleLookupDelta);
  },

  stop: () => {
    // gen 前跳使同轮迟到的 done 失配而被丢弃（后端取消会丢弃部分产物）
    set((s) => ({ gen: s.gen + 1, status: "idle", progress: null }));
    clearPartial(); // 停止即清流：partialGen 归 0（0 = 无流），不留跨轮残留
    api.stopTranslation().catch(() => {});
  },

  translateSelection: (text) => {
    clearTimeout(selTimer);
    if (!text.trim()) {
      set({ selection: null });
      return;
    }
    set({ selection: { text, loading: true, streaming: false, plain: null, rich: null, error: null } });
    selTimer = setTimeout(async () => {
      const sp = useSettingsStore.getState().settings;
      const cur = () => get().selection;
      const settle = (patch: {
        plain: string | null;
        rich: WordLookupDTO | null;
        error: string | null;
      }) => {
        // 防乱序：只有仍是本次请求在展示时才回填；streaming 同时收口
        if (cur()?.text === text) set({ selection: { text, loading: false, streaming: false, ...patch } });
      };
      if (!sp) {
        settle({ plain: null, rich: null, error: "设置尚未加载" });
        return;
      }
      // R1 分流：LLM 凭据齐全（baseUrl + model 均非空）→ 查词；否则现状全局源。
      // 与全局翻译源选择无关——划词只认 LLM 是否配置（spec §8.1）。
      const llmCreds = useSettingsStore.getState().credsFor("llm");
      // 运行时缺键时 baseUrl 为 undefined（credsFor 返回 {}），?. 是真实守卫而非冗余——勿“清理”（曾致全新安装卡死，commit cc8a4c9）
      const llmReady = Boolean(llmCreds.baseUrl?.trim() && llmCreds.model?.trim());
      if (cur()?.text === text) set((s0) => ({ selection: s0.selection ? { ...s0.selection, streaming: true } : null }));
      try {
        if (llmReady) {
          const rich = await api.lookupWord(text, llmCreds);
          settle({ plain: null, rich, error: null });
        } else {
          const r = await api.translateText(text, sp.provider, useSettingsStore.getState().credsFor(sp.provider));
          settle({ plain: r, rich: null, error: null });
        }
      } catch (e) {
        settle({ plain: null, rich: null, error: errText(e) });
      }
    }, 300);
  },

  clearSelection: () => {
    clearTimeout(selTimer);
    set({ selection: null });
  },
}));

export { type SelectionState };
