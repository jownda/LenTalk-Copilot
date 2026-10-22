import { useEffect } from 'react';
import { X } from 'lucide-react';
import './styles/index.css';
import { DirectorDeskShell } from './app/layout/DirectorDeskShell';
import { DirectorCanvas } from './editor/canvas/DirectorCanvas';
import { initDirectorDeskHostBridge } from './editor/io/hostBridge';
import { useDirectorStore } from './editor/store/directorStore';

interface ThreeDDirectorDeskProps {
  onClose: () => void;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** 3D 导演台(内嵌于 LenTalk 的全屏视图) */
export function ThreeDDirectorDesk({ onClose }: ThreeDDirectorDeskProps) {
  const viewMode = useDirectorStore((state) => state.viewMode);
  const setViewMode = useDirectorStore((state) => state.setViewMode);

  useEffect(() => {
    initDirectorDeskHostBridge();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) {
        return;
      }
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'c') {
        event.preventDefault();
        useDirectorStore.getState().copySelectedObjects();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        useDirectorStore.getState().pasteClipboardObjects();
        return;
      }
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        useDirectorStore.getState().undo();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div
      className="director-desk-app fixed inset-x-0 bottom-0 top-10 z-[120] flex flex-col bg-[rgb(var(--bg-rgb))]"
      data-director-desk
      onDoubleClick={(event) => {
        // 阻止双击冒泡到外层 ProjectManager 的「双击空白新建项目」处理
        event.stopPropagation();
      }}
    >
      <header className="top-bar">
        <div className="top-bar-left">
          <h1 className="top-bar-title">3D导演台</h1>
        </div>
        <div className="top-bar-center">
          <div className="mode-toggle ui-segmented" role="group" aria-label="视角切换">
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === 'director' ? 'ui-segmented-item-active' : ''}`}
              aria-pressed={viewMode === 'director'}
              type="button"
              onClick={() => setViewMode('director')}
            >
              导演视角
            </button>
            <button
              className={`mode-toggle-button ui-segmented-item ${viewMode === 'camera' ? 'ui-segmented-item-active' : ''}`}
              aria-pressed={viewMode === 'camera'}
              type="button"
              onClick={() => setViewMode('camera')}
            >
              机位视角
            </button>
          </div>
        </div>
        <div className="top-bar-actions">
          <button
            className="top-bar-action-button"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <DirectorDeskShell>
          <DirectorCanvas />
        </DirectorDeskShell>
      </div>
    </div>
  );
}
