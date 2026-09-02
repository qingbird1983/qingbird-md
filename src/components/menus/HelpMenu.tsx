// 帮助菜单：关于弹窗以 toast 呈现（brief 明示 toast 即可，T22 正式 Modal 不在此前置）。
import { useUiStore } from "../../stores/useUiStore";
import Menu, { MenuItem } from "./Menu";

export default function HelpMenu() {
  const addToast = useUiStore((s) => s.addToast);

  return (
    <Menu label="帮助">
      {(close) => (
        <MenuItem
          label="关于 青鸟 Markdown"
          onSelect={() => {
            close();
            addToast("info", "青鸟 Markdown —— Rust 内核 · Tauri v2 前端");
          }}
        />
      )}
    </Menu>
  );
}
