// 应用主菜单（汉堡菜单弹出面板）——一级分类 + 悬停展开二级菜单。
//
// 由 TitleBar 中的 ☰ 按钮触发（通过 #app-hamburger 监听点击）。
// 交互：
//   - 面板左缘与 ☰ 按钮对齐、紧贴其下方（点击时实时读按钮 getBoundingClientRect）。
//   - 刚点开只显示一级菜单；悬停某分类约 180ms 或点击它，右侧才展开二级。
//   - 鼠标移出整个面板约 300ms 后自动收回（点击外部/选完条目也收起）。
//   - 设置/关于/退出为一级直接动作，无二级。
import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore } from "../stores/useUiStore";
import { useTranslationStore } from "../stores/useTranslationStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";

type CatKey = "file" | "view" | "translate";

const CATS: { key: CatKey; label: string }[] = [
  { key: "file", label: "文件" },
  { key: "view", label: "视图" },
  { key: "translate", label: "翻译" },
];

const HOVER_OPEN_MS = 180; // 悬停多久才切换二级（防止扫过误弹）
const LEAVE_CLOSE_MS = 300; // 鼠标离开面板多久后整体收回

export default function AppMenu() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<CatKey | null>(null);
  const [pos, setPos] = useState({ left: 8, top: 42 });
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 关闭/卸载时清掉所有挂起计时器（悬停切换 + 移出收回）
  useEffect(() => {
    if (open) return;
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, [open]);
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  // 监听汉堡按钮点击：打开时实时对齐按钮位置（面板左缘贴 ☰ 左缘、顶在其下方 4px）
  useEffect(() => {
    const btn = document.getElementById("app-hamburger");
    if (!btn) return;
    const onClick = () => {
      const r = btn.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 4 });
      setOpen((o) => !o);
    };
    btn.addEventListener("click", onClick);
    return () => btn.removeEventListener("click", onClick);
  }, []);

  // 悬停分类：短暂停留后切换二级；快速扫过（leave 先于计时器到点）不切换
  const hoverCat = (k: CatKey) => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (active === k) return;
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      setActive(k);
    }, HOVER_OPEN_MS);
  };
  // 移出分类：取消挂起的切换（已激活的分类保持展开）
  const leaveCat = () => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  const clickCat = (k: CatKey) => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setActive(k);
  };

  // 鼠标离开整个面板：宽限一段（穿过条目间隙/轻微抖动不算）后整体收回
  const menuMouseLeave = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, LEAVE_CLOSE_MS);
  };
  const menuMouseEnter = () => {
    if (closeTimer.current !== null) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  // 悬停一级直接动作（设置/关于/退出）：取消挂起切换并收回二级——它们没有二级
  const hoverDirect = () => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setActive(null);
  };

  const hasDoc = useDocStore((s) => !!s.doc);
  const openTab = useDocStore((s) => s.openTab);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const mode = useDocStore((s) => s.mode);
  const switchMode = useDocStore((s) => s.switchMode);
  const hasRoot = useWorkspaceStore((s) => !!s.root);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const wideContent = useUiStore((s) => s.wideContent);
  const toggleWideContent = useUiStore((s) => s.toggleWideContent);
  const openSettings = useUiStore((s) => s.openSettings);
  const addToast = useUiStore((s) => s.addToast);
  const running = useTranslationStore((s) => s.status === "running");
  const retranslate = useTranslationStore((s) => s.translateDocument);

  const pickOpen = async () => {
    const p = await api.pickFile();
    if (p) await openTab(p);
  };

  if (!open) return null;

  const close = () => setOpen(false);

  const subMenus: Record<CatKey, ReactNode> = {
    file: (
      <>
        <div className="app-menu-label">文件</div>
        <button disabled={!hasRoot} onClick={() => { close(); const name = window.prompt("新文件名（创建于工作区根目录）："); if (name?.trim()) void createFile(name.trim()); }}>
          新建文件…
        </button>
        <button onClick={() => { close(); void pickOpen(); }}>打开…</button>
        <button disabled={!hasDoc} onClick={() => { close(); void saveDoc(false); }}>保存</button>
        <button disabled={!hasDoc} onClick={() => { close(); void saveDoc(true); }}>另存为…</button>
        <button onClick={() => { close(); void openWorkspace(); }}>打开工作区…</button>
      </>
    ),
    view: (
      <>
        <div className="app-menu-label">视图</div>
        {(["source", "preview", "split"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => { close(); switchView(v); }}>
            {v === "source" ? "源码" : v === "preview" ? "预览" : "分栏"}
          </button>
        ))}
        <button className={showNav ? "active" : ""} onClick={() => { close(); toggleNav(); }}>
          {showNav ? "隐藏侧栏" : "显示侧栏"}
        </button>
        <button className={showOutline ? "active" : ""} onClick={() => { close(); toggleOutline(); }}>
          {showOutline ? "隐藏大纲" : "显示大纲"}
        </button>
        <button className={wideContent ? "active" : ""} onClick={() => { close(); toggleWideContent(); }}>
          正文宽版
        </button>
        <button onClick={() => { close(); useSettingsStore.getState().setTheme(isDarkTheme() ? "light" : "dark"); }}>
          切换明暗主题
        </button>
      </>
    ),
    translate: (
      <>
        <div className="app-menu-label">翻译</div>
        {([
          ["original", "原文"],
          ["translation", "译文"],
          ["bilingual", "中英对照"],
        ] as const).map(([m, label]) => (
          <button key={m} disabled={!hasDoc} className={mode === m ? "active" : ""} onClick={() => { close(); switchMode(m); }}>
            {label}
          </button>
        ))}
        <button disabled={!hasDoc || mode === "original" || running} onClick={() => { close(); void retranslate(); }}>
          {running ? "翻译中…" : "重新翻译"}
        </button>
      </>
    ),
  };

  return (
    <div className="app-menu" ref={ref} style={{ left: pos.left, top: pos.top }}
      onMouseLeave={menuMouseLeave} onMouseEnter={menuMouseEnter}>
      {/* ── 一级：三个带二级的分类 + 三个直接动作 ── */}
      <div className="app-menu-root">
        {CATS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={"app-menu-cat" + (active === c.key ? " active" : "")}
            onMouseEnter={() => hoverCat(c.key)}
            onMouseLeave={leaveCat}
            onClick={() => clickCat(c.key)}
          >
            <span>{c.label}</span>
            <ChevronRight size={14} className="app-menu-chev" />
          </button>
        ))}
        <div className="app-menu-root-sep" aria-hidden />
        <button type="button" className="app-menu-cat" onMouseEnter={hoverDirect} onClick={() => { close(); openSettings(); }}>
          <span>设置</span>
        </button>
        <button type="button" className="app-menu-cat" onMouseEnter={hoverDirect} onClick={() => { close(); addToast("info", "青鸟 Markdown —— Rust 内核 · Tauri v2 前端"); }}>
          <span>关于</span>
        </button>
        <button type="button" className="app-menu-cat" onMouseEnter={hoverDirect} onClick={() => { close(); window.close(); }}>
          <span>退出</span>
        </button>
      </div>
      {/* ── 二级菜单：仅在悬停/点击分类后展开 ── */}
      {active !== null && (
        <div className="app-menu-sub">
          {subMenus[active]}
        </div>
      )}
    </div>
  );
}
