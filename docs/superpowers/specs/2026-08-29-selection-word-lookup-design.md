# qingbird-md-rust — 选区查词（LLM 富卡片） — Design

**Date:** 2026-08-29 · **Status:** Draft for review · **Author:** agent

## 1. Summary

把现有的"划词翻译"浮窗从纯文本译文升级为 **LLM 驱动的富查词体验**：划词后由 LLM 自动判断选中内容是词/短语还是句子/段落——词出富卡片（译文、IPA 音标、词性、用法说明、双语例句、生僻词逐个解释），句出整句翻译。同时增强"自定义大模型"翻译源的配置体验：新增可选"查词模型"字段与厂商预设下拉。

设计蓝本：mark2 `src/modules/translator/translator.js`（prompt 与结果形态）。本设计已确认的三个决策：

- **范围** = A+C：富查词卡片 + LLM 源配置增强（预设下拉、查词模型）。
- **配置形态** = B1：共用一套 LLM 凭据，查词可选独立模型名（`lookup_model`，留空回落 `model`）。
- **路由规则** = R1：划词一律走 LLM 查词命令（词/句分流交给 LLM prompt），未配置 LLM 时整体回落现状（全局翻译源纯文本），不做前端启发式预分流。

## 2. Goals

1. 划词出富卡片：词 → 译文 + 音标 + 词性 + 用法 + 2-3 条双语例句 + 生僻词列表；句 → 整句翻译。
2. 中英双向自动判向（英文输入给中文解释，中文输入给英文翻译；音标永远给英文侧），UI 无方向开关。
3. 查词结果进翻译缓存，重复查询秒回。
4. 未配置 LLM 时划词行为与现状完全一致（零感知回落）。
5. 设置弹窗：LLM 源新增可选"查词模型"输入框与厂商预设下拉（选中即填 baseUrl，模型名 datalist 建议）。
6. 卡片排版为已确认的"纵向层级"形态（mockup 方向 A），跟随应用亮/暗主题。
7. 模型 ID 支持从厂商在线拉取后点选（`GET {base}/models`），消除模型名手填错误；拉取失败可退回手填。

## 3. Non-goals

- 流式输出（返回为单个 JSON，浮窗场景等待可接受；流式仅整篇翻译保留——YAGNI）。
- 查词独立的全套凭据（B2 双配置）：出现真实跨厂商混用需求再加。
- 查词失败静默回落普通翻译（见 §9，失败必须显式可见）。
- 预览视图选区监听（T24 已记录为后续迭代，本次不扩）。
- 划词结果的手动方向切换、发音朗读、复制按钮（未要求）。
- 模型列表的缓存与后台自动刷新（设置页低频操作，YAGNI）。
- 修改整篇翻译流水线（pipeline.rs / 7 翻译源行为不变）。

## 4. 现状与改动面

现有基础（本次复用，不改契约）：

- `providers.rs` 已有 `"llm"` 翻译源（OpenAI 兼容 `/chat/completions`，baseUrl/apiKey/model 三字段，120s 超时）——整篇翻译继续走它，不动。
- `SelectionPopup.tsx` + `App.tsx` 划词订阅 + 300ms 防抖 + 乱序保护（T24）全部保留。
- `useTranslationStore.translateSelection` 现调 `api.translateText`，结果为纯文本字符串。

新增改动面：Rust 侧一个新模块 + 一个新命令；前端一个 DTO 类型、一个 store 分流、一个浮窗渲染升级、设置弹窗两处增强。Rust 翻译流水线、IPC 既有契约零改动。

## 5. 数据契约

### 5.1 DTO（Rust 结构体 serde 不改名（snake_case，仓库线格式惯例，见 ipc.ts 头注）↔ `src/types/ipc.ts` 同名字段，逐字段对齐并纳入契约测试；`Option<T>` → `| null`）

