import { useCallback, useEffect, useRef } from 'react';
import StudioApp, { type CinematicStudioAppStateSnapshot } from './app/App';
import type { CinematicStudioQuickSync, CinematicStudioUpstreamText } from './app/quickStudioSync';
import type { CanvasAudioSource } from './app/components/AssetLibrary';
import type { CanvasImageSource } from './app/components/DirectorLayersCard';
import './app/styles.css';

export interface CinematicStudioWorkbenchProps {
  onClose: () => void;
  onStateChange?: (snapshot: CinematicStudioAppStateSnapshot) => void;
  onSendToVideo?: (payload: { prompt: string; referenceImages: string[]; referenceAudio: string[] }) => void;
  canvasAudioSources?: CanvasAudioSource[];
  canvasImageSources?: CanvasImageSource[];
  /** 该工作室节点独占的工程 id（每个节点一份独立工程）。 */
  projectId?: string;
  /** 与画布极简节点双向同步的风格、剧情与场景站位数据。 */
  quickSync?: CinematicStudioQuickSync;
  /** 画布上游接入的文本，在高级编辑的风格 / 故事梗概下方作灰色只读回显（不落工程文件）。 */
  quickSyncUpstream?: CinematicStudioUpstreamText;
}

/**
 * 提示词工作室全屏嵌入层。顶层留有 LenTalk 标题栏高度(top-10),
 * 与 3D 导演台保持一致;样式通过 .cinematic-studio-app 作用域隔离。
 */
export function CinematicStudioWorkbench({ onClose, onStateChange, onSendToVideo, canvasAudioSources, canvasImageSources, projectId, quickSync, quickSyncUpstream }: CinematicStudioWorkbenchProps) {
  const latestSnapshot = useRef<CinematicStudioAppStateSnapshot>({});

  const handleStateChange = useCallback(
    (snapshot: CinematicStudioAppStateSnapshot) => {
      latestSnapshot.current = snapshot;
      onStateChange?.(snapshot);
    },
    [onStateChange]
  );

  const handleClose = useCallback(() => {
    // 关闭前补发一次最新状态,避免防抖尚未触发时丢失最后一次编辑。
    onStateChange?.(latestSnapshot.current);
    onClose();
  }, [onClose, onStateChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // 卸载（关闭工作室）时注销画布素材库中的 bridge，
  // 避免侧边栏持有指向已卸载实例的 stale dispatch（点编辑/新增全部无响应）。
  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent("lentalk:unregister-cinematic-asset-library"));
    };
  }, []);

  return (
    <div
      className="cinematic-studio-app fixed inset-x-0 bottom-0 top-10 z-[120] overflow-hidden"
      data-cinematic-studio
      onDoubleClick={(event) => {
        // 阻止双击冒泡到外层 ProjectManager 的「双击空白新建项目」处理
        event.stopPropagation();
      }}
    >
      <main className="cinematic-studio-body">
        <StudioApp onClose={handleClose} onStateChange={handleStateChange} onSendToVideo={onSendToVideo} canvasAudioSources={canvasAudioSources} canvasImageSources={canvasImageSources} projectId={projectId} quickSync={quickSync} quickSyncUpstream={quickSyncUpstream} />
      </main>
    </div>
  );
}
