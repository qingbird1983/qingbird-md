// 划词查词的流式单例（P2-8a 自 stores/useTranslationStore 纯提取，逐字搬移）：
// 防抖定时器、lookup-delta 渐进解析与乱序护栏、LLM/现状源分流请求。
// selection 状态本身是 React 可见状态，仍落 useTranslationStore；本类只持有
// 不可 React 化的 selTimer 单例与监听哨兵。
import type { LookupDeltaPayload, WordLookupDTO } from "../types/ipc";
import { api } from "./ipc";
import { errText } from "../stores/useUiStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTranslationStore } from "../stores/useTranslationStore";

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

/** 划词查词流的可变单例容器：字段=原模块级 let selTimer/deltaRegistered。 */
export class LookupStream {
  private selTimer: ReturnType<typeof setTimeout> | undefined;
  private deltaRegistered = false;

  listenDelta() {
    if (this.deltaRegistered) return;
    this.deltaRegistered = true;
    void api.listenLookupDelta((p) => this.handleLookupDelta(p));
  }

  /** lookup-delta → 浮窗渐进刷新（原 handleLookupDelta 逐字）。 */
  private handleLookupDelta(p: LookupDeltaPayload) {
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

  /** 划词查词请求（原 translateSelection 体逐字；set/get → setState/getState）。 */
  request(text: string) {
    const store = useTranslationStore;
    clearTimeout(this.selTimer);
    if (!text.trim()) {
      store.setState({ selection: null });
      return;
    }
    store.setState({ selection: { text, loading: true, streaming: false, plain: null, rich: null, error: null } });
    this.selTimer = setTimeout(async () => {
      const sp = useSettingsStore.getState().settings;
      const cur = () => store.getState().selection;
      const settle = (patch: {
        plain: string | null;
        rich: WordLookupDTO | null;
        error: string | null;
      }) => {
        // 防乱序：只有仍是本次请求在展示时才回填；streaming 同时收口
        if (cur()?.text === text) store.setState({ selection: { text, loading: false, streaming: false, ...patch } });
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
      if (cur()?.text === text) store.setState((s0) => ({ selection: s0.selection ? { ...s0.selection, streaming: true } : null }));
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
  }

  /** 清浮窗（原 clearSelection 逐字）。 */
  cancel() {
    clearTimeout(this.selTimer);
    useTranslationStore.setState({ selection: null });
  }
}

export const lookupStream = new LookupStream();
