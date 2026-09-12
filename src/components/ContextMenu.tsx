// 通用右键菜单（2026-09-12）：工作区树 / 预览区共用。
//
// 与 menus/Menu.tsx 的区别：那份是「锚定在触发按钮」的下拉，这份定位到鼠标点。
// 视觉完全复用 .menu-pop / .menu-item / .menu-sep，故两处观感一致。
//
// 关闭路径：点任意项、点菜单外、Esc、窗口失焦、滚动/缩放。定位带边界防溢出
// （右/下越界时反向收），菜单挂 fixed 层不参与父容器裁剪。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface CtxItem {
  kind?: "item";
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /**
   * 右侧显示的快捷键提示。**只写真实接线过的组合键**——菜单上挂着按不动的键
   * 比不写更糟（用户会反复试）。键位真源：App.tsx 的全局 keydown、
   * EditorView 的 CM keymap、以及树行的 onKeyDown。
   */
  shortcut?: string;
  /** 子菜单（如「从模板新建」）；子层级同样允许分隔线 */
  children?: CtxEntry[];
  onSelect?: () => void;
}

export interface CtxSep {
  kind: "sep";
}

export type CtxEntry = CtxItem | CtxSep;

export interface CtxAnchor {
  x: number;
  y: number;
}

interface Props {
  anchor: CtxAnchor;
  entries: CtxEntry[];
  onClose: () => void;
}

function Pop({ anchor, entries, onClose, depth }: Props & { depth: number }) {
  const { x, y } = anchor;
  const ref = useRef<HTMLUListElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<{ entry: CtxItem; x: number; y: number } | null>(null);

  // 挂载后按实测尺寸做边界收拢：右/下越界贴边，避免菜单出屏
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(6, Math.min(x, window.innerWidth - width - 6));
    const top = Math.max(6, Math.min(y, window.innerHeight - height - 6));
    setPos({ left, top });
  }, [x, y]);

  return (
    <>
      <ul
        ref={ref}
        className="menu-pop ctx-pop"
        role="menu"
        style={{ left: pos.left, top: pos.top, zIndex: 90 + depth }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entries.map((en, i) =>
          "kind" in en && en.kind === "sep" ? (
            <li key={`sep-${i}`} role="separator" className="menu-sep" />
          ) : (
            <li key={`${(en as CtxItem).label}-${i}`} role="presentation">
              <button
                type="button"
                role="menuitem"
                className={`menu-item${(en as CtxItem).icon ? " has-icon" : ""}${
                  (en as CtxItem).danger ? " danger" : ""
                }`}
                disabled={(en as CtxItem).disabled}
                onClick={(e) => {
                  const item = en as CtxItem;
                  if (item.children?.length) {
                    const r = e.currentTarget.getBoundingClientRect();
                    setSub({ entry: item, x: r.right - 4, y: r.top - 4 });
                    return;
                  }
                  item.onSelect?.();
                  onClose();
                }}
                onMouseEnter={() => setSub(null)}
              >
                {(en as CtxItem).icon && (
                  <span className="menu-item-icon" aria-hidden="true">
                    {(en as CtxItem).icon}
                  </span>
                )}
                {(en as CtxItem).label}
                {(en as CtxItem).shortcut ? (
                  <span className="menu-item-kbd" aria-hidden="true">
                    {(en as CtxItem).shortcut}
                  </span>
                ) : null}
                {(en as CtxItem).children?.length ? (
                  <span className="menu-item-arrow" aria-hidden="true">
                    ›
                  </span>
                ) : null}
              </button>
            </li>
          ),
        )}
      </ul>
      {sub && (
        <Pop
          depth={depth + 1}
          anchor={{ x: sub.x, y: sub.y }}
          entries={sub.entry.children ?? []}
          onClose={onClose}
        />
      )}
    </>
  );
}

export default function ContextMenu({ anchor, entries, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      // 菜单自身（含子菜单）内的点击由菜单项自行处理
      const t = e.target as HTMLElement | null;
      if (t?.closest(".ctx-pop")) return;
      onClose();
    };
    const dismiss = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("wheel", dismiss, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("wheel", dismiss);
    };
  }, [onClose]);

  return (
    <div className="ctx-layer" role="presentation">
      <Pop anchor={anchor} entries={entries} onClose={onClose} depth={0} />
    </div>
  );
}
