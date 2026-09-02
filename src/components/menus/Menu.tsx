// 菜单下拉轻实现（brief 规范）：触发按钮 + absolute 弹层，不用库。
// 关闭路径有三条：再点一次按钮、点击任意菜单项、焦点移出容器（onBlur）。
// children 为 render prop——条目 action 执行后自行调用 close() 收起弹层。
import { useState, type ReactNode } from "react";

interface MenuProps {
  label: ReactNode;          // 文字（TopBar 菜单）或 图标+箭头（工具栏下拉）
  title?: string;            // 悬浮提示，透传触发按钮
  disabled?: boolean;        // 透传触发按钮（工具栏编辑类下拉随文档状态禁用）
  children: (close: () => void) => ReactNode;
}

export default function Menu({ label, title, disabled, children }: MenuProps) {
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
        title={title}
        disabled={disabled}
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
  icon?: ReactNode;    // 可选前置图标（工具栏下拉用；✓ 前缀项不传 icon）
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** 单个菜单项；active 时显示 ✓ 前缀（视图/模式类开关用）。
 * T17 review a11y 修补：带 aria-checked 的条目须用 role="menuitemcheckbox"，
 * 纯动作项（active 未传）保持 role="menuitem" 且不输出 aria-checked。
 * 带 icon 的条目用 .has-icon 左对齐布局（图标顶格 + 文字紧随）。 */
export function MenuItem({ label, icon, active, disabled, onSelect }: ItemProps) {
  return (
    <li role="presentation">
      <button
        type="button"
        role={active === undefined ? "menuitem" : "menuitemcheckbox"}
        className={`menu-item${icon ? " has-icon" : ""}`}
        aria-checked={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onSelect}
      >
        {icon && (
          <span className="menu-item-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        {label}
      </button>
    </li>
  );
}

/** 菜单内分组分隔线。 */
export function MenuSep() {
  return <li role="separator" className="menu-sep" />;
}
