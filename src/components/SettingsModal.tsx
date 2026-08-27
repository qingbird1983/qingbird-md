// T26 设置弹窗：布局逐项对应旧版 egui「翻译设置」窗（main.rs settings_window）。
// 打开即把 store settings 拷贝为本地草稿——settings-updated 广播与外部保存
// 都不会打翻编辑中的表单（store 监听端本就只收敛 theme）；取消/失败全弃，
// 保存经 settingsStore.save（乐观写 + 失败回滚 + toast），成功后关闭。
// 安全：凭据输入框一律 password 型（secret 字段），绝不打印/toast 任何载荷。
import { useEffect, useState } from "react";
import Modal from "./Modal";
import { api } from "../lib/ipc";
import type { ProviderInfo, Settings } from "../types/ipc";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useUiStore, errText } from "../stores/useUiStore";

const HOTKEY_MODES: Array<[string, string]> = [
  ["original", "原文"],
  ["translation", "译文"],
  ["bilingual", "中英对照"],
];

const TEST_TEXT = "Hello, this is a translation test.";

/** 旧版 key_name 的 web 等价：白名单只收字母/数字/空格（与 egui 版一致）。 */
function keyName(e: KeyboardEvent): string | null {
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return e.key;
  if (e.key === " ") return "Space";
  return null;
}

