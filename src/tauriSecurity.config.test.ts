// SEC-1（P1-1）回归钉：CSP 与 asset scope 的修复载体在 src-tauri/tauri.conf.json，
// 前端 vitest 没有 Tauri 运行时，这里直接读配置文件断言安全面本身：
// csp 回退为 null、scope 重新放开为 **、或任一关键指令被删，此测试即红。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf-8"),
) as {
  app: {
    security: {
      csp: string | null;
      assetProtocol: { enable: boolean; scope: string[] };
    };
  };
};
const csp = conf.app.security.csp ?? "";

/** 取某个指令的源 token 列表（`img-src a b;` → ["a","b"]）；指令缺失时为空数组。 */
function sources(directive: string): string[] {
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens[0] === directive) return tokens.slice(1);
  }
  return [];
}

describe("SEC-1: tauri.conf.json 安全配置", () => {
  it("csp 非空且含最小集：default-src 'self' / script-src 'self' / object-src 'none'", () => {
    expect(csp).not.toBe("");
    expect(sources("default-src")).toContain("'self'");
    expect(sources("script-src")).toContain("'self'");
    expect(sources("object-src")).toContain("'none'");
  });

  it("img-src 覆盖 asset 协议（Windows 为 http://asset.localhost）与 data:/blob:/https:", () => {
    const img = sources("img-src");
    for (const src of ["asset:", "http://asset.localhost", "data:", "blob:", "https:", "'self'"]) {
      expect(img).toContain(src);
    }
  });

  it("connect-src 放行 Tauri v2 IPC（ipc: http://ipc.localhost）", () => {
    const conn = sources("connect-src");
    expect(conn).toContain("ipc:");
    expect(conn).toContain("http://ipc.localhost");
  });

  it("style-src 保留 'unsafe-inline'（KaTeX style 属性 + mermaid SVG 内联 <style>）", () => {
    const sty = sources("style-src");
    expect(sty).toContain("'self'");
    expect(sty).toContain("'unsafe-inline'");
  });

  it("asset scope 不再放开为 **（收窄为空集，resolve_image 运行时逐文件放行）", () => {
    expect(conf.app.security.assetProtocol.enable).toBe(true);
    expect(conf.app.security.assetProtocol.scope).not.toContain("**");
    expect(conf.app.security.assetProtocol.scope).toEqual([]);
  });
});
