# S6 · 重排版规则集 执行工单（第 22 项，导出时施加）

**Date:** 2026-09-22
**来源:** A 计划（`2026-09-16-translation-correctness.md`）第 5 步 22–23 + 进度表「下一项 = S6」。
**定位:** A 计划收尾。**本轮经用户拍板只做第 22 项**（确定性规则集，可开关、可预期），且**仅在导出时施加**；**第 23 项（拆段/合段显式操作 +「结构已变」标记 + 对照导出降级）另立工单**，本文档不含。

---

## 一、范围与边界（本轮）

**做什么（22）**：一组**纯确定性、方向相关、幂等、不改块数**的排版规范化，作用在译文文本上，只在用户点「另存为」导出 `.md` 的那一刻施加。

**不做什么**：
- 不碰实时预览、不写回 translation store、不进 Cache（红线：预览期内容规范化会清译文）。
- 不做 AI 重写、不做拆合段（那是 23）。
- 不新增网格列、不动 `data-bi`/`data-ri` 索引空间。

**为什么导出时施加最安全**：`export_translation` 是唯一收口，规则只改写 `translations` map 的 **value**（译文串），**key 一律不动** → 块数不变量天然成立（红线 8），双语对照对齐不受影响。单语模式跑的是 `Inline::Text` run（cmark 已把 code/URL/公式拆成独立节点，run 文本不含这些标记），双语模式的块级译文本就是 `inline_plain_text` 纯文本 —— 两种形态的 value 都是「可安全做标点/间距规范化」的文本。

---

## 二、现状接缝（逐项对仓库核实，2026-09-22）

| 接缝 | 位置 | 状态 |
| --- | --- | --- |
| 导出命令 | `bridge/commands.rs:278` `export_translation(content, translations, mode, target_lang)` | 计划原写的 `policy` 入参**当年被 `target_lang` 取代、并不存在** → 这就是本轮规则入参的天然落点 |
| 分发 | 同函数：`bilingual`→`translate::export::export_bilingual`；默认→`markdown::cmark::export_translation` | 两路径都在 map 建好之后取值 → 在分发前统一规范化 map 即全覆盖 |
| 块数不变量注释 | `translate/export.rs:28-33` 明文「T07/T08 规则在别处，本文件只按当前块数对照」 | 本文档即那「别处」 |
| 既有规范化代码 | **全仓库零存在**（`policy.rs::has_cjk` 只判方向，不改写） | 绿field，本模块是第一块确定性后处理器 |
| CJK 判据 | `policy.rs::has_cjk`（私有，按方向判「要不要译」） | relayout **自带 `is_cjk_char` 谓词**：它不参与占号，与红线 1「needs_translation 三处同步」无关，独立实现不会引起漂移 |
| 布尔开关范式 | `selection_translate`：`storage.rs:69` serde 默认 → `ipc.ts:104` → `useSettingsStore.save` → `TranslateTab.tsx:342` 的 `SwitchRow` | 照抄 |
| 命令注册 | `window_boot.rs:222` `bridge::export_translation`（同命令加参数，handler 列表不动） | — |

---

## 三、规则清单（确定性 + 方向相关 + 幂等）

> 全部在**单个 value 字符串**内操作，绝不增删块、绝不跨 value。方向 `target` 决定全角/半角取向。每条都要有单测，且规则叠加顺序固定。

1. **中英间距（盘古之白）**：CJK 字符与相邻的半角拉丁字母/数字之间插入**一个**半角空格；已有空格/换行不重复插。**两向都跑**（zh/en 都可能中英混排）。幂等。
2. **标点体例（方向相关，保守子集）**：
   - `target=Zh`：当半角 `, ; : ! ?` **紧邻 CJK** 时转对应全角 `，；：！？`；`()` 成对且内侧含 CJK 时转 `（）`；句末 `.` 仅当处于文本尾端或其后是空白+非数字时转 `。`（**刻意不动 `3.14`/`v1.2`/缩写等点号**，宁可漏转不可错转）。
   - `target=En`：全角 `，；：！？。（）` 转回半角；`、`→`, `。
   - 纯 ASCII 段（zh 向）与纯 CJK 段（en 向）不受标点规则影响。
3. **省略号**：`...` / `......` → `……`（zh，两个省略号）/ `…`（en，单个）。已是目标形态的不重复转。
4. **破折号**：`--`（非 markdown 列表/前置符语境）→ `——`（zh）/ `—`（en）。

**红线（违反即返工）**：
- **不改块数 / 不动 map 的 key 集合**——施加前后 key 完全一致（守卫测试）。
- **幂等**：`relayout(relayout(x)) == relayout(x)`（守卫测试）。
- **方向是参数**，与全局 `default_target()` 无关；从 `target_lang` 现算。
- **只在导出时施加**，预览/store/cache 一行不碰。
- 误伤优先于漏改：拿不准的（点号、`--` 在列表行首）一律**不转**。
- 行数预算照 `codeSizeBudget.test.ts`（生产 ≤400 / 内联测试 ≤300 / 单文件 ≤700）。

---

## 四、批次安排（≈1 天）

### 批次一 · 后端规则引擎
1. 新建 `translate/relayout.rs`：`pub fn relayout(text: &str, target: TargetLang) -> String` + `is_cjk_char` 私有谓词；模块头 `//!` 注明属 A 计划第 5 步 22。
2. `translate/mod.rs` 注册 `pub mod relayout;`。
3. 内联 `#[cfg(test)]`：每条规则各向 + 幂等 + 边界（`3.14`、纯英文段、中英混排、URL 残留在纯文本里不误伤、空串）。

### 批次二 · 导出接线 + 开关
4. `commands.rs:278` `export_translation` 增 `relayout: bool` 入参；建 map 后 `if relayout { 对每个 value 走 relayout(v, TargetLang::from_tag(&target_lang)) }` 再分发。
5. `storage.rs` 加 `#[serde(default = "default_true")] pub relayout_on_export: bool` + `Default`（**默认开**，见下「待拍板」）；`ipc.ts` Settings 补字段；`TranslateTab.tsx` 加 `SwitchRow「导出时重排版」`。
6. `ipc.ts::exportTranslation` + `lib/exportTranslation.ts` 透传 `settings.relayout_on_export`。

### 批次三 · 门禁 + 验收
7. 守卫：块数不变量 / 幂等 / 导出接线 true·false / 单语路径语义不变。
8. 四道门禁全绿 + 行数预算。
9. `regression-checklist.md` 补「S6 · 重排版规则集」真机验收条目 → 进度表与 correctness 第 5 步状态翻正（标注 23 另立工单）→ 提交。

---

## 五、待拍板（1 项，真机验收前确认）

- **开关默认值**：工单暂定 **默认开**（中英间距是交付可读性的核心收益，且只在用户主动导出时生效、有独立开关可关）。若你倾向**默认关**（不改变既有导出行为、纯新增能力），批次二 #5 把 `default_true` 换成 `default_false` 即可，其余不变。**请验收时看一眼导出效果再定。**

---

## 六、第 23 项（本轮不做，占位备忘）

拆段/合段显式操作 + 块级「结构已变」标记（持久化到译文条目，非 check.rs 的临时 `StructureMismatch`）+ 双语导出遇标记块降级为「顺序线性对照 + 标注」。**另开工单**，进度表 S6 行标注「22 完成 / 23 另立」。
