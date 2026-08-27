// T28 命令面板：Ctrl+Shift+P 唤出（App.tsx 注册全局键），命令清单见 commands.ts。
// fzf 式 substring 即时过滤（label + keywords，大小写不敏感），↑↓ 循环移动、
// Enter 执行、Esc 关闭；条件挂载（ui.commandPaletteOpen），每次打开都是全新查询。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUiStore } from "../stores/useUiStore";
import { COMMANDS, type Command } from "./commands";

export default function CommandPalette() {
  const close = useUiStore((s) => s.closePalette);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // 打开时求值 enabled + 查询过滤（重新挂载保证读到最新 store 态）
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const avail = COMMANDS.filter((c) => c.enabled?.() ?? true);
    if (!q) return avail;
    return avail.filter((c) =>
      [c.label, ...(c.keywords ?? [])].some((t) => t.toLowerCase().includes(q)),
    );
  }, [query]);

  useEffect(() => inputRef.current?.focus(), []);

  // 过滤收窄时钳制选中项回首
  useEffect(() => {
    setSel((s) => (s < items.length ? s : 0));
  }, [items.length]);

  // 键位选中项滚动到可视区；mouse 悬停即同步选中，无需单独 hover 样式
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length) setSel((s) => (s + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setSel((s) => (s - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault(); // Modal 壳的 window 级 Esc 监听按 defaultPrevented 让路
      close();
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="输入命令…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list" role="listbox" ref={listRef}>
          {items.map((c, i) => (
            <li key={c.label}>
              <button
                type="button"
                role="option"
                aria-selected={i === sel}
                className="palette-item"
                onMouseMove={() => setSel(i)}
                onClick={() => run(c)}
              >
                {c.label}
              </button>
            </li>
          ))}
          {!items.length && <li className="palette-empty">无匹配命令</li>}
        </ul>
      </div>
    </div>
  );
}
