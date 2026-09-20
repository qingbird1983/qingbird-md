// 设置面板「数据与维护」页（P2-8c 自 SettingsModal.tsx 的 data 分支纯提取）：
// 翻译缓存清理、打开缓存目录、数据存放说明。目录显示形态（环境变量写法）
// 由打开弹窗时拉取的 dirLabel 决定（主组件持有）。
import { FolderOpen, Info } from "lucide-react";

export interface DataTabProps {
  dirLabel: string;
  clearCache: () => Promise<void>;
  openCacheDir: () => Promise<void>;
}

export default function DataTab({ dirLabel, clearCache, openCacheDir }: DataTabProps) {
  return (
    <>
      <section className="set-sec">
        <div className="setti">
          <div className="setti-info">
            <div className="setti-label">翻译缓存</div>
            <div className="setti-desc">
              译文按「内容 + 模型 + 提示词版本」哈希缓存，重复段落秒回；清空后下次翻译重新请求。
            </div>
          </div>
          <div className="setti-ctl">
            <button type="button" className="modal-btn" onClick={() => void clearCache()}>
              清除翻译缓存
            </button>
            <button
              type="button"
              className="modal-btn set-ico"
              onClick={() => void openCacheDir()}
            >
              <FolderOpen size={13} />
              打开缓存目录
            </button>
          </div>
        </div>
        <div className="setti">
          <div className="setti-info">
            <div className="setti-label">数据存放</div>
            <div className="setti-desc">
              文档、翻译缓存与接口凭据全部留在本机用户目录，不上传任何服务器；
              只有翻译请求会发往你自己配置的接口。
            </div>
          </div>
        </div>
        {/* 显示用的是「环境变量形态」（%APPDATA%\qingbird-md）而不是绝对路径：
            绝对路径里带着本机用户名，换台电脑看到会以为路径不对。实际路径
            是每次启动现算的，本来就不会错——这里改的是**观感**。 */}
        {dirLabel && (
          <div className="set-hint">
            <Info size={13} />
            <span>
              数据目录：<span className="set-path">{dirLabel}</span>
              （缓存文件 <span className="set-path">qingbird-cache.json</span> 就在里面）
            </span>
          </div>
        )}
      </section>
    </>
  );
}
