// 设置面板跨页共享的小件：Bar（右栏顶部搜索条 + 关闭叉）、SwitchRow（统一开关行）
// 与 ResetAllButton（左栏底端一键恢复，Task 12）。
// （2026-09-24 自 SettingsModal.tsx 整段迁出，签名与实现原样未动——那份文件的
// 生产行数曾被 codeSizeBudget 的 GRANDFATHERED 快照冻结（455 行），「常规」分类
// 接线先腾出预算——迁出后本文件已回到 400 硬上限内，豁免条目已按守卫提示删除。）
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { errText, useUiStore } from "../../stores/useUiStore";

/** 详情栏顶部的工具条：胶囊搜索框 + 关闭叉。
 *  它长在 .set-main 里面而不是横跨整框——用户要的「分割线只占右边宽度、
 *  不通到左边」就是靠这条 border-bottom 落在右栏容器上实现的。 */
export function Bar({
  query,
  setQuery,
  onClose,
}: {
  query: string;
  setQuery: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="set-bar">
      <div className="set-search">
        <Search size={14} />
        <input
          type="search"
          value={query}
          placeholder="搜索设置项"
          aria-label="搜索设置项"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <button type="button" className="set-x" onClick={onClose} aria-label="关闭设置" title="关闭（改动自动保存）">
        <X size={16} />
      </button>
    </div>
  );
}

/** 统一的「左名称+说明 / 右胶囊开关」行（划词翻译等布尔项）。 */
export function SwitchRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setti">
      <div className="setti-info">
        <div className="setti-label">{label}</div>
        {desc && <div className="setti-desc">{desc}</div>}
      </div>
      <div className="setti-ctl">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          className={`sw${checked ? " on" : ""}`}
          onClick={() => onChange(!checked)}
        >
          <span className="sw-thumb" />
        </button>
      </div>
    </div>
  );
}

/** 设置面板左下角「一键恢复默认」：两段式确认（点一次变红提示，再点执行，3s 自动撤销）。 */
export function ResetAllButton() {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const arm = () => {
    setArmed(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setArmed(false), 3000);
  };
  const run = async () => {
    if (timer.current) window.clearTimeout(timer.current);
    setArmed(false);
    try {
      await api.resetSettings();
      await useSettingsStore.getState().load(); // 全量设置从盘上拉回（含明暗/配色/关闭行为…）
      useUiStore.getState().setListGuide(true); // 两条 localStorage 纯偏好跟随回出厂值
      useUiStore.getState().setContentWidth("normal");
      useUiStore.getState().addToast("info", "已恢复全局默认设置（不含最近打开与翻译缓存）");
    } catch (e) {
      useUiStore.getState().addToast("error", `恢复默认失败：${errText(e)}`);
    }
  };
  return (
    <button type="button" className={`set-nav-reset${armed ? " armed" : ""}`}
      onClick={() => (armed ? void run() : arm())}
      title="把全部设置项恢复为出厂默认">
      {armed ? "再点一次确认恢复（不可撤销）" : "一键恢复默认设置"}
    </button>
  );
}
