// 示例文档（欢迎页「打开示例文档」按钮的内容源）。
//
// 正文取自 docs/screenshots/demo.md——README「界面」小节的 4 张截图就是拿它拍的，
// 所以改动它等于改动截图里的样子：改完记得重拍那一套，否则 README 与实物脱节。
//
// 用 `?raw` 内联进包，而不是运行时去磁盘上找仓库路径：
// ① 示例文档不该要求用户先拥有仓库；② 更不该在磁盘上留一份副本等着被误改。
// （`?raw` 只在真正的 vite 构建/serve 下有效；vitest 里 CSS 说明符会被 css 插件
// 接管成空串，本文件是 .md 无此问题。）
import content from "../../docs/screenshots/demo.md?raw";

/** 标签显示名，同时是「示例只开一份」的去重键（useDocStore.openExampleTab）。 */
export const DEMO_DOC_NAME = "示例文档";
export const DEMO_DOC_CONTENT = content;
