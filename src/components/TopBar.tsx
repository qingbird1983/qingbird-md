// 顶栏：品牌标识 + 五组下拉菜单横排（文件/视图/翻译/设置/帮助）。自身无状态、
// 无逻辑——每组菜单各自订阅所属 store 并派发 action。
import FileMenu from "./menus/FileMenu";
import ViewMenu from "./menus/ViewMenu";
import TranslateMenu from "./menus/TranslateMenu";
import SettingsMenu from "./menus/SettingsMenu";
import HelpMenu from "./menus/HelpMenu";

export default function TopBar() {
  return (
    <header className="topbar">
      <span className="brand">青鸟 Markdown</span>
      <span className="brand-sep" aria-hidden />
      <FileMenu />
      <ViewMenu />
      <TranslateMenu />
      <SettingsMenu />
      <HelpMenu />
    </header>
  );
}
