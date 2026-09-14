import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 应用版本号（侧栏品牌头显示）直接从 package.json 注入，避免三处版本号里
// 前端再手抄一份。用 fs 读而非 import json：省掉 resolveJsonModule 与
// tsconfig.node 的类型牵连。
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

// https://vite.dev/config/
//
// 测试态（vitest 会设 VITEST=true）不挂 @vitejs/plugin-react：它在 serve 模式给每个
// JSX 模块注入 `/@react-refresh` 预置，而 happy-dom 环境里解析这个虚拟模块会抛
// `fileURLToPath: file:///@react-refresh` 不是合法文件 URL —— 任何「导入 .tsx 组件」
// 的测试都在收集阶段就崩。测试不需要 HMR；JSX 交给 esbuild 的 automatic runtime 即可。
export default defineConfig({
  plugins: process.env.VITEST ? [] : [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "chrome105",
    // Tauri 应用从本地文件加载，大 chunk 没有网络代价；mermaid/cytoscape
    // 等渲染依赖单包超 1MB 是常态，把告警阈值调到不刷屏的水平。
    chunkSizeWarningLimit: 1500,
  },
});
