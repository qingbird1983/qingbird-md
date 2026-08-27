// 视图菜单：源码/预览/分栏三态 + 侧栏/大纲开关。均为纯 UI 态切换，永不禁用。
import { useDocStore } from "../../stores/useDocStore";
import { useUiStore } from "../../stores/useUiStore";
import Menu, { MenuItem, MenuSep } from "./Menu";

const VIEWS: Array<{ v: "source" | "preview" | "split"; label: string }> = [
  { v: "source", label: "源码" },
  { v: "preview", label: "预览" },
  { v: "split", label: "分栏" },
];

export default function ViewMenu() {
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);

  return (
    <Menu label="视图">
      {(close) => (
        <>
          {VIEWS.map(({ v, label }) => (
            <MenuItem
              key={v}
              label={label}
              active={view === v}
              onSelect={() => {
                close();
                switchView(v);
              }}
            />
          ))}
          <MenuSep />
          <MenuItem
            label={showNav ? "隐藏侧栏" : "显示侧栏"}
            active={showNav}
            onSelect={() => {
              close();
              toggleNav();
            }}
          />
          <MenuItem
            label={showOutline ? "隐藏大纲" : "显示大纲"}
            active={showOutline}
            onSelect={() => {
              close();
              toggleOutline();
            }}
          />
        </>
      )}
    </Menu>
  );
}
