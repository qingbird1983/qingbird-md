// 设置面板「关于」页（P2-8c 自 SettingsModal.tsx 的 about 分支纯提取）：
// 品牌印 + 版本号 + 作者仓库入口。
import { ExternalLink } from "lucide-react";
import { api } from "../../lib/ipc";

/** 关于页的作者仓库入口。先只放 Gitee（用户要求）；GitHub 与「检查更新」
 *  后续按同样的形状加进 `.about-links` 那一行即可。
 *  链接交给 `api.openExternal`（Rust 侧 open_external 会做协议白名单校验）。 */
const AUTHOR_REPO = {
  label: "作者仓库 · Gitee",
  url: "https://gitee.com/muyan1983/qingbird-md",
};

export default function AboutTab() {
  return (
    /* 排版对齐欢迎页：居中一列（.about-wrap 负责整块在详情栏里垂直居中） */
    <div className="about-wrap">
      <div className="about-inner">
        <div className="about-seal" aria-hidden>
          青
        </div>
        <div className="about-name">青鸟 Markdown</div>
        <div className="about-ver">v{__APP_VERSION__} · Tauri + React</div>
        <p className="about-desc">
          本地优先的 Markdown 阅读与翻译工具：流式译文边出边看，
          分段对照，代码块与表格原样保留。
        </p>
        {/* 仓库入口在内容下方、居中。将来加 GitHub / 检查更新就并排加按钮。 */}
        <div className="about-links">
          <button
            type="button"
            className="modal-btn set-ico"
            onClick={() => {
              // 打不开就静默：这是可选的外链，弹错反而打扰阅读
              api.openExternal(AUTHOR_REPO.url).catch(() => {});
            }}
          >
            <ExternalLink size={13} />
            {AUTHOR_REPO.label}
          </button>
        </div>
      </div>
    </div>
  );
}
