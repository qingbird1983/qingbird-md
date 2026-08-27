// 菜单下拉轻实现（brief 规范）：触发按钮 + absolute 弹层，不用库。
// 关闭路径有三条：再点一次按钮、点击任意菜单项、焦点移出容器（onBlur）。
// children 为 render prop——条目 action 执行后自行调用 close() 收起弹层。
import { useState, type ReactNode } from "react";

interface MenuProps {
  label: string;
  children: (close: () => void) => ReactNode;
}

export default function Menu({ label, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    // relatedTarget 在容器内 = 焦点只是移到菜单项上，不收起；移到容器外才关
    <div
      className="menu"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
      }}
    >
      <button
        type="button"
        className="menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <ul className="menu-pop" role="menu">
          {children(close)}
        </ul>
      )}
    </div>
  );
}

interface ItemProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** 单个菜单项；active 时显示 ✓ 前缀（视图/模式类开关用）。 */
export function MenuItem({ label, active, disabled, onSelect }: ItemProps) {
  return (
    <li role="presentation">
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        aria-checked={active}
        disabled={disabled}
        onClick={onSelect}
      >
        {label}
      </button>
    </li>
  );
}

/** 菜单内分组分隔线。 */
export function MenuSep() {
  return <li role="separator" className="menu-sep" />;
}
