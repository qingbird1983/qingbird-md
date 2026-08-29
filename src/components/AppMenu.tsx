// 应用主菜单（汉堡菜单弹出面板）。
//
// 由 TitleBar 中的 ☰ 按钮触发（通过 #app-hamburger 挂载 Portal/绝对定位）。
// 整合原 FileMenu / ViewMenu / TranslateMenu / SettingsMenu / HelpMenu 全部条目，
// 分组展示：文件操作、视图、翻译、设置、帮助。
import { useState, useEffect, useRef } from "react";
import { api } from "../lib/ipc";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore } from "../stores/useUiStore";
import { useTranslationStore } from "../stores/useTranslationStore";

export default function AppMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  // 监听汉堡按钮点击
  useEffect(() => {
    const btn = document.getElementById("app-hamburger");
    if (!btn) return;
    const onClick = () => setOpen((o) => !o);
    btn.addEventListener("click", onClick);
    return () => btn.removeEventListener("click", onClick);
  }, []);

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

  return (
    <div className="app-menu" ref={ref}>
      {/* ── 文件 ── */}
      <div className="app-menu-group">
        <div className="app-menu-label">文件</div>
        <button disabled={!hasRoot} onClick={() => { setOpen(false); const name = window.prompt("新文件名（创建于工作区根目录）："); if (name?.trim()) void createFile(name.trim()); }}>
          新建文件…
        </button>
        <button onClick={() => { setOpen(false); void pickOpen(); }}>打开…</button>
        <button disabled={!hasDoc} onClick={() => { setOpen(false); void saveDoc(false); }}>保存</button>
        <button disabled={!hasDoc} onClick={() => { setOpen(false); void saveDoc(true); }}>另存为…</button>
        <button onClick={() => { setOpen(false); void openWorkspace(); }}>打开工作区…</button>
      </div>

      {/* ── 视图 ── */}
      <div className="app-menu-group">
        <div className="app-menu-label">视图</div>
        {(["source", "preview", "split"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => { setOpen(false); switchView(v); }}>
            {v === "source" ? "源码" : v === "preview" ? "预览" : "分栏"}
          </button>
        ))}
        <button className={showNav ? "active" : ""} onClick={() => { setOpen(false); toggleNav(); }}>
          {showNav ? "隐藏侧栏" : "显示侧栏"}
        </button>
        <button className={showOutline ? "active" : ""} onClick={() => { setOpen(false); toggleOutline(); }}>
          {showOutline ? "隐藏大纲" : "显示大纲"}
        </button>
        <button className={wideContent ? "active" : ""} onClick={() => { setOpen(false); toggleWideContent(); }}>
          正文宽版
        </button>
      </div>

      {/* ── 翻译 ── */}
      <div className="app-menu-group">
        <div className="app-menu-label">翻译</div>
        {([
          ["original", "原文"],
          ["translation", "译文"],
          ["bilingual", "中英对照"],
        ] as const).map(([m, label]) => (
          <button key={m} disabled={!hasDoc} className={mode === m ? "active" : ""} onClick={() => { setOpen(false); switchMode(m); }}>
            {label}
          </button>
        ))}
        <button disabled={!hasDoc || mode === "original" || running} onClick={() => { setOpen(false); void retranslate(); }}>
          {running ? "翻译中…" : "重新翻译"}
        </button>
      </div>

      {/* ── 设置 / 帮助 ── */}
      <div className="app-menu-group">
        <div className="app-menu-label">更多</div>
        <button onClick={() => { setOpen(false); openSettings(); }}>打开设置…</button>
        <button onClick={() => { setOpen(false); addToast("info", "青鸟 Markdown —— Rust 内核 · Tauri v2 前端"); }}>
          关于 青鸟 Markdown
        </button>
        <button onClick={() => { setOpen(false); window.close(); }}>退出</button>
      </div>
    </div>
  );
}
