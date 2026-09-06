// 翻译菜单：原文/译文/中英对照三态 + 「重新翻译」（当前模式强制重跑
// translateDocument）+ 「翻译全文」（无视口按需，一次跑完全文）。
// 无文档时全部禁用（翻译域没有可作用对象）；翻译进行中两个翻译入口均禁用防重入。
import { useDocStore } from "../../stores/useDocStore";
import { useTranslationStore } from "../../stores/useTranslationStore";
import Menu, { MenuItem, MenuSep } from "./Menu";

const MODES: Array<{ m: "original" | "translation" | "bilingual"; label: string }> = [
  { m: "original", label: "原文" },
  { m: "translation", label: "译文" },
  { m: "bilingual", label: "中英对照" },
];

export default function TranslateMenu() {
  const mode = useDocStore((s) => s.mode);
  const hasDoc = useDocStore((s) => !!s.doc);
  const switchMode = useDocStore((s) => s.switchMode);
  const running = useTranslationStore((s) => s.status === "running");
  const retranslate = useTranslationStore((s) => s.translateDocument);
  const translateFull = useTranslationStore((s) => s.translateFull);

  return (
    <Menu label="翻译">
      {(close) => (
        <>
          {MODES.map(({ m, label }) => (
            <MenuItem
              key={m}
              label={label}
              active={mode === m}
              disabled={!hasDoc}
              onSelect={() => {
                close();
                switchMode(m);
              }}
            />
          ))}
          <MenuSep />
          {/* 视口按需重跑（当前模式强制重跑当前窗口起） */}
          <MenuItem
            label={running ? "翻译中…" : "重新翻译"}
            disabled={!hasDoc || mode === "original" || running}
            onSelect={() => {
              close();
              void retranslate();
            }}
          />
          {/* 整篇翻译：无视口按需，一次跑完全文（qingniao 全文入口语义） */}
          <MenuItem
            label="翻译全文"
            disabled={!hasDoc || mode === "original" || running}
            onSelect={() => {
              close();
              translateFull();
            }}
          />
        </>
      )}
    </Menu>
  );
}