```ts
interface WordLookupDTO {
  kind: "word" | "sentence";   // LLM 判定选中内容的类型
  translation: string;         // 词 → 简洁译名；句 → 整句翻译
  phonetic: string | null;     // 仅 word：英文侧 IPA（带斜杠，如 /əˈmenəti/）
  part_of_speech: string | null; // 仅 word：如 "n."、"v."
  usage: string | null;        // 仅 word：2-4 句中文用法说明
  examples: { en: string; zh: string }[];                            // 仅 word：2-3 条
  terms: { word: string; phonetic: string; explanation: string }[];  // 仅 word：生僻词
}
```

约定：`kind === "sentence"` 时 `phonetic`/`partOfSpeech`/`usage` 为 `null`，`examples`/`terms` 为空数组——一个 DTO 覆盖两种形态，前端按 `kind` 分支渲染。空串字段统一规整为 `null`（Rust 侧 `clean` 时收口）。

### 5.2 Prompt（系统提示词，mark2 蓝本 + 一处适配，全文如下）

```text
你是一个中英翻译助手。用户会输入一个词/短语，或一句话/一段话。

只输出一个 JSON 对象，不要输出任何额外文字，不要用代码块包裹。JSON 结构：
{"type":"word"|"sentence","translation":"翻译结果","phonetic":"音标或null","partOfSpeech":"词性或null","usage":"用法说明或null","examples":[{"en":"英文例句","zh":"中文翻译"}],"terms":[{"word":"英文词","phonetic":"音标","explanation":"中文解释"}]}

规则：
1. 自动判断输入是中文还是英文，做中英互译（中→英、英→中）。
2. 自动判断输入是「词/短语」还是「句子/段落」，填入 type。
3. type 为 word 时（输入是词/短语）：
   - translation：核心翻译，简洁
   - phonetic：英文那一侧单词的 IPA 音标（带斜杠），无法给出为 null
   - partOfSpeech：词性，如 n./v./adj./adv.，无法确定为 null
   - usage：2-4 句简明中文，讲常见搭配、使用语境、易混淆点或近义辨析
   - examples：2-3 个例句，例句要自然、能体现该词的典型用法
   - terms：空数组 []
4. type 为 sentence 时：
   - translation：整句翻译
   - phonetic、partOfSpeech、usage 为 null，examples 为空数组 []
   - terms：从英文那一侧（输入英文则原文、输入中文则译文）挑出的较生僻、较难的单词，
     每个给 word、IPA 音标 phonetic、简洁中文 explanation；常见简单词不挑，没有则空数组
5. 音标只针对英文单词，使用 IPA；中文不需要音标。
```

用户消息 = 划词原文（`text.trim()`，空串前端已拦截不发起请求）。temperature 0.2。

### 5.3 解析容错（Rust 侧）

