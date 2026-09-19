// 翻译域：整篇翻译的 gen 时序、进度、划词翻译浮窗结果。
// 阅读模式不在此存——唯一真源是 useDocStore.mode（plan 防双源决议）。
import { create } from "zustand";
import type {
  DonePayload,
  Mode,
  ProgressPayload,
  TargetLang,
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
  type RevealCommit,
  type RevealRun,
  type RevealState,
} from "../lib/reveal";
import { useUiStore, errText } from "./useUiStore";
import { useDocStore } from "./useDocStore";
import { useSettingsStore } from "./useSettingsStore";
import { earlyPush, earlyStart, earlyTake, type EarlyBuffer } from "../lib/earlyPartial";

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
let revealRaf = 0;
let revealPatcher: ((c: RevealCommit) => void) | null = null;
/** 单单元裸发路径已流式直显（灰字+省略号）的 run；完整 Unit 到达时定格 */
/** 本轮标记翻译失败（原文回退）的 run：跳过打字、推进放行，避免缺位卡死 */
let failedRuns = new Set<number>();
let streamed = new Set<number>();
/** 流式直显过的 run 所属块：整块定格收样式，避免块打字时把已直显 run 重打闪回 */
let streamedBlock = new Set<number>();
/** run → 所属块（本轮收集；data-bi 空间，来自 TranslateStart.indices_blocks） */
let blockOfRun = new Map<number, number>();
/** 块 → 期望收集 run 数（块组装完成判定；bilingual 模式恒 1） */
let blockRunCounts = new Map<number, number>();
/** 块 → 已放行待组装的 run（bucket：runIndex → Released） */
let blockAssembly = new Map<number, Map<number, import("../lib/typewriter").Released>>();
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
/** Started 响应未到前到达的早期事件缓冲（cache 命中 partial 等）。worker 起跑
 * 瞬间先发 cache 命中，先于 invoke 响应到前端；gen/status 护栏会丢 → 打字机
 * 等位卡死 → done 一次性回填。缓冲到 Started 落定后按 gen 回放（根因修复）。 */
let earlyBuf: EarlyBuffer = earlyStart();
/** 本轮已收到事件的 run 索引（done 时对比 seq 找缺失，运行时诊断） */
let receivedRuns = new Set<number>();
/** translate_document invoke 在飞闩：handleDone 自动续跑与 setViewport 都可能
 * 在 status=idle 时触发新 run，双发 invoke 会让第二发被后端拒绝 → 前端 catch
 * 误置 error 态 → 在途 run 的后续 partial 全部被 status 护栏丢弃 → 整轮卡死。 */
let invokeInFlight = false;
// 视口窗口下界超出视口底的预取块数（qingniao round2 定值）
const WINDOW_PREFETCH = 4;

export type TranslateScope = "off" | "viewport" | "full";

/**
 * 当前翻译方向（**单源** = `useSettingsStore.target`）。
 *
 * 起跑（translate_document）与会话收口重建（render_translated）必须取同一个
 * 值：两处的 `data-bi` 编号空间不一致时，整表译文会错位到别的块。方向本身
 * 的变更入口是 `useDocStore.setTranslateTarget`（带一整套 reset），这里只读。
 */
const currentTarget = (): TargetLang => useSettingsStore.getState().target;


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
 * 另落 React state（partialBlocks 只存已定格的完整译文，tick 永不入表）。
 * （终审 M1）纯 tick 批次零 setState：30Hz 打字期间此前每 tick 都重建
 * partialBlocks 并 setState，徒增渲染抖动；只有批内出现 done/instant
 * （committed 语义落表）才拷贝 Map 并 setState。 */
function dispatchReveal(commits: RevealCommit[]) {
  if (commits.length === 0) return;
  const st = useTranslationStore.getState();
  let blocks = st.partialBlocks;
  let cursor = st.partialCursor;
  let changed = false;
  for (const c of commits) {
    revealPatcher?.(c);
    if (c.kind === "done" || c.kind === "instant") {
      if (!changed) {
        blocks = new Map(blocks); // 首个定格条目才拷贝（tick 批次零拷贝）
        changed = true;
      }
      // done/instant 按块携带全部 run：逐 run 落表（translation 模式 key=run
      // 索引、bilingual 模式 key=块索引），committed 重放水位取 run 索引上界。
      for (const r of c.runs) {
        blocks.set(r.index, r.text);
        cursor = Math.max(cursor, r.index + 1);
      }
    }
  }
  if (changed) useTranslationStore.setState({ partialBlocks: blocks, partialCursor: cursor });
}

