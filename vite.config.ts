import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome105",
    // Tauri 应用从本地文件加载，大 chunk 没有网络代价；mermaid/cytoscape
    // 等渲染依赖单包超 1MB 是常态，把告警阈值调到不刷屏的水平。
    chunkSizeWarningLimit: 1500,
  },
});
