// 代码量预算守卫：**模块行数在写代码的时候就钳住，不允许先膨胀、最后再来一轮大拆分**
// （2026-09-21 定红线）。背景：P0/P1/P2 三轮拆分整改（2026-09-16-module-splits.md）
// 把 16 个超标文件拆回阈值内花了整整三个批次——教训是「写的时候不限行数，最后必然
// 要专门付一次重构的账」。本测试把拆分阈值变成每次 `npm test` 的硬门禁：新文件超线
// 当场红，改存量文件把涨破线也当场红。
//
// 阈值口径 = module-splits §二（拆分判定线）；计数口径 = wc -l（换行符个数，该计划
// 复核时定下的权威口径）：
//   · Rust / TS 生产代码单文件         ≤ 400 行
//   · Rust 内联测试块（#[cfg(test)]） ≤ 300 行
//   · 任何单文件总量（含测试）         ≤ 700 行
//   · CSS 单文件                       ≤ 800 行
//
// 存量处理 = 冻结，不追溯：已超线的文件登记在 GRANDFATHERED（2026-09-21 全树扫描
// 快照），冻结在快照行数——只许变小，长大一行就红；修回线内后测试会强制要求删除
// 豁免条目（防名单腐烂）。新文件没有豁免可吃。**不许为过测试调高阈值或放松快照；
// 确需新开豁免必须在提交信息里写明理由与修复计划。**
//
// 本文件必须是 **node 环境**（默认）：要 walk 真实文件树（同 scrollbarUnified.test）。
//
// Rust 内联测试块的识别约定：`#[cfg(test)]` 标注的 mod，花括号配对取块大小（约定
// 测试块在文件尾；深度不归零按到文件尾计）；`#[path = "x_tests.rs"] mod tests;`
// 兄弟转发只计转发行本身，x_tests.rs 按 rust-test 只受总量线约束。已知盲区：字符串
// 字面量里的不配对花括号会让块尾误判——方向只会「多算测试块、少算生产行数」，且
// 总量 ≤700 兜底，可接受；计数器对 runner.rs 的 331/284 与 P2-7j 提交信息的人工
// 审计数字逐项一致。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CAP = { prod: 400, inlineTest: 300, total: 700, css: 800 } as const;

/** 存量超标豁免表（2026-09-21 快照）：冻结在快照行数，只许减不许增。
 *  key = 仓库相对路径（正斜杠）；value = 冻结的指标（未写的指标吃硬上限）。
 *  文件修回线内后必须删除条目（hygiene 用例强制）。 */
const GRANDFATHERED: Record<string, { prod?: number; inlineTest?: number; total?: number }> = {
  "src/stores/useWorkspaceStore.ts": { prod: 640 },
  "src/lib/translationStream.ts": { prod: 492 },
  "src/components/SettingsModal.tsx": { prod: 455 },
  "src/stores/useDocStore.ts": { prod: 435 },
  "src-tauri/src/translate/http.rs": { inlineTest: 371, total: 748 },
  "src-tauri/src/translate/export.rs": { inlineTest: 400 },
};

// ---------- 文件收集 ----------
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const toRel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");
const FILES = [
  ...[...walk(join(ROOT, "src"))].filter((p) => /\.(ts|tsx|css)$/.test(p)),
  ...[...walk(join(ROOT, join("src-tauri", "src")))].filter((p) => p.endsWith(".rs")),
].map((p) => ({ rel: toRel(p), text: readFileSync(p, "utf-8") }));

// ---------- 计数 ----------
/** wc -l 口径：换行符个数。 */
const lineCount = (text: string) => (text.match(/\n/g) ?? []).length;

interface Metrics {
  total: number;
  prod: number;
  inlineTest: number;
}
const tsMetrics = (text: string): Metrics => {
  const total = lineCount(text);
  return { total, prod: total, inlineTest: 0 };
};

/** 内联测试块 = #[cfg(test)] 标注的 mod（花括号配对）；多处累加。 */
function rustMetrics(text: string): Metrics {
  const lines = text.split("\n");
  const total = lineCount(text);
  let inlineTest = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes("#[cfg(test)]")) {
      // 向后扫过属性行，找它标注的 mod；途中撞到下一个 #[cfg(test)] 则本行是单项目标注
      let j = i + 1;
      while (
        j < lines.length &&
        !/^\s*(pub(\([^)]*\))?\s+)?mod\b/.test(lines[j]) &&
        !lines[j].includes("#[cfg(test)]")
      )
        j++;
      if (j < lines.length && /mod\b/.test(lines[j])) {
        if (lines[j].trimEnd().endsWith(";")) {
          // 兄弟文件转发：`#[cfg(test)] #[path = "x_tests.rs"] mod tests;` 无内联体
          inlineTest += j - i + 1;
          i = j + 1;
          continue;
        }
        let depth = 0;
        let seenOpen = false;
        let k = j;
        for (; k < lines.length; k++) {
          for (const ch of lines[k]) {
            if (ch === "{") {
              depth++;
              seenOpen = true;
            } else if (ch === "}") depth--;
          }
          if (seenOpen && depth <= 0) break;
        }
        inlineTest += k - i + 1;
        i = k + 1;
        continue;
      }
    }
    i++;
  }
  return { total, prod: total - inlineTest, inlineTest };
}

