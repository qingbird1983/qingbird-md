// 只为测试声明用到的 node 内置符号（2026-09-14）。
//
// 为什么不是直接装 @types/node：本 tsconfig 没有 `types` 白名单，装了之后
// node 全局（process / Buffer / setTimeout 返回 Timeout…）会漏进全部 src/**，
// 让 app 代码误用 node API 也能过类型检查。前端代码不该有这些全局。
//
// 为什么不能改用 `import css from "./x.css?raw"`：vite 在 SSR（vitest 的运行
// 模式）下由 css 插件接管 CSS 说明符，asset 插件的 raw 结果被顶掉，导入结果是
// 空字符串——所以「读生成物做一致性断言」只能走 node:fs，绕不开。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf-8"): string;
  // 滚动条守卫要把 src/styles 下的 CSS 全量扫一遍，得先列目录（2026-09-19）：
  // 硬编码文件名 = 又造一份要人工维护的名单，正是该守卫要消灭的东西。
  export function readdirSync(path: string): string[];
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
