import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy, Library, Trash2 } from "lucide-react";

interface AssetCategoryOption {
  id: string;
  name: string;
}

interface CanvasContextMenuProps {
  position: { x: number; y: number };
  imageUrl?: string | null;
  nodeId?: string | null;
  canPaste: boolean;
  categories: AssetCategoryOption[];
  failedNodeCount: number;
  onClearFailedNodes: () => void;
  onCopyNode: (nodeId: string) => void;
  onPaste: () => void;
  onAddImageToLibrary: (imageUrl: string, categoryId: string) => void;
  onClose: () => void;
}

export function CanvasContextMenu({
  position,
  imageUrl,
  nodeId,
  canPaste,
  categories,
  failedNodeCount,
  onClearFailedNodes,
  onCopyNode,
  onPaste,
  onAddImageToLibrary,
  onClose,
}: CanvasContextMenuProps) {
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
      if (imageUrl) {
        onAddImageToLibrary(imageUrl, categoryId);
      }
    },
    [imageUrl, onAddImageToLibrary],
  );

  useEffect(() => {
    setIsCategoryPickerOpen(false);
  }, [imageUrl]);

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

      {imageUrl ? (
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
            <span>添加到素材库</span>
          </button>
        )
      ) : (
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
      )}
    </div>
  );
}
