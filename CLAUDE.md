# CLAUDE.md

青鸟（qingbird-md-rust）：Tauri 2 + React 19 的 Markdown 翻译编辑器。前端 `src/`（React + zustand + CodeMirror 6），后端 `src-tauri/src/`（Rust）。历史计划与执行记录在 `docs/superpowers/plans/`。

## 硬门禁（每次交付前全过）

```powershell
cd src-tauri; cargo check --all-targets   # 0 error 0 warning
cargo test
npx tsc --noEmit                           # 期望 0 输出
npm test                                   # vitest run
```

构建走 PowerShell（Bash 通道会静默失败）。

## 模块行数预算（2026-09-21 定红线，写代码时即生效，不是事后补救）

**任何改动不得让文件超过预算。守卫测试 `src/lib/codeSizeBudget.test.ts` 随每次 `npm test` 强制执行。**

| 对象 | 上限 |
| --- | --- |
| Rust / TS 生产代码单文件 | ≤ 400 行 |
| Rust 内联测试块（`#[cfg(test)]` mod） | ≤ 300 行 |
| 任何单文件总量（含测试） | ≤ 700 行 |
| CSS 单文件 | ≤ 800 行 |

1. 新文件直接按预算写；改到线边就当场拆（按职责切子模块 / 抽 hook / 测试挪 `*_tests.rs` 兄弟文件），**不得把拆分欠账留给以后**——2026-09 的 P0/P1/P2 三轮拆分整改（`2026-09-16-module-splits.md`）就是为了偿还这种欠账，不要再来一轮。
2. 存量超标文件冻结在守卫测试的 `GRANDFATHERED` 快照里（2026-09-21）：只许变小，长大一行就红；修回线内后必须删掉豁免条目（测试会强制提示）。
3. 拆分处方（怎么切、切到哪）唯一真源：`docs/superpowers/plans/2026-09-16-module-splits.md` §二。
4. 不许为过测试调高阈值、放松快照或偷开豁免；确需新开豁免，提交信息里必须写明理由与修复计划。

## 其他长期红线

- 快捷键单一真源 `src/lib/hotkeyRegistry.ts`，新增键必须让三方对齐测试通过。
- 滚动条样式只许写在 `src/styles/11-toast-command.css`，新滚动容器无需登记（守卫 `src/lib/scrollbarUnified.test.ts`）。
- `data-bi` / `data-ri` 索引空间不得自建 walker。
- 新守卫测试必须验证「旧代码会让它变红」，不许写成只会通过的测试。
- 前端调试用 happy-dom + `__TAURI_INTERNALS__` 垫片冒烟（TitleBar 顶层 `getCurrentWindow()`，普通浏览器打不开）。
