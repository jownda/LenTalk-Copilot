import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardPaste,
  Copy,
  Download,
  Info,
  Library,
  Lock,
  LockOpen,
  PencilLine,
  Save,
  Scissors,
  Trash2,
} from "lucide-react";

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
  /** 右键时节点内被选中的文字：有值时菜单顶部给「复制选中文字」，与「复制节点」分开。 */
  selectedText?: string | null;
  /**
   * 这次右键作用到的节点数：右键落在多选内 → 整片选区。
   * 大于 1 时「复制 / 剪切」显式写成「复制 3 个节点」，让多选这件事看得见。
   */
  selectionCount?: number;
  /** 右键命中的节点是分组时提供冻结/解冻入口 */
  isGroupNode?: boolean;
  groupFrozen?: boolean;
  canPaste: boolean;
  categories: AssetCategoryOption[];
  failedNodeCount: number;
  onClearFailedNodes: () => void;
  onCopyNode: (nodeId: string) => void;
  onCutNode: (nodeId: string) => void;
  /** 复制节点里选中的那段文字（不复制节点）。 */
  onCopySelectedText: () => void;
  /** 复制文本节点的整段内容。 */
  onCopyAllText: () => void;
  onSaveTextToPrompt: () => void;
  onPaste: () => void;
  onAddMediaToLibrary: (url: string, mediaType: "image" | "video" | "audio", categoryId: string) => void;
  onDownloadMedia: (url: string, mediaType: "image" | "video" | "audio") => void;
  /** 打开「节点属性」: 查看媒体本体参数与生成信息。仅媒体节点可用。 */
  onShowProperties?: () => void;
  /** 重命名磁盘上的媒体文件: 只对本地落盘文件出现。 */
  canRenameMedia?: boolean;
  onRenameMedia?: () => void;
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
  selectedText,
  selectionCount = 1,
  isGroupNode = false,
  groupFrozen = false,
  canPaste,
  categories,
  failedNodeCount,
  onClearFailedNodes,
  onCopyNode,
  onCutNode,
  onCopySelectedText,
  onCopyAllText,
  onSaveTextToPrompt,
  onPaste,
  onAddMediaToLibrary,
  onDownloadMedia,
  onShowProperties,
  canRenameMedia = false,
  onRenameMedia,
  onToggleGroupFrozen,
  onClose,
}: CanvasContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [isCategoryPickerOpen, setIsCategoryPickerOpen] = useState(false);
  // 有选中文字时，「复制」要明确写成「复制整个节点」，否则用户点下去才发现复制错了东西。
  const hasSelectedText = Boolean(selectedText && selectedText.trim());
  // 右键落在多选里：整片选区一起复制 / 剪切，文案把数量写出来。
  const multiSelected = selectionCount > 1;
  const copyLabel = multiSelected
    ? t("canvas.contextMenu.copySelection", "复制 {{count}} 个节点", { count: selectionCount })
    : hasSelectedText
      ? t("canvas.contextMenu.copyWholeNode", "复制整个节点")
      : t("canvas.contextMenu.copy", "复制");
  const cutLabel = multiSelected
    ? t("canvas.contextMenu.cutSelection", "剪切 {{count}} 个节点", { count: selectionCount })
    : hasSelectedText
      ? t("canvas.contextMenu.cutWholeNode", "剪切整个节点")
      : t("canvas.contextMenu.cut", "剪切");

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
      {hasSelectedText && (
        <button
          type="button"
          onClick={onCopySelectedText}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          <Copy className="h-4 w-4 text-accent" />
          <span>{t("canvas.contextMenu.copySelectedText", "复制选中文字")}</span>
          <span className="ml-auto text-[10px] tabular-nums text-text-muted">
            {(selectedText ?? "").trim().length}
          </span>
        </button>
      )}

      {hasSelectedText && nodeId && <div className="my-1 border-t border-border-dark/70" />}

      {nodeId && (
        <>
          <button
            type="button"
            onClick={() => onCutNode(nodeId)}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
          >
            <Scissors className="h-4 w-4 text-text-muted" />
            <span>{cutLabel}</span>
            {multiSelected && (
              <span className="ml-auto text-[10px] tabular-nums text-text-muted">{selectionCount}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onCopyNode(nodeId)}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
          >
            <Copy className="h-4 w-4 text-text-muted" />
            <span>{copyLabel}</span>
            {multiSelected && (
              <span className="ml-auto text-[10px] tabular-nums text-text-muted">{selectionCount}</span>
            )}
          </button>
        </>
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
        <>
          <button
            type="button"
            disabled={!textContent.trim()}
            onClick={onCopyAllText}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
          >
            <Copy className="h-4 w-4 text-text-muted" />
            <span>{t("canvas.contextMenu.copyAllText", "复制全部文本")}</span>
          </button>
          <button
            type="button"
            disabled={!textContent.trim()}
            onClick={onSaveTextToPrompt}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
          >
            <Save className="h-4 w-4 text-accent" />
            <span>{t("canvas.contextMenu.saveTextToPrompt", "保存到提示词库")}</span>
          </button>
        </>
      )}


      {!nodeId && (
        <button
          type="button"
          disabled={!canPaste}
          onClick={onPaste}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
        >
          <ClipboardPaste className="h-4 w-4 text-text-muted" />
          <span>{t("canvas.contextMenu.paste", "粘贴")}</span>
        </button>
      )}

      {(nodeId || (!imageUrl && failedNodeCount > 0)) && <div className="my-1 border-t border-border-dark/70" />}

      {/* 属性: 只对带媒体的节点出现(上传图、生成结果图、音频/视频媒体节点)。 */}
      {downloadUrl && downloadMediaType && onShowProperties && (
        <button
          type="button"
          onClick={onShowProperties}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          <Info className="h-4 w-4 text-accent" />
          <span>{t("canvas.contextMenu.properties", "属性")}</span>
        </button>
      )}

      {/* 重命名磁盘文件: 只有本地落盘文件才有意义, 云端链接改了地址会断。 */}
      {canRenameMedia && onRenameMedia && (
        <button
          type="button"
          onClick={onRenameMedia}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-text-dark transition-colors hover:bg-bg-dark"
        >
          <PencilLine className="h-4 w-4 text-accent" />
          <span>{t("canvas.contextMenu.renameMedia", "重命名文件")}</span>
        </button>
      )}

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
          <span>{t("canvas.contextMenu.clearFailedNodes", "清理失败节点")}</span>
          {failedNodeCount > 0 && <span className="ml-auto text-xs text-text-muted">{failedNodeCount}</span>}
        </button>
      ) : null}
    </div>
  );
}
