import { useEffect } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";
import { useUiStore } from "./stores/useUiStore";
import StatusBar from "./components/StatusBar";
import TopBar from "./components/TopBar";

function App() {
  useEffect(() => {
    // 应用级一次性初始化：设置加载（含 settings-updated 监听）、
    // document-changed 监听（首开参数 + 单实例 handoff 统一入口）、
    // 翻译进度/完成事件监听。各 listen* 自带只挂一次闩，StrictMode 双跑无副作用。
    void useSettingsStore.getState().load();
    void useDocStore.getState().openDocFromArgs();
    void useTranslationStore.getState().listenProgress();
    void useTranslationStore.getState().listenDone();
  }, []);

  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const outlineWidth = useUiStore((s) => s.outlineWidth);

  return (
    <div id="app-shell">
      <TopBar />
      {/* T18 Sidebar 挂入点；ui.showNav 折叠 */}
      {showNav && <nav className="sidebar" style={{ width: sidebarWidth }} />}
      {/* T21 编辑器 / T23 TranslationBar 的宿主容器（flex 纵向） */}
      <main className="main-area">
        <div className="editor-slot" />
      </main>
      {/* T19 OutlinePanel 挂入点；ui.showOutline 折叠 */}
      {showOutline && <aside className="outline-panel" style={{ width: outlineWidth }} />}
      <StatusBar />
    </div>
  );
}

export default App;