/** 有未排空的 reveal 队列就起 rAF 驱动的 tick 循环；空闲/已在泵则不动。
 *
 * 为何不用 setInterval：
 * 1. Tauri WebView2（Chromium 内核）对最小化/失焦标签的 setInterval 会节流到
 *    ≥1000ms，即使窗口激活时嵌套在事件回调里的 setInterval 也常被合并。
 * 2. setInterval 不与显示器刷新对齐，每 tick 之间的间隔抖动会让用户看到
 *    "卡顿"——偶发 100ms 空隙后接着连发 3 次 commit，画面像"整块替换"。
 * 3. rAF 与显示器刷新同步(60Hz≈16.7ms)；revealTick 自带 wall-clock 自校准，
 *    哪怕某帧被跳过，下一帧会把 shown 推回正确位置，无累积漂移。
 * 4. typing 期间每帧调一次 revealTick 几乎零开销（纯比较运算），直到队列
 *    空才自然退出循环。 */
function pumpReveal() {
  if (revealRaf !== 0) return;
  if (revealIdle(revealState)) return;
  const step = () => {
    const out = revealTick(revealState, performance.now());
    revealState = out.state;
    dispatchReveal(out.commits);
    if (revealIdle(revealState)) {
      revealRaf = 0;
      return;
    }
    revealRaf = requestAnimationFrame(step);
  };
  revealRaf = requestAnimationFrame(step);
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
    // （终审 I1）gen===0 守卫已删：所有调用点都保证处于翻译会话中——
    // started 分支 gen=r.gen≥1；缓存窗口分支 gen 前跳≥1。gen 本就不递减，
    // 旧守卫在纯缓存热会话里反而把合法重建挡死。
    if (st.status === "running") return;
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
        currentTarget(),
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
  if (p.gen !== st.gen) {
    // gen 失配：running 中属陈旧轮次（前一轮迟到/作废事件），丢弃；空闲时
    // 可能是 Started 响应未到的新一轮早期事件（cache 命中 partial 在 worker
    // 起跑瞬间先于 invoke 响应到达）→ 入缓冲，Started 落定后按 gen 回放。
    // 异代（不匹配任何在途 run）同样丢弃。
    if (st.status === "running") return;
    const nb = earlyPush(earlyBuf, p);
    if (nb !== earlyBuf) earlyBuf = nb;
    return;
  }
  if (st.status !== "running") return;
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与当前内容错位，宁缺勿错
  // （与 handleDone 的 runContent 护栏同一口径）。
  if (useDocStore.getState().doc?.content !== st.runContent) return;
  // 模式护栏：批次期间切换阅读模式 ⇒ partial 的 index 空间（runs/块）与当前
  // 预览锚点错位，宁缺勿错（与上方 runContent 护栏同口径；换挡补跑由 done 处理）。
  if (useDocStore.getState().mode !== st.lastRunMode) return;
  receivedRuns.add(p.index); // 诊断计数：事件已到（含 failed/streaming）
  // 单元失败（原文回退）：照常推进打字机放行——否则该 run 缺失会让其后
  // 所有块永久等位（done 前全部 pending、done 一次性回填）。
  // 失败 run 不打字，块内其余 run 照常打；done/instant 落地时回打原文 = no-op。
  if (p.failed) failedRuns.add(p.index);
  // 单单元裸发增量：直写 DOM（灰字+省略号），不经过打字机队列——这就是
  // qingniao `TranslationState::Streaming` 的"逐字吐出"；完整 Unit 到达再定格。
  if (p.streaming) {
    streamed.add(p.index);
    const sb = blockOfRun.get(p.index);
    if (sb !== undefined) streamedBlock.add(sb); // 所属块整块定格（防重打闪回）
    revealPatcher?.({ kind: "stream", index: p.index, text: p.text });
    return;
  }
  const next = typewriterPush(twState, p.index, p.text, p.from_cache);
  twState = next.state;
  if (next.released.length === 0) return;
  for (const r of next.released) {
    const b = blockOfRun.get(r.index);
    if (b === undefined) {
      // 兜底：收集序列必带块映射；无映射按 run 自身即时上屏
      dispatchReveal([{ kind: "instant", index: r.index, runs: [{ index: r.index, text: r.text }] }]);
      continue;
    }
    // 同一块的 run 在文档序中连续、按序放行；bucket 攒满 = 块凑齐 → 整段打字。
    let bucket = blockAssembly.get(b);
    if (!bucket) {
      bucket = new Map();
      blockAssembly.set(b, bucket);
    }
    bucket.set(r.index, r);
    if (bucket.size < (blockRunCounts.get(b) ?? 1)) continue;
    blockAssembly.delete(b);
    const rels = Array.from(bucket.values()).sort((x, y) => x.index - y.index);
    const runs: RevealRun[] = rels.map((rel) => ({
      index: rel.index,
      text: rel.text,
      failed: failedRuns.has(rel.index),
    }));
    // 整块定格条件：流式直显过（样式已上屏）或全部缓存命中；否则进打字队列
    const instant = streamedBlock.has(b) || rels.every((rel) => rel.fromCache);
    streamedBlock.delete(b);
    if (instant) {
      dispatchReveal([{ kind: "instant", index: b, runs }]);
      continue;
    }
    const out = revealPush(revealState, { index: b, runs }, false);
    revealState = out.state;
    dispatchReveal(out.commits);
  }
  pumpReveal();
}

