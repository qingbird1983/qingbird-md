// AppMenu 的三个二级菜单面板（P2-9 纯结构拆分，原 AppMenu 组件体内 subMenus
// Record 的内联 JSX 原样迁入）。
//
// 拆分纪律：菜单项文案、快捷键、回调、渲染结构、CSS 类名与拆分前逐字一致。
// 每个 Pane 各自做 store 字段级订阅（原 AppMenu 的订阅按归属下沉），共享件
// 只有 close 与 hk 两个 props；仅当对应分类激活时 AppMenu 才挂载对应 Pane
// （原实现每次渲染重建三份 JSX，可见输出不变）。
import { api } from "../../lib/ipc";
import { effectiveHotkeys } from "../../lib/hotkeyRegistry";
import { exportActiveDocHtml } from "../../lib/exportHtml";
import { exportActiveTranslation, exportGate } from "../../lib/exportTranslation";
import { useDocStore } from "../../stores/useDocStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useUiStore, CONTENT_WIDTHS, CONTENT_WIDTH_LABEL } from "../../stores/useUiStore";
import { useTranslationStore } from "../../stores/useTranslationStore";
import { isDarkTheme, useSettingsStore } from "../../stores/useSettingsStore";

/** 三个 Pane 的共享件：close 收起整个菜单；hk 是注册表生效键位表。 */
interface PaneProps {
  close: () => void;
  hk: ReturnType<typeof effectiveHotkeys>;
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

export function FileMenuPane({ close, hk }: PaneProps) {
  const hasDoc = useDocStore((s) => !!s.doc);
  const openTab = useDocStore((s) => s.openTab);
  const saveDoc = useDocStore((s) => s.saveDoc);
  const mode = useDocStore((s) => s.mode);
  const translationCount = useDocStore((s) => s.translations.size);
  const hasRoot = useWorkspaceStore((s) => s.folders.length > 0);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const running = useTranslationStore((s) => s.status === "running");
  const lastRunMode = useTranslationStore((s) => s.lastRunMode);
  // 导出译文启用态：响应式取值喂给同一个判据函数（条件本身只有 exportGate 一份）
  const exportT = exportGate({ hasDoc, mode, running, translationCount, lastRunMode });

  const pickOpen = async () => {
    const p = await api.pickFile();
    if (p) await openTab(p);
  };

  return (
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
  );
}

export function ViewMenuPane({ close, hk }: PaneProps) {
  const view = useDocStore((s) => s.view);
  const switchView = useDocStore((s) => s.switchView);
  const showNav = useUiStore((s) => s.showNav);
  const showOutline = useUiStore((s) => s.showOutline);
  const toggleNav = useUiStore((s) => s.toggleNav);
  const toggleOutline = useUiStore((s) => s.toggleOutline);
  const contentWidth = useUiStore((s) => s.contentWidth);
  const customWidth = useUiStore((s) => s.customWidth);
  const setContentWidth = useUiStore((s) => s.setContentWidth);

  return (
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
  );
}

export function TranslatePane({ close, hk }: PaneProps) {
  const hasDoc = useDocStore((s) => !!s.doc);
  const mode = useDocStore((s) => s.mode);
  const switchMode = useDocStore((s) => s.switchMode);
  const running = useTranslationStore((s) => s.status === "running");
  const retranslate = useTranslationStore((s) => s.translateDocument);

  return (
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
  );
}
