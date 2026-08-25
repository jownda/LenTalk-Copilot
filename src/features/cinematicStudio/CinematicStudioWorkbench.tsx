import { useCallback, useEffect, useRef } from 'react';
import StudioApp, { type CinematicStudioAppStateSnapshot } from './app/App';
import './app/styles.css';

export interface CinematicStudioWorkbenchProps {
  onClose: () => void;
  onStateChange?: (snapshot: CinematicStudioAppStateSnapshot) => void;
}

/**
 * 电影提示词工作室全屏嵌入层。顶层留有 LenTalk 标题栏高度(top-10),
 * 与 3D 导演台保持一致;样式通过 .cinematic-studio-app 作用域隔离。
 */
export function CinematicStudioWorkbench({ onClose, onStateChange }: CinematicStudioWorkbenchProps) {
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

  return (
    <div
      className="cinematic-studio-app fixed inset-x-0 bottom-0 top-10 z-[120] overflow-hidden bg-[#0f0f0f]"
      data-cinematic-studio
      onDoubleClick={(event) => {
        // 阻止双击冒泡到外层 ProjectManager 的「双击空白新建项目」处理
        event.stopPropagation();
      }}
    >
      <main className="cinematic-studio-body">
        <StudioApp onClose={handleClose} onStateChange={handleStateChange} />
      </main>
    </div>
  );
}