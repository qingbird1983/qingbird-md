// 整篇翻译的流式单例（P2-8a 自 stores/useTranslationStore 纯提取，逐字搬移）：
// 打字机缓冲、reveal 队列与 rAF 泵、块组装、早期事件缓冲、invoke 在飞闩，以及
// partial/progress/done 三条事件通道的处理器。可变单例收进 TranslationStream
// 类实例；React 可见状态仍只落 useTranslationStore（经 setState/getState）。
import type {
  DonePayload,
  Mode,
  ProgressPayload,
  TranslationPartialPayload,
} from "../types/ipc";
import { api } from "./ipc";
import { typewriterPush, typewriterStart, type TypewriterState, type Released } from "./typewriter";
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
} from "./reveal";
import { earlyPush, earlyStart, earlyTake, type EarlyBuffer } from "./earlyPartial";
import { useUiStore } from "../stores/useUiStore";
import { useDocStore } from "../stores/useDocStore";
import {
  useTranslationStore,
  currentTarget,
  currentWindow,
  doneHtmlOf,
} from "../stores/useTranslationStore";

function sameWindow(a: [number, number] | null, b: [number, number] | null): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
}

/** 整篇翻译流的可变单例容器：字段=原模块级 let 变量、方法=原模块级函数（逐字）。 */
export class TranslationStream {
  // 同步哨兵防 StrictMode 双跑重复注册；句柄无处清理（应用级单例监听）
  private progressRegistered = false;
  private doneRegistered = false;
  private partialRegistered = false;
  // 打字机缓冲 + reveal 队列（不进 React state：tick 不驱动渲染，只有放行结果才 set）
  private twState: TypewriterState = typewriterStart();
  private revealState: RevealState = revealStart();
  private revealRaf = 0;
  private revealPatcher: ((c: RevealCommit) => void) | null = null;
  /** 单单元裸发路径已流式直显（灰字+省略号）的 run；完整 Unit 到达时定格 */
  /** 本轮标记翻译失败（原文回退）的 run：跳过打字、推进放行，避免缺位卡死 */
  private failedRuns = new Set<number>();
  private streamed = new Set<number>();
  /** 流式直显过的 run 所属块：整块定格收样式，避免块打字时把已直显 run 重打闪回 */
  private streamedBlock = new Set<number>();
  /** run → 所属块（本轮收集；data-bi 空间，来自 TranslateStart.indices_blocks） */
  private blockOfRun = new Map<number, number>();
  /** 块 → 期望收集 run 数（块组装完成判定；bilingual 模式恒 1） */
  private blockRunCounts = new Map<number, number>();
  /** 块 → 已放行待组装的 run（bucket：runIndex → Released） */
  private blockAssembly = new Map<number, Map<number, Released>>();
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /** Started 响应未到前到达的早期事件缓冲（cache 命中 partial 等）。worker 起跑
   * 瞬间先发 cache 命中，先于 invoke 响应到前端；gen/status 护栏会丢 → 打字机
   * 等位卡死 → done 一次性回填。缓冲到 Started 落定后按 gen 回放（根因修复）。 */
  private earlyBuf: EarlyBuffer = earlyStart();
  /** 本轮已收到事件的 run 索引（done 时对比 seq 找缺失，运行时诊断） */
  private receivedRuns = new Set<number>();
  /** translate_document invoke 在飞闩：handleDone 自动续跑与 setViewport 都可能
   * 在 status=idle 时触发新 run，双发 invoke 会让第二发被后端拒绝 → 前端 catch
   * 误置 error 态 → 在途 run 的后续 partial 全部被 status 护栏丢弃 → 整轮卡死。 */
  private invokeInFlight = false;

  listenProgress() {
    if (this.progressRegistered) return;
    this.progressRegistered = true;
    void api.listenProgress((p) => this.handleProgress(p));
  }

  listenDone() {
    if (this.doneRegistered) return;
    this.doneRegistered = true;
    void api.listenDone((d) => this.handleDone(d));
  }

  listenPartial() {
    if (this.partialRegistered) return;
    this.partialRegistered = true;
    void api.listenPartial((p) => this.handlePartial(p));
  }

  setPatcher(fn: ((c: RevealCommit) => void) | null) {
    this.revealPatcher = fn;
  }

  /** translate_document invoke 在飞闩的读写门（原模块级 let invokeInFlight）。 */
  isInvokeInFlight(): boolean {
    return this.invokeInFlight;
  }

  setInvokeInFlight(v: boolean) {
    this.invokeInFlight = v;
  }

  /** 早期事件缓冲重置（translateDocument 起跑前作废上一轮残留 / catch 清理）。 */
  resetEarlyBuf() {
    this.earlyBuf = earlyStart();
  }