模型回复可能带 ```json 围栏或夹带说明文字。解析顺序：剥代码围栏 → 截取首个 `{` 至末个 `}` → serde 解析 → 字段规整（空串转 null、数组过滤无效项）。仍失败则返回 `Err`（错误信息含回复内容前 200 字符截断）。

注意：prompt 要求模型输出的键为 `type` 与 `partOfSpeech`（提示词惯例），DTO 字段名为 `kind` 与 `part_of_speech`——Rust 解析层显式映射，映射规则写进单测。

## 6. Rust 侧

### 6.1 新模块 `src-tauri/src/translate/lookup.rs`

- `pub fn llm_lookup(text: &str, creds: &Creds, http: &dyn HttpClient) -> Result<WordLookupDTO, String>`——纯函数签名与现有 provider 一致，可离线 mock 测试。
- 复用 `HttpClient` trait、providers.rs 的 JSON 解析辅助；不新增 HTTP 依赖。
- **模型回落链（B1）**：`lookup_model` 非空用之 → 空则回落 `model` → 两者皆空报"请先在「设置」中填写模型名"。
- baseUrl/apiKey 校验与错误文案与现有 `llm()` 对齐（"请先在「设置」中填写…"）。
- 超时 **30s**（划词为交互等待；整篇 `llm()` 的 120s 不适用）。
- 请求构造：`POST {baseUrl 去尾斜杠}/chat/completions`，apiKey 非空时带 `Authorization: Bearer …`，body 为 `{model, temperature: 0.2, messages: [system, user]}`——与 `llm()` 同形。

### 6.2 命令接线（lib.rs）

`lookup_word(text: String, creds: CredsDTO) -> Result<WordLookupDTO, String>`，async，与现有命令同模式。内部顺序：查缓存 → 命中直接返回 → 未命中调 `llm_lookup` → 成功后写缓存。失败不写缓存（避免坏结果固化）。

### 6.3 缓存（cache.rs 复用）

沿用现有 `provider + 文本 hash` 索引，provider 名用 `"llm-lookup"`，值为 DTO 的 JSON 序列化。查词重复率高，命中即秒回。清缓存入口（设置里的"清除翻译缓存"）自然覆盖。

### 6.4 模型列表拉取命令（lib.rs）

`llm_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String>`，async：

- `GET {base_url 去尾斜杠}/models`，apiKey 非空时带 `Authorization: Bearer …`，超时 15s。
- 解析 OpenAI 兼容响应 `{"object":"list","data":[{"id":"…"},…]}`，取 `data[].id`，去重排序返回。
- 非 2xx 或解析失败 → `Err`（状态码 + 服务端 message 截断），透传给前端展示。
- 前置：HttpClient trait 新增 `get_headers_timeout(url, headers, timeout_ms)` 方法，默认实现回落现有 `get()`（照 `post_json_timeout` 的既有模式）——`UreqClient` 覆写以带请求头与超时，`MockClient` 零改动。
- 不缓存结果：设置页低频操作，每次点击现拉。

## 7. 设置

- `providers_meta.rs`：LLM_FIELDS 增加第 4 个字段 `lookup_model`（label："查词模型（可选，留空同翻译模型）"，secret: false）。凭据走现有 Creds HashMap，storage 零改动，旧设置文件缺字段自然回落。
- **预设下拉**（SettingsModal，前端特判 `provider === "llm"` 渲染，注明不泛化 FieldDef 契约的理由）：预设常量表放前端——

| 预设 | baseUrl | 模型建议（datalist） |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | deepseek-v4-flash, deepseek-v4-pro |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen-flash, qwen-plus, qwen-max |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | glm-5.3-flash, glm-4.7-flash, glm-5.3 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | gemini-3.6-flash, gemini-2.5-flash, gemini-2.5-pro |
| 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | doubao-seed-2-0-lite-260215 等（按发布版本），或推理接入点 ep-… |
| 自定义 | 不填充 | — |

选中预设即覆盖 baseUrl 字段值（apiKey/model/lookup_model 不动）；模型输入框加 datalist 建议。预设表是提示性的，用户可随时手改 baseUrl。预设数据核验于 2026-08-29（DeepSeek 条目为用户自官网复制校正，其余经官方文档检索核对）；模型名会随厂商迭代过时，datalist 仅为建议，不做硬校验。

**模型在线拉取**（`model` 与 `lookup_model` 两个输入框共用）：

- 两个输入框旁各有一个"拉取模型"按钮（baseUrl 非空时可点，共用同一结果缓存于组件态）。
- 点击 → 调 `api.llmListModels(baseUrl, apiKey)` → 成功后 datalist 选项替换为拉取列表，toast 提示条数；失败显示错误信息，不阻塞手填。
- datalist 内容优先级：**拉取结果 > 静态预设建议 > 空**。手填永远允许——各厂商 `/models` 覆盖度不一（豆包可能只返回接入点、部分网关不实现该端点），手填是必要兜底，点选是消除 typo 的主路径。
- apiKey 修改后需重新拉取（不做自动触发，用户点击驱动）。

## 8. 前端

### 8.1 状态与分流

- `SelectionState` 扩展：`{ text, loading, plain: string | null, rich: WordLookupDTO | null, error: string | null }`（原 `result: string` 拆为三形态；防抖 300ms、乱序保护 `cur?.text === text` 原样保留）。
- `translateSelection` 分流（R1）：`credsFor("llm")` 的 baseUrl 与 model 均非空 → `api.lookupWord(text, llmCreds)` → `rich`；否则走现状 `api.translateText` → `plain`。**与全局翻译源选择无关**。
- `ipc.ts`：新增 `WordLookupDTO` 类型与 `api.lookupWord` 类型化调用。

### 8.2 SelectionPopup 渲染（卡片 A，纵向层级）

- `rich.kind === "word"`：词头行（词大字 + IPA 灰字 + 词性小标签）→ 译文加粗大字 → usage 段 → "例句" 小节（每条 en 上 zh 下，en 例句中出现的原词——大小写不敏感——加着重样式）→ 分隔线 → "生僻词" 小节（word + 音标 + 短解释，每行一条）。
- `rich.kind === "sentence"`：词头行不变（标题"划词翻译"），正文仅显示 translation 段。
- `plain` / `error`：现状渲染不变。
- 卡片 `max-height` + `overflow-y: auto`；样式全部走现有 `sel-pop` CSS 变量，暗色主题自动生效。
- loading spinner、Esc/点击外部关闭、开关关闭清态：现状保留。

## 9. 边界行为

1. **未配置 LLM**（baseUrl 或 model 为空）→ 划词与今天完全一致（全局源纯文本），零感知。
2. **配置了但失败**（网络错误/超时/HTTP 错误/JSON 解析失败）→ 浮窗显示错误信息（服务端 message 或解析失败说明，长文本截断），**不静默回落**普通翻译——静默回落会制造"看起来能用其实坏了"的状态。
3. 超长选区不截断（sentence 模式即整段翻译，LLM 上下文兜底）。
4. 请求在途时再次划词：现有乱序保护保证只有最新选区回填。
5. 缓存命中为纯内存/本地读，通常数毫秒返回，loading spinner 不至可见（前端统一先置 loading，不为此做特殊分支）。

## 10. 测试

Rust（`cargo test --workspace`，mock HttpClient 照 `llm_builds_openai_request` 模式）：

1. 请求构造：URL 拼接与尾斜杠归一、Bearer 头有无、body 字段。
2. 模型回落链：`lookup_model` 优先 / 空回落 `model` / 皆空报错。
3. JSON 容错：裸 JSON、围栏包裹、前后杂文本、非法 JSON → Err。
4. DTO 映射：word 全字段 / sentence 全 null、空串规整、terms 无效项过滤。
5. 缓存：写入后命中、key 含 `"llm-lookup"`、失败不写。
6. 契约：DTO serde 输出与 `ipc.ts` camelCase 逐字段对齐（照现有契约测试）。
7. 模型拉取：`data[].id` 正常解析、缺 `data` / 非 2xx → Err、Bearer 头有无、去重排序。

前端（`npm run build` tsc 严格编译 + `docs/regression-checklist.md` 增补手工条目）：

word 卡片各块渲染、sentence 形态、无 LLM 配置回落、失败错误显示、缓存命中秒回、暗色主题、防抖与乱序（连划两次）、模型拉取成功填充 datalist、拉取失败报错且可手填、拉取后改 baseUrl 需重新拉取。

## 11. 参考资料

- mark2 `src/modules/translator/translator.js`——prompt 蓝本与结果形态（本设计已确认适配点见 §5.2）。
- mark2 `src/modules/ai-assistant/providerPresets.js`——预设表蓝本（模型名已按国内常用修订）。
- 本仓 `src-tauri/src/translate/providers.rs`——`llm()` 请求构造与测试模式。
