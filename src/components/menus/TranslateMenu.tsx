// 翻译菜单：原文/译文/中英对照三态 + 「重新翻译」（当前模式强制重跑 translateDocument）。
// 无文档时全部禁用（翻译域没有可作用对象）；翻译进行中「重新翻译」禁用防重入。
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
          <MenuItem
            label={running ? "翻译中…" : "重新翻译"}
            disabled={!hasDoc || mode === "original" || running}
            onSelect={() => {
              close();
              void retranslate();
            }}
          />
        </>
      )}
    </Menu>
  );
}