/** 起跑时重置打字流（committed 保留——已定格译文跨窗口持续显示）。
 * 入参为本轮收集索引的完整文档序序列（终审 C1：缺口序列不再被
 * "连续 +1"游标误卡，见 typewriter.ts）及等长 run→块映射
 * （indices_blocks：前端把同一块的 run 组装成"整段"打字单元）。 */
function resetStream(indices: number[], indicesBlocks: number[]) {
  twState = typewriterStart(indices);
  receivedRuns.clear();
  failedRuns.clear();
  streamed.clear();
  streamedBlock.clear();
  blockAssembly = new Map();
  blockOfRun = new Map();
  blockRunCounts = new Map();
  for (let i = 0; i < indices.length; i++) {
    const runIdx = indices[i];
    const b = indicesBlocks[i] ?? runIdx;
    blockOfRun.set(runIdx, b);
    blockRunCounts.set(b, (blockRunCounts.get(b) ?? 0) + 1);
  }
}

/** 彻底清显示（全文 done 落整树 / 切原文 / 内容过期）。 */
function clearAll() {
  twState = typewriterStart();
  earlyBuf = earlyStart();
  receivedRuns.clear();
  failedRuns.clear();
  streamed.clear();
  streamedBlock.clear();
  blockAssembly = new Map();
  blockOfRun = new Map();
  blockRunCounts = new Map();
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
  // 运行时诊断：本轮 seq 中未收到 partial 的 run（事件被丢弃/丢失——打字机
  // 等位卡死的直接证据；修复后正常应为空）。
  const missingRuns = twState.seq.filter((i) => !receivedRuns.has(i));
  if (missingRuns.length > 0) {
    console.warn(
      `[translation] gen ${d.gen} done：缺 ${missingRuns.length}/${twState.seq.length} 个 run 事件 [${missingRuns.join(",")}] → 兜底定格`,
    );
  }
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
    // 窗口化：缺事件 run 先由 done 载荷兜底定格上屏（否则整树重建时
    // 一次性回填）；merge 累积（不整表 replace）；显示层继续走 committed/打字
    drainPendingToDom(d);
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
  // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与 payload html 全部过期，宁缺勿错不落库。
  const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
  if (!contentFresh) {
    clearAll();
    useTranslationStore.setState({ status: "idle", progress: null });
  } else {
    // 不整树立即回填（避免"一大块变中文"）：未放行/流式直显块先定格上屏，
    // 已入队块继续打字；等 reveal 排空后再整树替换收口（结构对齐，视觉无感）。
    finalizeAfterReveal(d, ui, dd.doc?.name ?? "");
  }
  // 换挡补跑（startIfFresh 语义的收尾）：跑批期间用户切到另一翻译模式时，
  // 本轮 payload 形态与新模式不匹配 ⇒ 立刻按新模式补跑（后端缓存使重复批次近乎零成本）。
  if (dd.mode !== "original" && st.lastRunMode !== dd.mode) {
    useTranslationStore.getState().startIfFresh();
  }
}

/** done 兜底排空：把仍未放行/未组装的 run 从 done 载荷定格上屏
 * （窗口化与全文分支共用）。缺事件 run 的块在此补上，避免"整树重建时
 * 一次性回填"或"整块空白直到 rebuild"。 */
