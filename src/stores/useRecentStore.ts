// 最近打开文档（2026-09-12）：跨会话记住最近打开的 10 个文档。
//
// 为什么独立成 store 而不并进 useWorkspaceStore：openTab 是所有「按路径打开文件」
// 的公共漏斗（树点击 / Ctrl+O / 命令面板 / 文件关联 / 休眠交接 / 欢迎页 / 菜单），
// 记录动作必须挂在那一处才不漏。但 useDocStore ↔ useWorkspaceStore 是双向依赖
// （只能靠动态 import 绕环），所以把「最近列表」抽成一个不依赖任何其他 store 的
// 小 store，两边都能静态引入。
import { create } from "zustand";

export interface RecentDoc {
  path: string;
  name: string;
  /** 毫秒时间戳：既用于稳定排序，也给将来做「今天 / 更早」分组留口子 */
  at: number;
}

const KEY = "qb.recent-docs";
export const RECENT_MAX = 10;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 读盘；任何异常（无记录 / JSON 坏 / 隐私模式）都退化成空列表。 */
function read(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => typeof x.path === "string" && x.path.length > 0)
      .map((x) => ({
        path: x.path as string,
        name:
          typeof x.name === "string" && x.name.trim()
            ? (x.name as string)
            : baseName(x.path as string),
        at: typeof x.at === "number" ? (x.at as number) : 0,
      }))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function write(items: RecentDoc[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 配额满 / 隐私模式：记忆静默降级，不影响打开文档 */
  }
}

interface RecentState {
  items: RecentDoc[];
  /** 启动时读盘一次（App 初始化调用）。 */
  load(): void;
  /** 打开成功后登记：同路径去重后置顶，超出上限截断。 */
  push(path: string, name?: string): void;
  /** 仅从列表移除（非破坏，绝不碰磁盘）。 */
  remove(path: string): void;
  /** 清空整个列表（非破坏）。 */
  clear(): void;
}

export const useRecentStore = create<RecentState>()((set, get) => ({
  items: [],

  load: () => set({ items: read() }),

  push: (path, name) => {
    if (!path) return;
    const rest = get().items.filter((r) => r.path !== path);
    const entry: RecentDoc = {
      path,
      name: name?.trim() || baseName(path),
      at: Date.now(),
    };
    const next = [entry, ...rest].slice(0, RECENT_MAX);
    write(next);
    set({ items: next });
  },

  remove: (path) => {
    const next = get().items.filter((r) => r.path !== path);
    write(next);
    set({ items: next });
  },

  clear: () => {
    write([]);
    set({ items: [] });
  },
}));