  /** 回放 Started 落定前到达的早期事件（cache 命中 partial 等）。 */
  replayEarly(gen: number) {
    const taken = earlyTake(this.earlyBuf, gen);
    this.earlyBuf = taken.buf;
    for (const p of taken.items) this.handlePartial(p);
  }

  /** revealSetRegion + dispatchReveal 的固定三行接线（translateDocument 起跑设窗）。 */
  setRegionAndDispatch(a: number, b: number) {
    const out = revealSetRegion(this.revealState, a, b);
    this.revealState = out.state;
    this.dispatchReveal(out.commits);
  }

  /** stop 的流域中段：打字流等位丢弃（缺口永不再来），已定格/打字中保留自然收尾。 */
  discardForStop() {
    this.twState = typewriterStart();
    this.earlyBuf = earlyStart();
    this.receivedRuns.clear();
    // 块组装残留（取消中断，块未凑齐）→ 已放行 run 即时落地
    const tail: RevealCommit[] = [];
    for (const bucket of this.blockAssembly.values()) {
      for (const rel of bucket.values()) {
        const b = this.blockOfRun.get(rel.index) ?? rel.index;
        tail.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: rel.text }] });
      }
    }
    this.blockAssembly = new Map();
    this.dispatchReveal(tail);
    // 区域无界放开（±∞ 内不存在区域外索引 ⇒ 重锚 flush 集恒空，故不 dispatch）：
    // 已定格/打字中按 30ms 节奏自然排空；也排除「区域外残项卡住队首 →
    // revealIdle 恒 false → interval 30Hz 空转直到下次 setRegion/clearAll」的泄漏。
    const out = revealSetRegion(this.revealState, -Infinity, Infinity);
    this.revealState = out.state;
  }

  private handleProgress(p: ProgressPayload) {
    const st = useTranslationStore.getState();
    if (p.gen !== st.gen || st.status !== "running") return;
    useTranslationStore.setState({ progress: { done: p.done, total: p.total } });
  }

  /** reveal commit 分发：逐条喂给 PreviewView patcher（DOM 直写），done/instant
   * 另落 React state（partialBlocks 只存已定格的完整译文，tick 永不入表）。
   * （终审 M1）纯 tick 批次零 setState：30Hz 打字期间此前每 tick 都重建
   * partialBlocks 并 setState，徒增渲染抖动；只有批内出现 done/instant
   * （committed 语义落表）才拷贝 Map 并 setState。 */
  dispatchReveal(commits: RevealCommit[]) {
    if (commits.length === 0) return;
    const st = useTranslationStore.getState();
    let blocks = st.partialBlocks;
    let cursor = st.partialCursor;
    let changed = false;
    for (const c of commits) {
      this.revealPatcher?.(c);
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
  pumpReveal() {
    if (this.revealRaf !== 0) return;
    if (revealIdle(this.revealState)) return;
    const step = () => {
      const out = revealTick(this.revealState, performance.now());
      this.revealState = out.state;
      this.dispatchReveal(out.commits);
      if (revealIdle(this.revealState)) {
        this.revealRaf = 0;
        return;
      }
      this.revealRaf = requestAnimationFrame(step);
    };
    this.revealRaf = requestAnimationFrame(step);
  }

  /** 会话静默后用累积 translations 重建整树 canonical html（切视图/重渲兜底）。 */
  scheduleCanonicalRebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(async () => {
      const st = useTranslationStore.getState();
      const dd = useDocStore.getState();
      // （终审 I1）gen===0 守卫已删：所有调用点都保证处于翻译会话中——
      // started 分支 gen=r.gen≥1；缓存窗口分支 gen 前跳≥1。gen 本就不递减，
      // 旧守卫在纯缓存热会话里反而把合法重建挡死。
      if (st.status === "running") return;
      if (!dd.doc || dd.doc.content !== st.runContent) return;
      if (dd.mode === "original" || dd.translations.size === 0) return;
      if (!revealIdle(this.revealState)) {
        this.scheduleCanonicalRebuild(); // 还在打字：稍后再试
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
  private handlePartial(p: TranslationPartialPayload) {
    const st = useTranslationStore.getState();
    if (p.gen !== st.gen) {
      // gen 失配：running 中属陈旧轮次（前一轮迟到/作废事件），丢弃；空闲时
      // 可能是 Started 响应未到的新一轮早期事件（cache 命中 partial 在 worker
      // 起跑瞬间先于 invoke 响应到达）→ 入缓冲，Started 落定后按 gen 回放。
      // 异代（不匹配任何在途 run）同样丢弃。
      if (st.status === "running") return;
      const nb = earlyPush(this.earlyBuf, p);
      if (nb !== this.earlyBuf) this.earlyBuf = nb;
      return;
    }
    if (st.status !== "running") return;
    // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与当前内容错位，宁缺勿错
    // （与 handleDone 的 runContent 护栏同一口径）。
    if (useDocStore.getState().doc?.content !== st.runContent) return;
    // 模式护栏：批次期间切换阅读模式 ⇒ partial 的 index 空间（runs/块）与当前
    // 预览锚点错位，宁缺勿错（与上方 runContent 护栏同口径；换挡补跑由 done 处理）。
    if (useDocStore.getState().mode !== st.lastRunMode) return;
    this.receivedRuns.add(p.index); // 诊断计数：事件已到（含 failed/streaming）
    // 单元失败（原文回退）：照常推进打字机放行——否则该 run 缺失会让其后
    // 所有块永久等位（done 前全部 pending、done 一次性回填）。
    // 失败 run 不打字，块内其余 run 照常打；done/instant 落地时回打原文 = no-op。
    if (p.failed) this.failedRuns.add(p.index);
    // 单单元裸发增量：直写 DOM（灰字+省略号），不经过打字机队列——这就是
    // qingniao `TranslationState::Streaming` 的"逐字吐出"；完整 Unit 到达再定格。
    if (p.streaming) {
      this.streamed.add(p.index);
      const sb = this.blockOfRun.get(p.index);
      if (sb !== undefined) this.streamedBlock.add(sb); // 所属块整块定格（防重打闪回）
      this.revealPatcher?.({ kind: "stream", index: p.index, text: p.text });
      return;
    }
    const next = typewriterPush(this.twState, p.index, p.text, p.from_cache);
    this.twState = next.state;
    if (next.released.length === 0) return;
    for (const r of next.released) {
      const b = this.blockOfRun.get(r.index);
      if (b === undefined) {
        // 兜底：收集序列必带块映射；无映射按 run 自身即时上屏
        this.dispatchReveal([{ kind: "instant", index: r.index, runs: [{ index: r.index, text: r.text }] }]);
        continue;
      }
      // 同一块的 run 在文档序中连续、按序放行；bucket 攒满 = 块凑齐 → 整段打字。
      let bucket = this.blockAssembly.get(b);
      if (!bucket) {
        bucket = new Map();
        this.blockAssembly.set(b, bucket);
      }
      bucket.set(r.index, r);
      if (bucket.size < (this.blockRunCounts.get(b) ?? 1)) continue;
      this.blockAssembly.delete(b);
      const rels = Array.from(bucket.values()).sort((x, y) => x.index - y.index);
      const runs: RevealRun[] = rels.map((rel) => ({
        index: rel.index,
        text: rel.text,
        failed: this.failedRuns.has(rel.index),
      }));
      // 整块定格条件：流式直显过（样式已上屏）或全部缓存命中；否则进打字队列
      const instant = this.streamedBlock.has(b) || rels.every((rel) => rel.fromCache);
      this.streamedBlock.delete(b);
      if (instant) {
        this.dispatchReveal([{ kind: "instant", index: b, runs }]);
        continue;
      }
      const out = revealPush(this.revealState, { index: b, runs }, false);
      this.revealState = out.state;
      this.dispatchReveal(out.commits);
    }
    this.pumpReveal();
  }

  /** 起跑时重置打字流（committed 保留——已定格译文跨窗口持续显示）。
   * 入参为本轮收集索引的完整文档序序列（终审 C1：缺口序列不再被
   * "连续 +1"游标误卡，见 typewriter.ts）及等长 run→块映射
   * （indices_blocks：前端把同一块的 run 组装成"整段"打字单元）。 */
  resetStream(indices: number[], indicesBlocks: number[]) {
    this.twState = typewriterStart(indices);
    this.receivedRuns.clear();
    this.failedRuns.clear();
    this.streamed.clear();
    this.streamedBlock.clear();
    this.blockAssembly = new Map();
    this.blockOfRun = new Map();
    this.blockRunCounts = new Map();
    for (let i = 0; i < indices.length; i++) {
      const runIdx = indices[i];
      const b = indicesBlocks[i] ?? runIdx;
      this.blockOfRun.set(runIdx, b);
      this.blockRunCounts.set(b, (this.blockRunCounts.get(b) ?? 0) + 1);
    }
  }

  /** 彻底清显示（全文 done 落整树 / 切原文 / 内容过期）。 */
  clearAll() {
    this.twState = typewriterStart();
    this.earlyBuf = earlyStart();
    this.receivedRuns.clear();
    this.failedRuns.clear();
    this.streamed.clear();
    this.streamedBlock.clear();
    this.blockAssembly = new Map();
    this.blockOfRun = new Map();
    this.blockRunCounts = new Map();
    const out = revealDrain(this.revealState);
    this.revealState = out.state;
    this.dispatchReveal(out.commits);
    useTranslationStore.setState({
      partialBlocks: new Map(),
      partialCursor: 0,
      partialGen: 0,
    });
  }

  private handleDone(d: DonePayload) {
    const st = useTranslationStore.getState();
    if (d.gen !== st.gen) return; // 陈旧轮次直接丢弃
    const ui = useUiStore.getState();
    const dd = useDocStore.getState();
    if (!d.ok) {
      this.clearAll();
      useTranslationStore.setState({ status: "error", progress: null, scope: "off" });
      ui.addToast("error", d.error ? `翻译失败：${d.error}` : "翻译失败");
      return;
    }
    const windowed = st.lastWindow !== null;
    // 运行时诊断：本轮 seq 中未收到 partial 的 run（事件被丢弃/丢失——打字机
    // 等位卡死的直接证据；修复后正常应为空）。
    const missingRuns = this.twState.seq.filter((i) => !this.receivedRuns.has(i));
    if (missingRuns.length > 0) {
      console.warn(
        `[translation] gen ${d.gen} done：缺 ${missingRuns.length}/${this.twState.seq.length} 个 run 事件 [${missingRuns.join(",")}] → 兜底定格`,
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
      this.drainPendingToDom(d);
      useDocStore.getState().mergeTranslations(d.translations ?? []);
      useTranslationStore.setState({ status: "idle", progress: null });
      // RunDone 边界评估：当前视口窗口 ≠ 上轮 → 接着译新窗口；相同 → 收口
      const cur = currentWindow(useTranslationStore.getState());
      if (!sameWindow(cur, st.lastWindow)) {
        void useTranslationStore.getState().translateDocument();
      } else {
        this.scheduleCanonicalRebuild();
      }
      return;
    }
    // 内容护栏：批次期间文档被编辑/切换 ⇒ 段索引与 payload html 全部过期，宁缺勿错不落库。
    const contentFresh = !!dd.doc && dd.doc.content === st.runContent;
    if (!contentFresh) {
      this.clearAll();
      useTranslationStore.setState({ status: "idle", progress: null });
    } else {
      // 不整树立即回填（避免"一大块变中文"）：未放行/流式直显块先定格上屏，
      // 已入队块继续打字；等 reveal 排空后再整树替换收口（结构对齐，视觉无感）。
      this.finalizeAfterReveal(d, ui, dd.doc?.name ?? "");
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
  private drainPendingToDom(d: DonePayload) {
    const doneMap = new Map(d.translations ?? []);
    const todo: RevealCommit[] = [];
    // typewriter 等位清空：未放行 run 从 done 载荷定格上屏（partial 可能缺失）
    for (const [, rel] of this.twState.pending) {
      const b = this.blockOfRun.get(rel.index) ?? rel.index;
      todo.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: doneMap.get(rel.index) ?? rel.text }] });
    }
    this.twState = typewriterStart();
    // 块组装残留（run 已放行但块未凑齐，如缺失/失败 run）→ 逐 run 定格
    for (const bucket of this.blockAssembly.values()) {
      for (const rel of bucket.values()) {
        const b = this.blockOfRun.get(rel.index) ?? rel.index;
        todo.push({ kind: "instant", index: b, runs: [{ index: rel.index, text: doneMap.get(rel.index) ?? rel.text }] });
      }
    }
    this.blockAssembly = new Map();
    // 流式直显中的 run：定格（移除省略号/灰字样式）
    for (const [index, text] of doneMap) {
      if (this.streamed.has(index)) {
        this.streamed.delete(index);
        const b = this.blockOfRun.get(index) ?? index;
        todo.push({ kind: "instant", index: b, runs: [{ index, text }] });
      }
    }
    this.streamed.clear();
    this.streamedBlock.clear();
    this.dispatchReveal(todo);
  }

  private finalizeAfterReveal(
    d: DonePayload,
    ui: ReturnType<typeof useUiStore.getState>,
    docName: string,
  ) {
    this.drainPendingToDom(d);
    this.waitRevealIdle(() => {
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
  private waitRevealIdle(fn: () => void, timeoutMs = 5000) {
    const start = performance.now();
    const check = () => {
      if (revealIdle(this.revealState) || performance.now() - start > timeoutMs) {
        fn();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }
}

export const translationStream = new TranslationStream();
