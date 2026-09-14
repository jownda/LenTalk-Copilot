import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Download, FolderOpen } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';

import { saveImageSourceToDirectory, saveImageSourceToPath } from '@/commands/image';
import { isWindowsDesktopRuntime } from '@/platform/runtime';
import { useSettingsStore } from '@/stores/settingsStore';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

interface MediaDownloadMenuProps {
  source: string;
  nodeId: string;
  mediaType: 'image' | 'video';
  position: { x: number; y: number };
  onClose: () => void;
}

export function MediaDownloadMenu({
  source,
  nodeId,
  mediaType,
  position,
  onClose,
}: MediaDownloadMenuProps): JSX.Element | null {
  const { t } = useTranslation();
  const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
  const [isVisible, setIsVisible] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState(position);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeMenu = useCallback(() => {
    setIsVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frameId);
  }, []);

  // 保存卡片挂到 body 后使用视口坐标，避免被 React Flow 的 transform 偏移。
  // 点击位置优先在右下方展开，窗口边缘不足时自动翻转/收拢。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    const margin = 8;
    const offset = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, position.x + offset),
      Math.max(margin, window.innerWidth - rect.width - margin),
    );
    const top = Math.min(
      Math.max(margin, position.y + offset),
      Math.max(margin, window.innerHeight - rect.height - margin),
    );
    setMenuPosition({ x: left, y: top });
  }, [position, downloadPresetPaths.length, saveError]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [closeMenu]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const handleSaveAs = useCallback(async () => {
    if (isSaving) {
      return;
    }

    setSaveError(null);
    setIsSaving(true);
    try {
      const extension = mediaType === 'video' ? 'mp4' : 'png';
      const defaultPath = `node-${nodeId}.${extension}`;

      // Tauri 桌面端使用原生“另存为”对话框；浏览器预览没有 Tauri 后端，
      // 直接使用浏览器下载，避免点击后静默失败。
      if (!isTauri()) {
        const response = await fetch(source);
        if (!response.ok) {
          throw new Error(`下载失败 (${response.status})`);
        }
        const blobUrl = URL.createObjectURL(await response.blob());
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = defaultPath;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(blobUrl);
        closeMenu();
        return;
      }

      const isWindows = isWindowsDesktopRuntime();
      if (isWindows) {
        await getCurrentWindow().setFocus();
      }

      const selectedPath = await save(isWindows
        ? {
          title: mediaType === 'video' ? '保存视频' : '保存图片',
          defaultPath,
          filters: [{ name: mediaType === 'video' ? 'MP4 视频' : 'PNG 图片', extensions: [extension] }],
        }
        : { defaultPath });
      if (!selectedPath || Array.isArray(selectedPath)) {
        return;
      }
      await saveImageSourceToPath(source, selectedPath);
      closeMenu();
    } catch (error) {
      console.error('Failed to save media with save-as', error);
      setSaveError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  }, [closeMenu, isSaving, mediaType, nodeId, source]);

  const handleSaveToPreset = useCallback(async (targetDir: string) => {
    try {
      await saveImageSourceToDirectory(source, targetDir, `node-${nodeId}`);
      closeMenu();
    } catch (error) {
      console.error('Failed to save media to preset dir', error);
    }
  }, [closeMenu, nodeId, source]);

  const menu = (
    <div
      ref={menuRef}
      className={`fixed z-[120] min-w-[280px] rounded-xl border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
      style={{ left: `${menuPosition.x}px`, top: `${menuPosition.y}px` }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        disabled={isSaving}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        onClick={(event) => {
          event.stopPropagation();
          void handleSaveAs();
        }}
      >
        <Download className="h-4 w-4" />
        {isSaving ? '保存中…' : '选择保存位置'}
      </button>

      {saveError && (
        <p className="px-2.5 pt-1 text-xs text-red-400">{saveError}</p>
      )}

      {downloadPresetPaths.length > 0 ? (
        <div className="mt-1 space-y-1 border-t border-[rgba(255,255,255,0.1)] pt-2">
          {downloadPresetPaths.map((path) => (
            <button
              key={path}
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-bg-dark"
              onClick={() => void handleSaveToPreset(path)}
              title={path}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-1 border-t border-[rgba(255,255,255,0.1)] px-2.5 pt-2 text-xs text-text-muted">
          {t('nodeToolbar.noDownloadPresetPathsHint')}
        </div>
      )}
    </div>
  );

  return typeof document === 'undefined' ? null : createPortal(menu, document.body);
}
