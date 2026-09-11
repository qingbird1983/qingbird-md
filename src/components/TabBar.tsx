// 标签条（Task 4）：横排显示所有打开的标签，活跃标签高亮。
//
// 交互：
//   - 单击 = 切激活（switchTab）。
//   - 双击 = 关（closeTab；脏标签弹 DirtyConfirmDialog）。
//   - 关闭 X = 关（同一 closeTab 流程；stopPropagation 防止冒泡到单击切激活）。
//   - 右侧 + 按钮 = 新建空标签（newTab）。
//
// 重入护栏（DirtyConfirmDialog 没有单例锁）：维护 closingIds Set；任一 closeTab
// 在飞行中时禁用所有标签的关闭入口（X 按钮 + onDoubleClick），避免后续
// showDirtyConfirm 覆盖正在显示的弹窗并使首个 promise 永不 settle。
//
// 样式全部走 .tabbar/.tab/.tab.active/.tab-close/.tab-add/.tab-dirty（见 global.css）。
import { useState, type CSSProperties } from "react";
import { Plus, X } from "lucide-react";
import { useDocStore } from "../stores/useDocStore";

export default function TabBar({ style }: { style?: CSSProperties }) {
  const tabs = useDocStore((s) => s.tabs);
  const activeId = useDocStore((s) => s.activeId);
  // 正在 closeTab 的标签 id 集合；期间屏蔽对应关闭入口。
  const [closingIds, setClosingIds] = useState<Set<string>>(() => new Set());

  const requestClose = async (id: string) => {
    setClosingIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await useDocStore.getState().closeTab(id);
    } finally {
      setClosingIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div
      className="tabbar"
      role="tablist"
      aria-label="打开的文档"
      style={style}
    >
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const isDirty = t.content !== t.savedContent;
        // DirtyConfirmDialog 是单例且无内部锁：并发关两个脏标签会让首个 promise
        // 永不 settle、finally 不执行、closingIds 条目卡死。任一 close 飞行中即屏蔽所有关闭入口。
        const isClosing = closingIds.size > 0;
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            className={"tab" + (isActive ? " active" : "")}
            title={t.path ?? t.name}
            onClick={() => useDocStore.getState().switchTab(t.id)}
            onDoubleClick={() => {
              if (isClosing) return;
              void requestClose(t.id);
            }}
          >
            <span className="tab-title">{t.name}</span>
            {isDirty && <span className="tab-dirty" aria-label="未保存" />}
            <button
              type="button"
              className="tab-close"
              aria-label={`关闭 ${t.name}`}
              disabled={isClosing}
              onClick={(e) => {
                e.stopPropagation();
                if (isClosing) return;
                void requestClose(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-add"
        aria-label="新建标签"
        title="新建标签"
        onClick={() => useDocStore.getState().newTab()}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
