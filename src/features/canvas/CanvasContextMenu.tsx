import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, Copy, Download, Library, Lock, LockOpen, Save, Trash2 } from "lucide-react";

interface AssetCategoryOption {
  id: string;
  name: string;
}

interface CanvasContextMenuProps {
  position: { x: number; y: number };
  imageUrl?: string | null;
  downloadUrl?: string | null;
  downloadMediaType?: "image" | "video" | "audio" | null;
  nodeId?: string | null;
  textContent?: string | null;
  /** 右键命中的节点是分组时提供冻结/解冻入口 */
  isGroupNode?: boolean;
  groupFrozen?: boolean;
  canPaste: boolean;
  categories: AssetCategoryOption[];
  failedNodeCount: number;
  onClearFailedNodes: () => void;
  onCopyNode: (nodeId: string) => void;
  onSaveTextToPrompt: () => void;
  onPaste: () => void;
  onAddMediaToLibrary: (url: string, mediaType: "image" | "video" | "audio", categoryId: string) => void;
  onDownloadMedia: (url: string, mediaType: "image" | "video" | "audio") => void;
  onToggleGroupFrozen: () => void;
  onClose: () => void;
}

export function CanvasContextMenu({
  position,
  imageUrl,
  downloadUrl,
  downloadMediaType,
  nodeId,
  textContent,
  isGroupNode = false,
  groupFrozen = false,
  canPaste,
  categories,
  failedNodeCount,
  onClearFailedNodes,
  onCopyNode,
  onSaveTextToPrompt,
  onPaste,
  onAddMediaToLibrary,
  onDownloadMedia,
  onToggleGroupFrozen,
  onClose,
}: CanvasContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [isCategoryPickerOpen, setIsCategoryPickerOpen] = useState(false);

  const handleClear = useCallback(() => {
    if (failedNodeCount === 0) {
      return;
    }
    onClearFailedNodes();
  }, [failedNodeCount, onClearFailedNodes]);

  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      if (downloadUrl && downloadMediaType) {
        onAddMediaToLibrary(downloadUrl, downloadMediaType, categoryId);
      }
    },
    [downloadMediaType, downloadUrl, onAddMediaToLibrary],
  );

  useEffect(() => {
    setIsCategoryPickerOpen(false);
  }, [downloadMediaType, downloadUrl]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handlePointerDown, true);
    return () => document.removeEventListener("mousedown", handlePointerDown, true);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="absolute z-50 min-w-[184px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark p-1 shadow-xl"
      style={{ left: position.x, top: position.y }}
    >
      {nodeId && (
        <button
          type="button"
          onClick={() => onCopyNode(nodeId)}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          <Copy className="h-4 w-4 text-text-muted" />
          <span>复制</span>
        </button>
      )}

      {isGroupNode && (
        <button
          type="button"
          onClick={onToggleGroupFrozen}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          {groupFrozen ? <LockOpen className="h-4 w-4 text-slate-400" /> : <Lock className="h-4 w-4 text-slate-400" />}
          <span>{groupFrozen ? t("canvas.contextMenu.unfreezeGroup") : t("canvas.contextMenu.freezeGroup")}</span>
        </button>
      )}

      {textContent !== null && textContent !== undefined && (
        <button
          type="button"
          disabled={!textContent.trim()}
          onClick={onSaveTextToPrompt}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
        >
          <Save className="h-4 w-4 text-accent" />
          <span>保存到提示词库</span>
        </button>
      )}


      {!nodeId && (
        <button
          type="button"
          disabled={!canPaste}
          onClick={onPaste}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
        >
          <ClipboardPaste className="h-4 w-4 text-text-muted" />
          <span>粘贴</span>
        </button>
      )}

      {(nodeId || (!imageUrl && failedNodeCount > 0)) && <div className="my-1 border-t border-border-dark/70" />}

      {downloadUrl && downloadMediaType && (
        <button
          type="button"
          onClick={() => onDownloadMedia(downloadUrl, downloadMediaType)}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          <Download className="h-4 w-4 text-accent" />
          <span>
            {downloadMediaType === "video"
              ? t("canvas.contextMenu.downloadVideo")
              : downloadMediaType === "audio"
                ? t("canvas.contextMenu.downloadAudio")
                : t("canvas.contextMenu.downloadImage")}
          </span>
        </button>
      )}

      {downloadUrl && downloadMediaType ? (
        isCategoryPickerOpen ? (
          <div className="max-h-[224px] overflow-y-auto">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => handleCategorySelect(category.id)}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
              >
                <Library className="h-4 w-4 text-accent" />
                <span className="truncate">{category.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsCategoryPickerOpen(true)}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
          >
            <Library className="h-4 w-4 text-accent" />
            <span>{t("canvas.contextMenu.addToAssetLibrary")}</span>
          </button>
        )
      ) : !downloadUrl ? (
        <button
          type="button"
          disabled={failedNodeCount === 0}
          onClick={handleClear}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
        >
          <Trash2 className="h-4 w-4" />
          <span>清理失败节点</span>
          {failedNodeCount > 0 && <span className="ml-auto text-xs text-text-muted">{failedNodeCount}</span>}
        </button>
      ) : null}
    </div>
  );
}
