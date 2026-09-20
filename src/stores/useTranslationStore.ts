// 翻译域：整篇翻译的 gen 时序、进度、划词翻译浮窗结果。
// 阅读模式不在此存——唯一真源是 useDocStore.mode（plan 防双源决议）。
// （P2-8a）流域可变单例与事件处理器拆至 lib/translationStream（整篇翻译流：
// 打字机/reveal/块组装/早期事件缓冲/invoke 闩）与 lib/lookupStream（划词查词流：
// 防抖/delta 渐进解析/分流请求）；本文件只留类型、React 可见状态与动作门面，
// 公开 API 与导出面不变（parsePartialLookup 经此 re-export）。
import { create } from "zustand";
import type {
  DonePayload,
  Mode,
  TargetLang,
  WordLookupDTO,
} from "../types/ipc";
import { api } from "../lib/ipc";
import type { RevealCommit } from "../lib/reveal";
import { translationStream } from "../lib/translationStream";
import { lookupStream } from "../lib/lookupStream";
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
export const currentTarget = (): TargetLang => useSettingsStore.getState().target;

/** done payload → 标签化落库形态（事件路径与缓存同步路径共用同一组装） */
export function doneHtmlOf(d: DonePayload, contentKey: string) {
  return d.html_translation || d.html_bilingual
    ? {
        contentKey,
        mode: (d.html_translation ? "translation" : "bilingual") as Exclude<Mode, "original">,
        html: (d.html_translation ?? d.html_bilingual)!,
      }
    : null;
}

/** 当前视口 → 窗口（块索引空间，含预取）；无上报回退 [0, PREFETCH)。 */
export function currentWindow(st: { viewport: { top: number; bottom: number } | null }): [number, number] {
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
    if (get().status === "running" || translationStream.isInvokeInFlight()) return;
    // scope 化：显式传入优先；否则沿用当前 scope，off 则默认视口按需
    const sc: TranslateScope = scope ?? (get().scope === "off" ? "viewport" : get().scope);
    const win = sc === "viewport" ? currentWindow(get()) : null;
    const genBefore = get().gen;
    translationStream.setInvokeInFlight(true);
    translationStream.resetEarlyBuf(); // 上一轮残留缓冲作废（gen 不同取不回；防御清理）
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
          translationStream.dispatchReveal(
            (d.translations ?? []).map(
              ([index, text]) => ({ kind: "instant", index, runs: [{ index, text }] }) as RevealCommit,
            ),
          );
          translationStream.scheduleCanonicalRebuild();
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
      translationStream.resetStream(r.indices, r.indices_blocks); // 新打字流放行序列 + run→块映射（整段组装）
      if (win) {
        translationStream.setRegionAndDispatch(win[0], win[1]);
      } else {
        // 全文 run：重开区域为缺省全区 [0, ∞)。上一窗口化 run 的区域若无此
        // 重置会残留：区域外的 partial 卡在队首，revealTick 空转分支既不上屏
        // 也不出队，只能等 done 的 clearAll→drain 兜底；中途停止时队列永排
        // 不空，30ms tick 空转泄漏。极端情形下残留项会被重锚 flush 成
        // done/instant 立即上屏（均为同内容合法译文，全文 done 随后整树替换）。
        translationStream.setRegionAndDispatch(0, Infinity);
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
      translationStream.replayEarly(r.gen);
      translationStream.pumpReveal();
    } catch (e) {
      translationStream.resetEarlyBuf();
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
      translationStream.setInvokeInFlight(false);
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
    translationStream.setPatcher(fn);
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
    translationStream.clearAll();
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
        translationStream.clearAll();
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
    translationStream.listenProgress();
  },

  listenDone: () => {
    translationStream.listenDone();
  },

  listenPartial: () => {
    translationStream.listenPartial();
  },

  listenLookupDelta: () => {
    lookupStream.listenDelta();
  },

  stop: () => {
    // gen 前跳使同轮迟到的 done 失配而被丢弃（后端取消会丢弃部分产物）
    set((s) => ({ gen: s.gen + 1, status: "idle", progress: null, scope: "off", lastWindow: null }));
    // 打字流等位丢弃（缺口永不再来），已定格/打字中保留自然收尾
    translationStream.discardForStop();
    api.stopTranslation().catch(() => {});
  },

  translateSelection: (text) => {
    lookupStream.request(text);
  },

  clearSelection: () => {
    lookupStream.cancel();
  },
}));

export { type SelectionState };
export { parsePartialLookup } from "../lib/lookupStream";
