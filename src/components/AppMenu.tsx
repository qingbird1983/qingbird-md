// 应用主菜单（汉堡菜单弹出面板）——一级分类 + 悬停展开二级菜单。
//
// 由 TitleBar 中的 ☰ 按钮触发（通过 #app-hamburger 监听点击）。
// 交互：
//   - 面板左缘与 ☰ 按钮对齐、紧贴其下方（点击时实时读按钮 getBoundingClientRect）。
//   - 刚点开只显示一级菜单；悬停某分类约 180ms 或点击它，右侧才展开二级。
//   - 鼠标移出整个面板约 300ms 后自动收回（点击外部/选完条目也收起）。
//   - 设置/关于/退出为一级直接动作，无二级。
import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../lib/ipc";
import { effectiveHotkeys } from "../lib/hotkeyRegistry";
import { exportActiveDocHtml } from "../lib/exportHtml";
import { exportActiveTranslation, exportGate } from "../lib/exportTranslation";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { useUiStore, CONTENT_WIDTHS, CONTENT_WIDTH_LABEL } from "../stores/useUiStore";
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
  // 二级是独立卡片：fixed 定位在激活分类右侧（与一级面板分离，互不重叠）
  const [subPos, setSubPos] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const catRefs = useRef<Partial<Record<CatKey, HTMLButtonElement | null>>>({});
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  // 点击外部关闭（一级与二级是兄弟节点，两处都要认）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !subRef.current?.contains(t)) {
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

  // 监听汉堡按钮点击：打开时实时对齐按钮位置（面板左缘贴 ☰ 左缘、顶在其下方 4px）。
  // 用 document 事件委托而非直挂按钮节点：HMR/重渲染会重挂标题栏按钮 DOM，
  // 直挂会丢监听（点 ☰ 无反应）；委托按 closest 认按钮，重挂也免疫。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.("#app-hamburger");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 4 });
      setOpen((o) => !o);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // 激活分类：二级卡片对齐该分类按钮（贴其右缘 0px、顶与其顶对齐）
  const activate = (k: CatKey) => {
    const btn = catRefs.current[k];
    if (btn) {
      const r = btn.getBoundingClientRect();
      setSubPos({ left: r.right, top: r.top });
    }
    setActive(k);
  };

  // 悬停分类：短暂停留后切换二级；快速扫过（leave 先于计时器到点）不切换
  const hoverCat = (k: CatKey) => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    if (active === k) return;
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      activate(k);
    }, HOVER_OPEN_MS);
  };
  // 移出分类：取消挂起的切换（已激活的分类保持展开）
  const leaveCat = () => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  };
  const clickCat = (k: CatKey) => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    activate(k);
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

  // 二级卡片底缘防溢出：渲染后实测高度，超出视口则上收（内容随分类变化需重测）
  useEffect(() => {
    if (active === null) return;
    const el = subRef.current;
    if (!el) return;
    const maxTop = window.innerHeight - el.offsetHeight - 8;
    if (subPos.top > maxTop) {
      setSubPos((p) => ({ ...p, top: Math.max(8, maxTop) }));
    }
  }, [active, subPos.top]);

  const hasDoc = useDocStore((s) => !!s.doc);
  const openTab = useDocStore((s) => s.openTab);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const mode = useDocStore((s) => s.mode);
  const switchMode = useDocStore((s) => s.switchMode);
  const hasRoot = useWorkspaceStore((s) => s.folders.length > 0);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const contentWidth = useUiStore((s) => s.contentWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);
  const customWidth = useUiStore((s) => s.customWidth);
  const openSettings = useUiStore((s) => s.openSettings);
  const addToast = useUiStore((s) => s.addToast);
  const running = useTranslationStore((s) => s.status === "running");
  const retranslate = useTranslationStore((s) => s.translateDocument);
  const translationCount = useDocStore((s) => s.translations.size);
  const lastRunMode = useTranslationStore((s) => s.lastRunMode);
  // 导出译文启用态：响应式取值喂给同一个判据函数（条件本身只有 exportGate 一份）
  const exportT = exportGate({ hasDoc, mode, running, translationCount, lastRunMode });
  // 菜单项右侧的键位提示：从**注册表**取生效值（用户改过键就显示改后的），
  // 不手抄字面量——手抄的字面量在用户改键后就开始说谎。
  // useMemo 依赖 hotkeys 对象本身（只在改键时换引用），避免每次渲染都重建整表。
  const hkOverrides = useSettingsStore((s) => s.settings?.hotkeys);
  const hk = useMemo(() => effectiveHotkeys(hkOverrides), [hkOverrides]);

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
          新建文件…<HkTip combo={hk.new_file} />
        </button>
        <button onClick={() => { close(); void pickOpen(); }}>打开…<HkTip combo={hk.open_file} /></button>
        <div className="app-menu-sub-sep" aria-hidden />
        <button disabled={!hasDoc} onClick={() => { close(); void saveDoc(false); }}>保存<HkTip combo={hk.save} /></button>
        {/* 「另存为…」「导出 HTML…」没有绑定快捷键，不给键位位——空着比编一个诚实 */}
        <button disabled={!hasDoc} onClick={() => { close(); void saveDoc(true); }}>另存为…</button>
        <button disabled={!hasDoc} onClick={() => { close(); void exportActiveDocHtml(); }}>导出 HTML…</button>
        <button
          disabled={!exportT.ok}
          title={exportT.reason || undefined}
          onClick={() => { close(); void exportActiveTranslation(); }}
        >
          译文另存为…<HkTip combo={hk.export_translation} />
        </button>
        <div className="app-menu-sub-sep" aria-hidden />
        <button onClick={() => { close(); void openWorkspace(); }}>打开工作区…<HkTip combo={hk.open_folder} /></button>
      </>
    ),
    view: (
      <>
        <div className="app-menu-label">视图</div>
        {(["source", "preview", "split"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => { close(); switchView(v); }}>
            {v === "source" ? "源码" : v === "preview" ? "预览" : "分栏"}
            {/* Ctrl+E 是「源码 ↔ 预览」的**切换**语义，落不到"切到源码"或"切到预览"
                任何单独一项上，所以这两项不标键位，免得写成"按 Ctrl+E 切到源码"。
                只有「分栏」有确定对应。 */}
            {v === "split" && <HkTip combo={hk.split_view} />}
          </button>
        ))}
        <div className="app-menu-sub-sep" aria-hidden />
        <button className={showNav ? "active" : ""} onClick={() => { close(); toggleNav(); }}>
          {showNav ? "隐藏侧栏" : "显示侧栏"}
        </button>
        <button className={showOutline ? "active" : ""} onClick={() => { close(); toggleOutline(); }}>
          {showOutline ? "隐藏大纲" : "显示大纲"}
        </button>
        <div className="app-menu-sub-sep" aria-hidden />
        {CONTENT_WIDTHS.map((w) => (
          <button
            key={w}
            className={customWidth === null && contentWidth === w ? "active" : ""}
            onClick={() => { close(); setContentWidth(w); }}
          >
            正文宽度：{CONTENT_WIDTH_LABEL[w]}
          </button>
        ))}
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
          // 数组里的 key 恰好就是注册表的 id（original/translation/bilingual），
          // 直接拿它取生效键位，不再手抄一遍默认值
          <button key={m} disabled={!hasDoc} className={mode === m ? "active" : ""} onClick={() => { close(); switchMode(m); }}>
            {label}<HkTip combo={hk[m]} />
          </button>
        ))}
        <div className="app-menu-sub-sep" aria-hidden />
        <button disabled={!hasDoc || mode === "original" || running} onClick={() => { close(); void retranslate(); }}>
          {running ? "翻译中…" : "重新翻译"}
        </button>
      </>
    ),
  };

  return (
    <>
      <div className="app-menu" ref={rootRef} style={{ left: pos.left, top: pos.top }}
        onMouseLeave={menuMouseLeave} onMouseEnter={menuMouseEnter}>
        {/* ── 一级：三个带二级的分类 + 三个直接动作 ── */}
        <div className="app-menu-root">
          {CATS.map((c) => (
            <button
              key={c.key}
              ref={(el) => { catRefs.current[c.key] = el; }}
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
      </div>
      {/* ── 二级菜单：独立卡片，贴在激活分类的右侧 ── */}
      {active !== null && (
        <div className="app-menu-sub" ref={subRef} style={{ left: subPos.left, top: subPos.top }}
          onMouseLeave={menuMouseLeave} onMouseEnter={menuMouseEnter}>
          {subMenus[active]}
        </div>
      )}
    </>
  );
}

/**
 * 菜单项右侧的键位提示。`combo` 为空（用户把这一项禁成空串）时**不渲染**——
 * 宁可什么都不显示，也不要挂一个按不出来的键。
 *
 * 键位来自注册表的**生效值**（`effectiveHotkeys`），用户改过键就显示改后的，
 * 所以这里绝不会出现"菜单写着 Ctrl+S、实际按了没反应"的漂移。
 *
 * 用 `<kbd>` 而不是 `<span>`：这是键位语义，屏幕阅读器与浏览器默认样式都认它。
 */
function HkTip({ combo }: { combo?: string }) {
  if (!combo) return null;
  return <kbd className="app-menu-hk">{combo}</kbd>;
}
