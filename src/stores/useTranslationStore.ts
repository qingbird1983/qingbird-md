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
import {
  revealDrain,
  revealIdle,
  revealPush,
  revealSetRegion,
  revealStart,
  revealTick,
  TICK_MS,
  type RevealCommit,
  type RevealState,
} from "../lib/reveal";
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
  /** 已定格（done/instant）的完整译文块（index 语义随当前 run 模式：runs 或 块）；打字 tick 不进 React state */
  partialBlocks: Map<number, string>;
  /** 已定格的连续前缀上界（exclusive）；只随 done/instant 推进 */
  partialCursor: number;
  /** partial 流所属轮次；0 = 无流 */
  partialGen: number;
  /** 按需翻译作用域：off=未激活（滚动绝不触发）；viewport=滚到哪译到哪；full=整篇 */
  scope: TranslateScope;
  /** 最近上报视口（data-bi 块索引空间） */
  viewport: { top: number; bottom: number } | null;
  /** 当前/上轮 run 的窗口（null=全文）——done 后自动扩展评估用 */
  lastWindow: [number, number] | null;

  setViewport(top: number, bottom: number): void;
  translateDocument(scope?: TranslateScope): Promise<void>;
  translateFull(): void;
  registerPatcher(fn: ((c: RevealCommit) => void) | null): void;
  /** 彻底清显示（切原文/换内容时）：committed + 打字流 + reveal 全清 */
  resetDisplay(): void;
  /** 内容已变且与上轮 run 不符 → 清显示（applyEdit/换档调用，幂等廉价） */
  resetDisplayIfStale(content: string): void;
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
let partialRegistered = false;
// 打字机缓冲 + reveal 队列（不进 React state：tick 不驱动渲染，只有放行结果才 set）
let twState: TypewriterState = typewriterStart();
let revealState: RevealState = revealStart();
let revealTimer: ReturnType<typeof setInterval> | undefined;
let revealPatcher: ((c: RevealCommit) => void) | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
// 视口窗口下界超出视口底的预取块数（qingniao round2 定值）
const WINDOW_PREFETCH = 4;

export type TranslateScope = "off" | "viewport" | "full";

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

/** reveal commit 分发：逐条喂给 PreviewView patcher（DOM 直写），done/instant
 * 另落 React state（partialBlocks 只存已定格的完整译文，tick 永不入表）。 */
function dispatchReveal(commits: RevealCommit[]) {
  if (commits.length === 0) return;
  const st = useTranslationStore.getState();
  const blocks = new Map(st.partialBlocks);
  let cursor = st.partialCursor;
  for (const c of commits) {
    revealPatcher?.(c);
    if (c.kind === "done" || c.kind === "instant") {
      blocks.set(c.index, c.text);
      cursor = Math.max(cursor, c.index + 1);
    }
  }
  useTranslationStore.setState({ partialBlocks: blocks, partialCursor: cursor });
}

/** 有未排空的 reveal 队列就起 30ms tick；空闲/已在泵则不动。 */
function pumpReveal() {
  if (revealTimer !== undefined) return;
  if (revealIdle(revealState)) return;
  revealTimer = setInterval(() => {
    const out = revealTick(revealState);
    revealState = out.state;
    dispatchReveal(out.commits);
    if (revealIdle(revealState) && revealTimer !== undefined) {
      clearInterval(revealTimer);
      revealTimer = undefined;
    }
  }, TICK_MS);
}

function sameWindow(a: [number, number] | null, b: [number, number] | null): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
}

/** 会话静默后用累积 translations 重建整树 canonical html（切视图/重渲兜底）。 */
function scheduleCanonicalRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    const st = useTranslationStore.getState();
    const dd = useDocStore.getState();
    if (st.status === "running" || st.gen === 0) return;
    if (!dd.doc || dd.doc.content !== st.runContent) return;
    if (dd.mode === "original" || dd.translations.size === 0) return;
    if (!revealIdle(revealState)) {
      scheduleCanonicalRebuild(); // 还在打字：稍后再试
      return;
    }
    try {
      const r = await api.renderTranslated(
        dd.doc.content,
        dd.mode as "translation" | "bilingual",
        Array.from(dd.translations.entries()) as Array<[number, string]>,
      );
      const dd2 = useDocStore.getState();
      if (!dd2.doc || dd2.doc.content !== st.runContent) return; // 内容已变，丢弃
      useDocStore.getState().applyTranslationResult(new Map(dd2.translations), {
        contentKey: st.runContent!,
        mode: dd2.mode as Exclude<Mode, "original">,
        html: r.html,
      });
    } catch {
      /* 静默：patch DOM 已是显示真源 */
    }
  }, 400);
}