// ---------- 判定 ----------
type Kind = "ts-prod" | "ts-test" | "css" | "rust-prod" | "rust-test";
function kindOf(rel: string): Kind {
  if (/\.css$/.test(rel)) return "css";
  if (/_tests\.rs$/.test(rel)) return "rust-test";
  if (/\.rs$/.test(rel)) return "rust-prod";
  if (/\.test\.(ts|tsx)$/.test(rel)) return "ts-test";
  return "ts-prod";
}

/** 单文件预算判定：返回可读的违规描述（空数组 = 通过）。 */
function check(rel: string, text: string): string[] {
  const kind = kindOf(rel);
  const m = kind === "rust-prod" || kind === "rust-test" ? rustMetrics(text) : tsMetrics(text);
  const gf = GRANDFATHERED[rel];
  const tag = gf ? "冻结豁免（只许减不许增）" : "硬上限";
  const over: string[] = [];
  const totalCap = gf?.total ?? (kind === "css" ? CAP.css : CAP.total);
  if (m.total > totalCap)
    over.push(`${rel}: 总量 ${m.total} 行 > ${totalCap}（${tag}），超 ${m.total - totalCap} 行`);
  if (kind === "ts-prod" || kind === "rust-prod") {
    const prodCap = gf?.prod ?? CAP.prod;
    if (m.prod > prodCap)
      over.push(
        `${rel}: 生产 ${m.prod} 行 > ${prodCap}（${tag}），超 ${m.prod - prodCap} 行——` +
          `按 docs/superpowers/plans/2026-09-16-module-splits.md 的拆分处方切子模块/抽 hook，` +
          `不要提高阈值、不要新开豁免`,
      );
  }
  if (kind === "rust-prod") {
    const itCap = gf?.inlineTest ?? CAP.inlineTest;
    if (m.inlineTest > itCap)
      over.push(
        `${rel}: 内联测试块 ${m.inlineTest} 行 > ${itCap}（${tag}），超 ${m.inlineTest - itCap} 行——` +
          `把测试挪到同目录 *_tests.rs（#[cfg(test)] #[path] 转发，私有项仍可见）`,
      );
  }
  return over;
}

// ---------- 主守卫 ----------
describe("代码量预算守卫（module-splits §二阈值，2026-09-21 定线）", () => {
  it("全树扫描：src + src-tauri/src 的每一份文件都在预算内", () => {
    const bad = FILES.flatMap((f) => check(f.rel, f.text));
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("豁免表卫生：修回线内的条目必须移除，防名单腐烂", () => {
    const stale: string[] = [];
    for (const rel of Object.keys(GRANDFATHERED)) {
      const f = FILES.find((x) => x.rel === rel);
      if (!f) {
        stale.push(`${rel}: 文件已不存在，请从 GRANDFATHERED 删除该条目`);
        continue;
      }
      const m = kindOf(rel) === "rust-prod" ? rustMetrics(f.text) : tsMetrics(f.text);
      const within = m.prod <= CAP.prod && m.inlineTest <= CAP.inlineTest && m.total <= CAP.total;
      if (within)
        stale.push(
          `${rel}: 现已 生产${m.prod}/测试块${m.inlineTest}/总量${m.total}，全部回到硬上限内——` +
            `请从 GRANDFATHERED 删除该条目（快照只许收紧，不许放松）`,
        );
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});

// ---------- 计数器自证（「旧代码会让它变红」的形态） ----------
describe("预算计数器自证", () => {
  const tsFile = (n: number) =>
    Array.from({ length: n }, (_, k) => `export const v${k} = ${k};`).join("\n") + "\n";
  const rustFile = (prod: number, testLines: number) => {
    const body =
      Array.from({ length: prod }, (_, k) => `pub fn p${k}() {}`).join("\n") + "\n";
    const inner = testLines - 3; // #[cfg(test)] 行 + `mod tests {` 行 + 收尾 `}` 行
    const test =
      "#[cfg(test)]\nmod tests {\n" +
      Array.from(
        { length: inner },
        (_, k) => `    #[test] fn t${k}() { assert_eq!(${k}, ${k}); }`,
      ).join("\n") +
      "\n}\n";
    return body + test;
  };

  it("TS 生产文件 400 行放行、401 行判红", () => {
    expect(check("src/demo.ts", tsFile(400))).toEqual([]);
    expect(check("src/demo.ts", tsFile(401)).length).toBeGreaterThan(0);
  });

  it("Rust 内联测试块 300 行放行、301 行判红（P2 拆 runner 前的 339 行正是栽在这条线）", () => {
    expect(check("src-tauri/src/demo.rs", rustFile(350, 300))).toEqual([]);
    const over = check("src-tauri/src/demo.rs", rustFile(350, 301));
    expect(over.some((s) => s.includes("内联测试块"))).toBe(true);
  });

  it("冻结豁免只许减不许增：GRANDFATHERED 文件比快照长大一行就判红", () => {
    const rel = "src/demo_gf.ts";
    GRANDFATHERED[rel] = { prod: 500 };
    try {
      expect(check(rel, tsFile(500))).toEqual([]);
      expect(check(rel, tsFile(501)).length).toBeGreaterThan(0);
    } finally {
      delete GRANDFATHERED[rel];
    }
  });
});
