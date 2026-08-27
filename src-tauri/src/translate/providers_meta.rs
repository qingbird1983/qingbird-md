//! Per-provider metadata used by the settings form and the pipeline.
//! Ported from the Electron `src/translators/providers-meta.js`.

/// A configurable credential field (rendered as a text/password input).
pub struct FieldDef {
    pub key: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub placeholder: &'static str,
}

/// Static metadata for a translation source.
pub struct ProviderMeta {
    pub label: &'static str,
    pub needs_key: bool,
    pub max_len: usize,
    pub max_concurrency: usize,
    pub chunk_concurrency: usize,
    pub fields: &'static [FieldDef],
    pub note: &'static str,
}

const NO_FIELDS: &[FieldDef] = &[];

const MYMEMORY: ProviderMeta = ProviderMeta {
    label: "免费(无需密钥) MyMemory",
    needs_key: false,
    max_len: 500,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: NO_FIELDS,
    note: "无需密钥，每天约 500 次请求，适合先试用；长文/质量一般。",
};

const YOUDAO_FIELDS: &[FieldDef] = &[
    FieldDef { key: "appKey", label: "App Key", secret: false, placeholder: "" },
    FieldDef { key: "appSecret", label: "App Secret", secret: true, placeholder: "" },
];

const YOUDAO: ProviderMeta = ProviderMeta {
    label: "有道智云",
    needs_key: true,
    max_len: 5000,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: YOUDAO_FIELDS,
    note: "需有道智云「文本翻译」服务，单条上限约 5000 字符。",
};

const TENCENT_FIELDS: &[FieldDef] = &[
    FieldDef { key: "secretId", label: "SecretId", secret: false, placeholder: "" },
    FieldDef { key: "secretKey", label: "SecretKey", secret: true, placeholder: "" },
    FieldDef { key: "region", label: "Region", secret: false, placeholder: "ap-beijing" },
];

const TENCENT: ProviderMeta = ProviderMeta {
    label: "腾讯云翻译",
    needs_key: true,
    max_len: 6000,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: TENCENT_FIELDS,
    note: "腾讯云机器翻译 TMT，单条上限 6000 字符。",
};

const BAIDU_FIELDS: &[FieldDef] = &[
    FieldDef { key: "appid", label: "APP ID", secret: false, placeholder: "" },
    FieldDef { key: "key", label: "密钥", secret: true, placeholder: "" },
];

const BAIDU: ProviderMeta = ProviderMeta {
    label: "百度翻译",
    needs_key: true,
    max_len: 6000,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: BAIDU_FIELDS,
    note: "百度通用翻译 API，单条上限 6000 字符。",
};

const LLM_FIELDS: &[FieldDef] = &[
    FieldDef {
        key: "baseUrl",
        label: "API 地址 (Base URL)",
        secret: false,
        placeholder: "https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1",
    },
    FieldDef {
        key: "apiKey",
        label: "API Key",
        secret: true,
        placeholder: "本地服务（如 Ollama）可留空",
    },
    FieldDef {
        key: "model",
        label: "模型名",
        secret: false,
        placeholder: "如 deepseek-chat、qwen2.5:7b",
    },
];

const LLM: ProviderMeta = ProviderMeta {
    label: "自定义大模型（OpenAI 兼容）",
    needs_key: false,
    max_len: 3000,
    max_concurrency: 3,
    chunk_concurrency: 2,
    fields: LLM_FIELDS,
    note: "任意 OpenAI 兼容接口：云端（DeepSeek / 通义 / 智谱等）填官方地址 + Key + 模型名；本机 Ollama 填 http://127.0.0.1:11434/v1 且 Key 留空。更换模型后建议清除翻译缓存。",
};

const TRANSMART: ProviderMeta = ProviderMeta {
    label: "免费(无需密钥) 腾讯Transmart",
    needs_key: false,
    max_len: 2000,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: NO_FIELDS,
    note: "腾讯交互翻译浏览器端点，零密钥（仅需硬编码 client_key），国内裸连稳定；长文档首选。",
};

const ICIBA: ProviderMeta = ProviderMeta {
    label: "免费(无需密钥) 金山iCiba",
    needs_key: false,
    max_len: 1000,
    max_concurrency: 12,
    chunk_concurrency: 4,
    fields: NO_FIELDS,
    note: "金山词霸批量翻译，零密钥（MD5 签名），国内可用；作自动备用源。",
};

const AUTO: ProviderMeta = ProviderMeta {
    label: "免费自动（腾讯→金山→MyMemory 兜底）",
    needs_key: false,
    max_len: 1000,
    max_concurrency: 3,
    chunk_concurrency: 2,
    fields: NO_FIELDS,
    note: "默认推荐：自动按序尝试腾讯Transmart、金山iCiba，全部失败再用MyMemory兜底，无需任何配置。",
};

/// Ordered provider registry (key, meta), matching the JS `index.js` ordering.
pub const REGISTRY: &[(&str, ProviderMeta)] = &[
    ("mymemory", MYMEMORY),
    ("youdao", YOUDAO),
    ("tencent", TENCENT),
    ("baidu", BAIDU),
    ("llm", LLM),
    ("transmart", TRANSMART),
    ("iciba", ICIBA),
    ("auto", AUTO),
];

pub fn get(key: &str) -> Option<&'static ProviderMeta> {
    REGISTRY.iter().find(|(k, _)| *k == key).map(|(_, m)| m)
}