export default function SettingsModal() {
  const close = useUiStore((s) => s.closeSettings);
  const live = useSettingsStore((s) => s.settings);

  // ---- 草稿：hotkeys / selection_translate 存 draft；provider/creds 独立
  // 表单态（切换翻译源即换凭据子集），保存时才合并回完整 Settings ----
  const [draft, setDraft] = useState<Settings | null>(() =>
    live ? { ...live, providers: { ...live.providers } } : null,
  );
  const [metas, setMetas] = useState<ProviderInfo[]>([]);
  const [formProvider, setFormProvider] = useState(() => live?.provider ?? "");
  const [formCreds, setFormCreds] = useState<Record<string, string>>(() =>
    live ? (live.providers[live.provider] ?? {}) : {},
  );
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);

  // 理论竞态兜底：设置尚未加载完就打开弹窗（live 到达后补种草稿一次）
  useEffect(() => {
    if (live && !draft) {
      setDraft({ ...live, providers: { ...live.providers } });
      setFormProvider(live.provider);
      setFormCreds(live.providers[live.provider] ?? {});
    }
  }, [live, draft]);

  // 翻译源元数据（label/note/fields）来自后端注册表，打开时拉一次
  useEffect(() => {
    let alive = true;
    api
      .getProviders()
      .then((m) => {
        if (alive) setMetas(m);
      })
      .catch((e) => {
        if (alive) useUiStore.getState().addToast("error", `读取翻译源失败：${errText(e)}`);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 快捷键录制：capture 阶段吃掉全部按键（含 Esc——壳层按 defaultPrevented
  // 让路）；修饰必须有才收（Ctrl/Alt/Shift 顺序固定，与旧版 hotkey_combo 一致）
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.key === "Escape") {
        setRecording(null);
        setTestResult("已取消录制");
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (!e.ctrlKey && e.metaKey) parts.push("Meta");
      const name = keyName(e);
      if (!name || parts.length === 0) return; // 缺修饰或非白名单键：继续等
      const mode = recording;
      const combo = [...parts, name].join("+");
      setDraft((d) => (d ? { ...d, hotkeys: { ...d.hotkeys, [mode]: combo } } : d));
      setRecording(null);
      setTestResult(`已保存快捷键（${mode}）：${combo}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const meta = metas.find((m) => m.key === formProvider) ?? null;

  const changeProvider = (k: string) => {
    setFormProvider(k);
    setFormCreds(draft?.providers[k] ?? {});
    setTestResult("");
  };

  const testConn = async () => {
    setTesting(true);
    setTestResult("测试中…");
    try {
      const out = await api.translateText(TEST_TEXT, formProvider, formCreds);
      setTestResult(`成功：${out}`);
    } catch (e) {
      setTestResult(`失败：${errText(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const clearCache = async () => {
    try {
      await api.clearCache();
      setTestResult("翻译缓存已清除。");
    } catch (e) {
      setTestResult(`失败：${errText(e)}`);
    }
  };

  const save = async () => {
    if (!draft || saving) return;
    const next: Settings = {
      ...draft,
      provider: formProvider,
      providers: { ...draft.providers, [formProvider]: formCreds },
    };
    // T29 Meta 决议：录制器可录出 "Meta+X"（T26 行为保留），但解析/注册层显式
    // 拒绝（Win 键组合系统占用多、行为不稳定，见 lib/hotkeys.ts 与
    // src-tauri/src/hotkeys.rs registrable 注释）——保存时提示用户换组合。
    if (Object.values(next.hotkeys).some((c) => c.split("+").some((p) => p === "Meta"))) {
      useUiStore.getState().addToast("error", "含 Meta(Win) 键的快捷键不受支持，请改用 Ctrl/Alt/Shift 组合");
    }
    setSaving(true);
    // store.save：失败内部回滚 + toast（草稿保持打开），成功后后端广播
    // settings-updated 回到 store（监听端收敛 theme + 同步 toast）
    await useSettingsStore.getState().save(next);
    setSaving(false);
    // 乐观写 next / 失败回滚 prev——按引用判别保存成败
    if (useSettingsStore.getState().settings === next) close();
  };

  return (
    <Modal title="翻译设置" onClose={close}>
      {!draft ? (
        <div className="modal-note">设置尚未加载。</div>
      ) : (
        <>
          <div className="modal-row">
            <label htmlFor="set-provider">翻译源</label>
            <select id="set-provider" value={formProvider} onChange={(e) => changeProvider(e.target.value)}>
              {metas.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
              {!metas.some((m) => m.key === formProvider) && (
                <option value={formProvider}>{formProvider}</option>
              )}
            </select>
          </div>
          {meta && (
            <>
              <div className="modal-note">{meta.note}</div>
              {meta.fields.length === 0 ? (
                <div className="modal-note">该翻译源无需密钥，可直接使用。</div>
              ) : (
                meta.fields.map((f) => (
                  <div className="modal-row" key={f.key}>
                    <label htmlFor={`set-f-${f.key}`}>{f.label}</label>
                    <input
                      id={`set-f-${f.key}`}
                      type={f.secret ? "password" : "text"}
                      value={formCreds[f.key] ?? ""}
                      placeholder={f.placeholder}
                      title={f.placeholder}
                      autoComplete="off"
                      onChange={(e) => setFormCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                    />
                  </div>
                ))
              )}

              <div className="modal-sep" />
              <div className="modal-row">
                <button type="button" className="modal-btn" disabled={testing} onClick={testConn}>
                  测试连接
                </button>
                <button type="button" className="modal-btn" onClick={clearCache}>
                  清除翻译缓存
                </button>
              </div>
              {testResult && <div className="modal-test">{testResult}</div>}

              <div className="modal-sep" />
              <div className="modal-note">阅读模式快捷键（点击后按下组合键，须含 Ctrl/Alt/Shift）</div>
              {HOTKEY_MODES.map(([mode, label]) => (
                <div className="modal-row" key={mode}>
                  <label htmlFor={`set-hk-${mode}`}>{label}</label>
                  <button
                    type="button"
                    id={`set-hk-${mode}`}
                    className="modal-btn"
                    onClick={() => {
                      setTestResult("");
                      setRecording(mode);
                    }}
                  >
                    {recording === mode ? "按下快捷键…" : (draft.hotkeys[mode] || "未设置")}
                  </button>
                </div>
              ))}

              <div className="modal-sep" />
              <div className="modal-row modal-check">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.selection_translate}
                    onChange={(e) =>
                      setDraft((d) => (d ? { ...d, selection_translate: e.target.checked } : d))
                    }
                  />
                  启用划词翻译（选中文字即弹出译文）
                </label>
              </div>

              <div className="modal-sep" />
              <div className="modal-actions">
                <button type="button" className="modal-btn" onClick={close}>
                  取消
                </button>
                <button type="button" className="modal-btn modal-btn-primary" disabled={saving} onClick={save}>
                  保存
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
