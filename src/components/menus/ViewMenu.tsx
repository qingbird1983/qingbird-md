// 视图菜单：源码/预览/分栏三态 + 侧栏/大纲开关 + 正文宽度四档。均为纯 UI 态切换，永不禁用。
import { useDocStore } from "../../stores/useDocStore";
import { CONTENT_WIDTH_LABEL, CONTENT_WIDTHS, useUiStore, type ContentWidth } from "../../stores/useUiStore";
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
  const contentWidth = useUiStore((s) => s.contentWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);

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
          {CONTENT_WIDTHS.map((w: ContentWidth) => (
            <MenuItem
              key={w}
              label={`正文宽度：${CONTENT_WIDTH_LABEL[w]}`}
              active={contentWidth === w}
              onSelect={() => {
                close();
                setContentWidth(w);
              }}
            />
          ))}
        </>
      )}
    </Menu>
  );
}
