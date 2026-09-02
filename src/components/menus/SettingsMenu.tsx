// 设置菜单：仅一个入口项，打开 uiStore.settingsOpen（T26 的设置模态消费该开关）。
import { useUiStore } from "../../stores/useUiStore";
import Menu, { MenuItem } from "./Menu";

export default function SettingsMenu() {
  const openSettings = useUiStore((s) => s.openSettings);

  return (
    <Menu label="设置">
      {(close) => (
        <MenuItem
          label="打开设置…"
          onSelect={() => {
            close();
            openSettings();
          }}
        />
      )}
    </Menu>
  );
}
