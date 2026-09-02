// T24 划词翻译浮窗 → 选区查词富卡片（spec 2026-08-29 §8.2，卡片 A 纵向层级）：
// rich(word) = 词头(原词+IPA+词性)/译文/用法/例句(原词着重)/生僻词；
// rich(sentence) = 整句译文；plain = 未配 LLM 的现状回落；error = 显式失败。
// 选区捕获、300ms 防抖、乱序保护在 store；本组件纯渲染 + Esc/点外关闭（不变）。
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslationStore } from "../stores/useTranslationStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import type { WordLookupDTO } from "../types/ipc";

/** 例句原词着重（大小写不敏感）。纯节点切分，不走 innerHTML（LLM 输出不可信）。 */
function Emphasized({ text, word }: { text: string; word: string }) {
  if (!word) return <>{text}</>;
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(w, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<em key={hit}>{text.slice(hit, hit + w.length)}</em>);
    i = hit + w.length;
  }
  return <>{parts}</>;
}

function WordCard({ rich, word }: { rich: WordLookupDTO; word: string }) {
  if (rich.kind === "sentence") {
    return <div className="sel-pop-res">{rich.translation}</div>;
  }
  return (
    <div className="sel-pop-rich">
      <div className="sel-pop-wordhead">
        <span className="sel-pop-term">{word}</span>
        {rich.phonetic && <span className="sel-pop-phon">{rich.phonetic}</span>}
        {rich.part_of_speech && <span className="sel-pop-pos">{rich.part_of_speech}</span>}
      </div>
      <div className="sel-pop-main">{rich.translation}</div>
      {rich.usage && <div className="sel-pop-usage">{rich.usage}</div>}
      {rich.examples.length > 0 && (
        <div className="sel-pop-block">
          <div className="sel-pop-label">例句</div>
          {rich.examples.map((ex, i) => (
            <div className="sel-pop-example" key={i}>
              <div className="sel-pop-en">
                <Emphasized text={ex.en} word={word} />
              </div>
              {ex.zh && <div className="sel-pop-zh">{ex.zh}</div>}
            </div>
          ))}
        </div>
      )}
      {rich.terms.length > 0 && (
        <div className="sel-pop-block sel-pop-terms">
          <div className="sel-pop-label">生僻词</div>
          {rich.terms.map((t, i) => (
            <div className="sel-pop-termrow" key={i}>
              <b>{t.word}</b>
              {t.phonetic && <span className="sel-pop-phon">{t.phonetic}</span>}
              {t.explanation && <span className="sel-pop-termexp"> — {t.explanation}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SelectionPopup() {
  const sel = useTranslationStore((s) => s.selection);
  const clearSelection = useTranslationStore((s) => s.clearSelection);
  const on = useSettingsStore((s) => s.settings?.selection_translate ?? false);
  const ref = useRef<HTMLDivElement>(null);

  // 开关关闭：render 即时隐藏之外还要清态——clearSelection 连带清防抖定时器，
  // 在途请求结果也因子代失配（selection 已为 null）被丢弃，重开不闪旧结果。
  useEffect(() => {
    if (!on) clearSelection();
  }, [on, clearSelection]);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    const onDown = (e: MouseEvent) => {
      // 浮窗外按下（含在编辑器里开始新的拖选）即关闭；新选区随后自然重触发
      if (ref.current && !ref.current.contains(e.target as Node)) clearSelection();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [sel, clearSelection]);

  if (!on || !sel) return null;

  return (
    <div className="sel-pop" ref={ref} role="dialog" aria-label="划词翻译">
      <div className="sel-pop-head">
        <span className="sel-pop-title">划词翻译</span>
        <button type="button" className="sel-pop-clear" onClick={clearSelection}>
          清除
        </button>
      </div>
      {sel.loading ? (
        <div className="sel-pop-spin" aria-label="翻译中" />
      ) : sel.error ? (
        <div className="sel-pop-res sel-pop-err">{sel.error}</div>
      ) : sel.rich ? (
        <WordCard rich={sel.rich} word={sel.text} />
      ) : (
        <>
          <div className="sel-pop-src">{sel.text}</div>
          <div className="sel-pop-sep" />
          <div className="sel-pop-res">{sel.plain}</div>
        </>
      )}
    </div>
  );
}
