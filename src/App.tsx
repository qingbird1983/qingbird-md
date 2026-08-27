import { useEffect } from "react";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useDocStore } from "./stores/useDocStore";
import { useTranslationStore } from "./stores/useTranslationStore";

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

  return <h1>青鸟 Markdown · Tauri 2</h1>;
}

export default App;
