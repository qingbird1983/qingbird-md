// T28 命令面板静态清单：run 全部派发与菜单相同的 store action / api——
// 菜单是交互唯一真源，面板只是第二入口，不复制业务逻辑。
// enabled 在面板打开（条件挂载）时求值：前置不满足的命令直接过滤
// （保存/另存对齐 FileMenu 禁用语义，阅读模式对齐 TranslateMenu 的无文档禁用）。
//
// 例外：配色一组的主入口是设置面板的「外观」页（带色卡预览），命令面板只是
// 给「不想开面板、只想快速换一套纸色」的人的第二条路——按 paletteSeeds 的
// 真源清单生成，不手抄色名。
import { api } from "../lib/ipc";
import { PALETTES, PALETTE_IDS } from "../lib/paletteSeeds";
import { useDocStore } from "../stores/useDocStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { isDarkTheme, useSettingsStore } from "../stores/useSettingsStore";
import { errText, useUiStore } from "../stores/useUiStore";

export interface Command {
  label: string;
  /** 追加匹配词（英文别名），与 label 一起做大小写不敏感 substring 过滤。 */
  keywords?: string[];
  enabled?: () => boolean;
  run(): void;
}

const hasDoc = () => !!useDocStore.getState().doc;

// FileMenu.pickOpen 同款两步：选路径 → openTab（store 内自带失败 toast）。
// T29 起导出：App.tsx 的 Ctrl+O 快捷键与面板命令共用同一实现（不复制逻辑）。
export async function openFile() {
  const p = await api.pickFile();
  if (p) await useDocStore.getState().openTab(p);
}

export const COMMANDS: Command[] = [
  // ---- 文件（FileMenu 同源 action）----
  {
    label: "保存文档",
    keywords: ["save"],
    enabled: hasDoc,
    run: () => void useDocStore.getState().saveDoc(false),
  },
  {
    label: "另存为…",
    keywords: ["save as"],
    enabled: hasDoc,
    run: () => void useDocStore.getState().saveDoc(true),
  },
  {
    label: "打开文件…",
    keywords: ["open"],
    run: () => void openFile(),
  },
  {
    label: "打开工作区…",
    keywords: ["workspace"],
    run: () => void useWorkspaceStore.getState().openWorkspace(),
  },
  // ---- 视图（ViewMenu：三态切换永不禁用）----
  {
    label: "切换到源码视图",
    keywords: ["source"],
    run: () => useDocStore.getState().switchView("source"),
  },
  {
    label: "切换到预览视图",
    keywords: ["preview"],
    run: () => useDocStore.getState().switchView("preview"),
  },
  {
    label: "切换到分栏视图",
    keywords: ["split"],
    run: () => useDocStore.getState().switchView("split"),
  },
  // ---- 阅读模式（TranslateMenu：无文档禁用 → 此处过滤）----
  {
    label: "阅读模式：原文",
    keywords: ["original"],
    enabled: hasDoc,
    run: () => useDocStore.getState().switchMode("original"),
  },
  {
    label: "阅读模式：译文",
    keywords: ["translation"],
    enabled: hasDoc,
    run: () => useDocStore.getState().switchMode("translation"),
  },
  {
    label: "阅读模式：中英对照",
    keywords: ["bilingual"],
    enabled: hasDoc,
    run: () => useDocStore.getState().switchMode("bilingual"),
  },
  // ---- 设置 / 主题 / 缓存（SettingsMenu、SettingsModal 同源）----
  {
    label: "打开设置…",
    keywords: ["settings"],
    run: () => useUiStore.getState().openSettings(),
  },
  {
    label: "切换明暗主题",
    keywords: ["theme dark light"],
    // 判暗口径统一走 useSettingsStore.isDarkTheme（auto 跟随系统）
    run: () => {
      useSettingsStore.getState().setTheme(isDarkTheme() ? "light" : "dark");
    },
  },
  // ---- 配色（按 paletteSeeds 真源清单生成；主入口在设置面板「外观」页）----
  ...PALETTE_IDS.map((id) => ({
    label: `配色：${PALETTES[id].label}`,
    keywords: ["palette", "color", id, PALETTES[id].short],
    // setPalette 自带「与当前相同则不动」守卫，重复选中不会多写一次盘
    run: () => useSettingsStore.getState().setPalette(id),
  })),
  {
    label: "清除翻译缓存",
    keywords: ["cache"],
    run: () => {
      const ui = useUiStore.getState();
      api
        .clearCache()
        .then(() => ui.addToast("success", "翻译缓存已清除"))
        .catch((e) => ui.addToast("error", `清除缓存失败：${errText(e)}`));
    },
  },
];
