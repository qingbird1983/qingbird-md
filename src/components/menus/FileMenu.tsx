// 文件菜单：新建/打开/保存/另存为/打开工作区/退出。
// 新建与打开直接按 brief 接线（prompt 输入 → ws.createFile；api.pickFile → doc.openDoc），
// 其余全部派发 store action；无文档时保存/另存禁用，无工作区时新建禁用。
import { api } from "../../lib/ipc";
import { useDocStore } from "../../stores/useDocStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import Menu, { MenuItem } from "./Menu";

export default function FileMenu() {
  const hasDoc = useDocStore((s) => !!s.doc);
  const openDoc = useDocStore((s) => s.openDoc);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const hasRoot = useWorkspaceStore((s) => !!s.root);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const pickOpen = async () => {
    const p = await api.pickFile();
    if (p) await openDoc(p);
  };

  return (
    <Menu label="文件">
      {(close) => (
        <>
          <MenuItem
            label="新建文件…"
            disabled={!hasRoot}
            onSelect={() => {
              close();
              // ponytail: 计划书认可的原生 window.prompt 路线；T18 侧栏复用同一方式
              const name = window.prompt("新文件名（创建于工作区根目录）：");
              if (name?.trim()) void createFile(name.trim());
            }}
          />
          <MenuItem
            label="打开…"
            onSelect={() => {
              close();
              void pickOpen();
            }}
          />
          <MenuItem
            label="保存"
            disabled={!hasDoc}
            onSelect={() => {
              close();
              void saveDoc(false);
            }}
          />
          <MenuItem
            label="另存为…"
            disabled={!hasDoc}
            onSelect={() => {
              close();
              void saveDoc(true);
            }}
          />
          <MenuItem
            label="打开工作区…"
            onSelect={() => {
              close();
              void openWorkspace();
            }}
          />
          <MenuItem label="退出" onSelect={window.close} />
        </>
      )}
    </Menu>
  );
}
