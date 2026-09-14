// 由 src/lib/paletteSeeds.ts 生成 src/styles/palettes.css。
//
// 跑法：`npm run gen:palettes`（= node scripts/gen-palettes.mjs）。
//
// 为什么这个 .mjs 能直接 import .ts：Node 22.18+ 默认开启类型剥离
// （--experimental-strip-types），paletteSeeds.ts 只用可擦除语法
// （type / interface / as const，无 enum、无 namespace、无参数属性），
// 所以能当普通 ESM 加载——不必引入 tsx / vite-node 之类的额外依赖。
// 新增依赖前请先确认这条路径仍然可用（本仓库 node 版本见 package.json engines）。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paletteCss } from "../src/lib/paletteSeeds.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "styles", "palettes.css");
const next = paletteCss();

let prev = null;
try {
  prev = readFileSync(target, "utf-8");
} catch {
  /* 首次生成：文件还不存在 */
}

if (prev === next) {
  console.log("palettes.css 已是最新，无需重写。");
} else {
  writeFileSync(target, next, "utf-8");
  console.log(`palettes.css 已${prev === null ? "生成" : "更新"}（${next.length} 字符）。`);
}
