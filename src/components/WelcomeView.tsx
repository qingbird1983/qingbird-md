// 欢迎页（2026-09-12）：新开空白 / 没有任何文档时占据主区，给出三种起手式
// （新建文档、打开文件、打开文件夹）与真实可用的快捷键提示。
// 视觉沿用「纸上翻译」：宣纸底、朱砂「青」印、青花只给翻译语义——这里用
// 墨色层级 + 发丝线做层级，不引入新色。
import { FilePlus2, FolderOpen, FileText } from "lucide-react";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";

export default function WelcomeView() {
  const newTab = useDocStore((s) => s.newTab);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  // 打开文件：与 Ctrl+O 同路径（api.pickFile → openTab），不进 commands.ts 避免循环依赖
  const openFile = async () => {
    const p = await (await import("../lib/ipc")).api.pickFile();
    if (p) await useDocStore.getState().openTab(p);
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-seal" aria-hidden>
          青
        </div>
        <h1 className="welcome-title">用 Markdown 记录想法</h1>
        <p className="welcome-sub">
          打开已有文件，或把整个文件夹作为文档工作区。
          <br />
          默认所见即所得编辑，也可以随时切换到 Markdown 源码。
        </p>
        <div className="welcome-actions">
          <button type="button" className="welcome-btn primary" onClick={() => newTab()}>
            <FilePlus2 size={15} />
            新建文档
          </button>
          <button type="button" className="welcome-btn" onClick={() => void openFile()}>
            <FileText size={15} />
            打开文件
          </button>
          <button type="button" className="welcome-btn" onClick={() => void openWorkspace()}>
            <FolderOpen size={15} />
            打开文件夹
          </button>
        </div>
        <div className="welcome-tips">
          <span>
            <kbd>Ctrl</kbd>
            <kbd>O</kbd> 打开文件
          </span>
          <span className="welcome-dot">·</span>
          <span>
            <kbd>Ctrl</kbd>
            <kbd>Shift</kbd>
            <kbd>O</kbd> 打开文件夹
          </span>
        </div>
      </div>
    </div>
  );
}