/** translation-partial → 打字机缓冲（文档序重排）→ reveal 队列（tick 驱动上屏）。 */
function handlePartial(p: TranslationPartialPayload) {
  const st = useTranslationStore.getState();
  if (p.gen !== st.gen || st.status !== "running") return;
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与当前内容错位，宁缺勿错
  // （与 handleDone 的 runContent 护栏同一口径）。
  if (useDocStore.getState().doc?.content !== st.runContent) return;
  // 模式护栏：批次期间切换阅读模式 ⇒ partial 的 index 空间（runs/块）与当前
  // 预览锚点错位，宁缺勿错（与上方 runContent 护栏同口径；换挡补跑由 done 处理）。
  if (useDocStore.getState().mode !== st.lastRunMode) return;
  const next = typewriterPush(twState, p.index, p.text, p.from_cache);
  twState = next.state;
  if (next.released.length === 0) return;
  for (const r of next.released) {
    const out = revealPush(revealState, r.index, r.text, r.fromCache);
    revealState = out.state;
    dispatchReveal(out.commits);
  }
  pumpReveal();
}

/** 起跑时重置打字流（committed 保留——已定格译文跨窗口持续显示）。 */
function resetStream(base: number) {
  twState = typewriterStart(base);
}

/** 彻底清显示（全文 done 落整树 / 切原文 / 内容过期）。 */
function clearAll() {
  twState = typewriterStart();
  const out = revealDrain(revealState);
  revealState = out.state;
  dispatchReveal(out.commits);
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
    clearAll();
    useTranslationStore.setState({ status: "error", progress: null, scope: "off" });
    ui.addToast("error", d.error ? `翻译失败：${d.error}` : "翻译失败");
    return;
  }
  const windowed = st.lastWindow !== null;
  if (windowed) {
    // 内容/模式护栏（与全文分支 contentFresh 同口径）：批次期间编辑或换档 ⇒
    // done 的块索引与当前内容/索引空间错位，宁缺勿错不落库；窗口视为过期——
    // 跳过 merge 且不自动续跑（内容已变时续跑无从对齐索引空间，等下一次
    // 视口/手动触发重新起跑）。
    const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
    const modeFresh = dd.mode === st.lastRunMode;
    if (!contentFresh || !modeFresh) {
      useTranslationStore.setState({ status: "idle", progress: null, lastWindow: null });
      // 换挡补跑（镜像全文分支的 startIfFresh 收尾）：仅换档且内容未变时，
      // 立刻按新模式补跑（后端缓存使重复批次近乎零成本）。
      if (contentFresh && dd.mode !== "original" && !modeFresh) {
        useTranslationStore.getState().startIfFresh();
      }
      return;
    }
    // 窗口化：merge 累积（不整表 replace）；显示层继续走 committed/打字
    useDocStore.getState().mergeTranslations(d.translations ?? []);
    useTranslationStore.setState({ status: "idle", progress: null });
    // RunDone 边界评估：当前视口窗口 ≠ 上轮 → 接着译新窗口；相同 → 收口
    const cur = currentWindow(useTranslationStore.getState());
    if (!sameWindow(cur, st.lastWindow)) {
      void useTranslationStore.getState().translateDocument();
    } else {
      scheduleCanonicalRebuild();
    }
    return;
  }
  clearAll();
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