function drainPendingToDom(d: DonePayload) {
  const doneMap = new Map(d.translations ?? []);
  const todo: RevealCommit[] = [];
  // typewriter 等位清空：未放行 run 从 done 载荷定格上屏（partial 可能缺失）
  for (const [, rel] of twState.pending) {
    const b = blockOfRun.get(rel.index) ?? rel.index;
    todo.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: doneMap.get(rel.index) ?? rel.text }] });
  }
  twState = typewriterStart();
  // 块组装残留（run 已放行但块未凑齐，如缺失/失败 run）→ 逐 run 定格
  for (const bucket of blockAssembly.values()) {
    for (const rel of bucket.values()) {
      const b = blockOfRun.get(rel.index) ?? rel.index;
      todo.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: doneMap.get(rel.index) ?? rel.text }] });
    }
  }
  blockAssembly = new Map();
  // 流式直显中的 run：定格（移除省略号/灰字样式）
  for (const [index, text] of doneMap) {
    if (streamed.has(index)) {
      streamed.delete(index);
      const b = blockOfRun.get(index) ?? index;
      todo.push({ kind: "instant", index: b, runs: [{ index, text }] });
    }
  }
  streamed.clear();
  streamedBlock.clear();
  dispatchReveal(todo);
}

function finalizeAfterReveal(
  d: DonePayload,
  ui: ReturnType<typeof useUiStore.getState>,
  docName: string,
) {
  drainPendingToDom(d);
  waitRevealIdle(() => {
    const st2 = useTranslationStore.getState();
    if (st2.gen !== d.gen) return; // 新一轮已起跑，旧 done 不落库
    const dd2 = useDocStore.getState();
    if (!dd2.doc || dd2.doc.content !== st2.runContent) return;
    useDocStore.getState().applyTranslationResult(
      new Map(d.translations ?? []),
      doneHtmlOf(d, st2.runContent!),
    );
    useTranslationStore.setState({ status: "idle", progress: null });
    ui.addToast("success", `翻译完成（${docName}）`);
  });
}

