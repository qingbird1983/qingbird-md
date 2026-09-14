// 欢迎页（2026-09-12）：新开空白 / 没有任何文档时占据主区，给出四种起手式
// （新建文档、打开文件、打开文件夹、打开示例文档）与真实可用的快捷键提示。
// 四个按钮必须**并排一行**（2026-09-14 用户要求）：按标签字数递增排列 4/4/5/6 字，
// 且示例文档排在最后——它是「尝鲜」入口，不该挡在常规动作前面。
// 并排的前提是 .welcome-inner 的 max-width 放得下这一行（见 global.css 该处注释）。
// 视觉沿用「纸上翻译」：宣纸底、朱砂「青」印、青花只给翻译语义——这里用
// 墨色层级 + 发丝线做层级，不引入新色。
import { FilePlus2, FolderOpen, FileText, BookOpen } from "lucide-react";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { DEMO_DOC_CONTENT, DEMO_DOC_NAME } from "../lib/demoDoc";

export default function WelcomeView() {
  const newTab = useDocStore((s) => s.newTab);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  // 打开文件：与 Ctrl+O 同路径（api.pickFile → openTab），不进 commands.ts 避免循环依赖
  const openFile = async () => {
    const p = await (await import("../lib/ipc")).api.pickFile();
    if (p) await useDocStore.getState().openTab(p);
  };

  // 打开示例文档：内容随包内联（lib/demoDoc.ts），以「未命名标签」形态打开——
  // 不落磁盘、不标脏，用户想留就 Ctrl+S 另存。
  const openDemo = () => useDocStore.getState().openExampleTab(DEMO_DOC_NAME, DEMO_DOC_CONTENT);

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
          <button type="button" className="welcome-btn" onClick={openDemo}>
            <BookOpen size={15} />
            打开示例文档
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