/** 当前视口 → 窗口（块索引空间，含预取）；无上报回退 [0, PREFETCH)。 */
function currentWindow(st: { viewport: { top: number; bottom: number } | null }): [number, number] {
  const v = st.viewport;
  return v ? [v.top, v.bottom + WINDOW_PREFETCH] : [0, WINDOW_PREFETCH];
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
  scope: "off",
  viewport: null,
  lastWindow: null,

  translateDocument: async (scope) => {
    const dd = useDocStore.getState();
    const sp = useSettingsStore.getState().settings;
    if (!dd.doc || !sp || dd.mode === "original") return; // mode 守卫：原文模式无需跑引擎
    if (get().status === "running") return;
    // scope 化：显式传入优先；否则沿用当前 scope，off 则默认视口按需
    const sc: TranslateScope = scope ?? (get().scope === "off" ? "viewport" : get().scope);
    const win = sc === "viewport" ? currentWindow(get()) : null;
    try {
      const r = await api.translateDocument(
        dd.doc.content,
        dd.mode,
        sp.provider,
        useSettingsStore.getState().credsFor(sp.provider),
        win,
      );
      if (r.kind === "cached") {
        const d = r.done;
        if (win) {
          // 窗口化缓存全命中：merge + 瞬时上屏（载荷无整树 html）
          useDocStore.getState().mergeTranslations(d.translations ?? []);
          dispatchReveal(
            (d.translations ?? []).map(([index, text]) => ({ kind: "instant", index, text }) as RevealCommit),
          );
          set({ scope: sc, lastWindow: win });
          scheduleCanonicalRebuild();
          return; // 无 toast：窗口化不打扰（进度语义由后续 run 承担）
        }
        // 缓存全命中：产物随返回值同步直达（不经事件通道），直接落库展示，
        // 不进 running 态——进度条不出场，也无 done/invoke 到达顺序竞态。
        useDocStore.getState().applyTranslationResult(new Map(d.translations ?? []), doneHtmlOf(d, dd.doc.content));
        useUiStore.getState().addToast("success", `翻译完成（${dd.doc.name}·缓存）`);
        return;
      }
      // runContent 与 gen 同轮绑定：done 事件据此判 payload 产物是否仍与当前内容一致
      resetStream(r.first_index); // 新打字流基点（窗口化索引非 0 起）
      if (win) {
        const out = revealSetRegion(revealState, win[0], win[1]);
        revealState = out.state;
        dispatchReveal(out.commits);
      } else {
        // 全文 run：重开区域为缺省全区 [0, ∞)。上一窗口化 run 的区域若无此
        // 重置会残留：区域外的 partial 卡在队首，revealTick 空转分支既不上屏
        // 也不出队，只能等 done 的 clearAll→drain 兜底；中途停止时队列永排
        // 不空，30ms tick 空转泄漏。极端情形下残留项会被重锚 flush 成
        // done/instant 立即上屏（均为同内容合法译文，全文 done 随后整树替换）。
        const out = revealSetRegion(revealState, 0, Infinity);
        revealState = out.state;
        dispatchReveal(out.commits);
      }
      set({
        gen: r.gen,
        status: "running",
        progress: null,
        lastRunMode: dd.mode,
        runContent: dd.doc.content,
        scope: sc,
        lastWindow: win,
      }); // 进度等首个事件
      pumpReveal();
    } catch (e) {
      set({ status: "error" });
      useUiStore.getState().addToast("error", `发起翻译失败：${errText(e)}`);
    }
  },

  translateFull: () => {
    void get().translateDocument("full");
  },

  setViewport: (top, bottom) => {
    const st = get();
    if (st.viewport && st.viewport.top === top && st.viewport.bottom === bottom) return;
    set({ viewport: { top, bottom } });
    // 会话门：off/running 只记锚点；空闲且按需激活 → 立即评估起跑
    if (st.scope === "viewport" && st.status !== "running") void get().translateDocument();
  },

  registerPatcher: (fn) => {
    revealPatcher = fn;
  },

  resetDisplay: () => {
    clearAll();
    set({ scope: "off", viewport: null, lastWindow: null });
  },

  resetDisplayIfStale: (content) => {
    const st = get();
    if (st.runContent !== null && st.runContent !== content && (st.partialGen !== 0 || st.partialBlocks.size > 0)) {
      clearAll();
      set({ scope: "off", lastWindow: null });
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
    set((s) => ({ gen: s.gen + 1, status: "idle", progress: null, scope: "off", lastWindow: null }));
    // 打字流等位丢弃（缺口永不再来），已定格/打字中保留自然收尾
    twState = typewriterStart();
    // 区域无界放开（±∞ 内不存在区域外索引 ⇒ 重锚 flush 集恒空，故不 dispatch）：
    // 已定格/打字中按 30ms 节奏自然排空；也排除「区域外残项卡住队首 →
    // revealIdle 恒 false → interval 30Hz 空转直到下次 setRegion/clearAll」的泄漏。
    const out = revealSetRegion(revealState, -Infinity, Infinity);
    revealState = out.state;
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