/** 等 reveal 队列排空后回调（rAF 轮询，超时兜底）。 */
function waitRevealIdle(fn: () => void, timeoutMs = 5000) {
  const start = performance.now();
  const check = () => {
    if (revealIdle(revealState) || performance.now() - start > timeoutMs) {
      fn();
      return;
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
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
    if (get().status === "running" || invokeInFlight) return;
    // scope 化：显式传入优先；否则沿用当前 scope，off 则默认视口按需
    const sc: TranslateScope = scope ?? (get().scope === "off" ? "viewport" : get().scope);
    const win = sc === "viewport" ? currentWindow(get()) : null;
    const genBefore = get().gen;
    invokeInFlight = true;
    earlyBuf = earlyStart(); // 上一轮残留缓冲作废（gen 不同取不回；防御清理）
    try {
      const r = await api.translateDocument(
        dd.doc.content,
        dd.mode,
        sp.provider,
        useSettingsStore.getState().credsFor(sp.provider),
        win,
        currentTarget(),
      );
      if (r.kind === "cached") {
        const d = r.done;
        if (win) {
          // （终审 I1）窗口化缓存全命中：先落会话上下文，与 started 分支同口径——
          // 此前只写 scope/lastWindow，两条失效路径：① 全新会话全缓存命中时
          // gen/partialGen 恒 0，scheduleCanonicalRebuild 与 committed 重放
          // 水位双双失明；② 会话跑过文档 A 再开文档 B 全命中时 runContent
          // 停在 A，重建/重放的内容护栏误判 stale。gen 前跳开新纪元（epoch
          // = gen），partialGen 同轮绑定；runContent/lastRunMode 供护栏比对。
          // 不设 status/progress：无流式，状态保持 idle。
          const epoch = get().gen + 1;
          set({
            scope: sc,
            lastWindow: win,
            gen: epoch,
            runContent: dd.doc.content,
            lastRunMode: dd.mode,
            partialGen: epoch,
          });
          useDocStore.getState().mergeTranslations(d.translations ?? []);
          dispatchReveal(
            (d.translations ?? []).map(
              ([index, text]) => ({ kind: "instant", index, runs: [{ index, text }] }) as RevealCommit,
            ),
          );
          scheduleCanonicalRebuild();
          return; // 无 toast：窗口化不打扰（进度语义由后续 run 承担）
        }
        // 缓存全命中：产物随返回值同步直达（不经事件通道），直接落库展示，
        // 不进 running 态——进度条不出场，也无 done/invoke 到达顺序竞态。
        useDocStore.getState().applyTranslationResult(new Map(d.translations ?? []), doneHtmlOf(d, dd.doc.content));
        useUiStore.getState().addToast("success", `翻译完成（${dd.doc.name}·缓存）`);
        return;
      }
      // 代际守卫（与下方 catch 分支同口径）：await 期间 stop()/resetDisplay()/
      // 切方向已令 gen 前跳的，本响应整体作废——后端已收到取消，不会再有同
      // gen 的 partial/progress/done。强行 set 会把 status 拉回 running 而事件
      // 永不再来 → 整轮永久卡死，后续 translateDocument/startIfFresh 全被挡。
      if (get().gen !== genBefore) return;
      // runContent 与 gen 同轮绑定：done 事件据此判 payload 产物是否仍与当前内容一致
      resetStream(r.indices, r.indices_blocks); // 新打字流放行序列 + run→块映射（整段组装）
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
        // (Task 11-b) partial 流所属轮次落定——Task 9 起此字段只清零从不置值
        //（其报告披露的"永 0 残留字段"，重接责任在本任务）：置值后
        // resetDisplayIfStale 的流式期门（partialGen!==0）真正生效（纯打字
        // 期间编辑也能 clearAll），PreviewView 的 committed 重放水位同源。
        // cached 路径无独立 gen（不入 running、无打字流），维持原值。
        partialGen: r.gen,
      }); // 进度等首个事件
      // 回放 Started 落定前到达的早期事件（cache 命中 partial 等）——根因修复：
      // 此前这些事件被 gen/status 护栏丢弃 → 对应 run 永不满桶 → 打字机等位
      // 卡死 → done 一次性回填。
      const taken = earlyTake(earlyBuf, r.gen);
      earlyBuf = taken.buf;
      for (const p of taken.items) handlePartial(p);
      pumpReveal();
    } catch (e) {
      earlyBuf = earlyStart();
      // 防御：仅当本轮 invoke 尚未被其他 run 取代（gen 未前跳）时收口 error。
      // 双发/竞态下第二发被后端拒绝时，若强置 error 会把在途 run 的后续
      // partial 全挡在 status 护栏外 → 整轮卡死。
      if (get().gen === genBefore) {
        // （终审 M2）scope 一并收口：失败后 scope 若仍停在 viewport，滚动
        // 事件会经 setViewport 的会话门反复重试 + 反复 toast，形成循环。
        set({ status: "error", scope: "off" });
        useUiStore.getState().addToast("error", `发起翻译失败：${errText(e)}`);
      }
    } finally {
      invokeInFlight = false;
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
    // (Task 11-a) 在途 run 一并作废：switchMode（Task 10 接线）可在 running 中
    // 调用——只清 lastWindow 不 bump gen 时，窗口化 run 的迟到 done（payload 无
    // 整树 html）会因 windowed 判定翻转误入全文分支：doneHtmlOf → null →
    // applyTranslationResult 用窗口子集整表替换 translations 并清掉 doneHtml。
    // gen 前跳使在途 progress/partial/done 全部失配丢弃；status/progress 同步
    // 归位——否则 done 被丢弃后 status 永久卡 running，后续 translateDocument
    // 与 startIfFresh 全被挡死。确实在跑时顺带通知后端取消（与 stop() 同通道），
    // 不让已作废的 run 继续空烧 token。
    const wasRunning = get().status === "running";
    set((s) => ({
      gen: s.gen + 1,
      status: "idle",
      progress: null,
      scope: "off",
      viewport: null,
      lastWindow: null,
    }));
    if (wasRunning) api.stopTranslation().catch(() => {});
    clearAll();
  },

  resetDisplayIfStale: (content) => {
    const st = get();
    if (st.runContent !== null && st.runContent !== content) {
      // （终审 I2）索引对绑定的是发起批次时的内容：内容已变则 active tab 的
      // translations 整表作废——陈旧索引对在新内容下会把错误文本渲染到错误
      // 块（宁缺勿错；缓存使重译廉价，正确性优先）。与下方显示清流互不条件：
      // 无流式/无定格时也要清表，否则部分编辑路径漏清。
      useDocStore.getState().clearTranslations();
      if (st.partialGen !== 0 || st.partialBlocks.size > 0) {
        clearAll();
        set({ scope: "off", lastWindow: null });
      }
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
    earlyBuf = earlyStart();
    receivedRuns.clear();
    // 块组装残留（取消中断，块未凑齐）→ 已放行 run 即时落地
    const tail: RevealCommit[] = [];
    for (const bucket of blockAssembly.values()) {
      for (const rel of bucket.values()) {
        const b = blockOfRun.get(rel.index) ?? rel.index;
        tail.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: rel.text }] });
      }
    }
    blockAssembly = new Map();
    dispatchReveal(tail);
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
