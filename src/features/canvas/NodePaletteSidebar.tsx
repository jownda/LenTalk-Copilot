import { useMemo } from 'react';
import { Image, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

import { nodeMenuIconMap } from './NodeSelectionMenu';

export const CANVAS_NODE_DRAG_DATA_TYPE = 'application/x-lentalk-canvas-node';

interface NodePaletteSidebarProps {
  open: boolean;
  onToggle: () => void;
  onSelect: (type: CanvasNodeType) => void;
}

export function NodePaletteSidebar({ open, onToggle, onSelect }: NodePaletteSidebarProps) {
  const { t } = useTranslation();
  const menuItems = useMemo(() => nodeCatalog.getMenuDefinitions(), []);

  return (
    <aside
      className={`absolute left-3 top-3 z-30 flex max-h-[calc(100%-24px)] w-12 flex-col overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl transition-transform duration-150 ${
        open ? 'translate-x-0' : '-translate-x-[calc(100%+16px)]'
      }`}
      aria-label={t('canvas.nodePalette.title', '节点')}
    >
      <div className="flex h-10 shrink-0 items-center justify-center border-b border-border-dark">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
          title={t('canvas.nodePalette.hide', '隐藏节点栏')}
          aria-label={t('canvas.nodePalette.hide', '隐藏节点栏')}
          onClick={onToggle}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <div className="ui-scrollbar min-h-0 overflow-y-auto p-1.5">
        {menuItems.map((item) => {
          const Icon = nodeMenuIconMap[item.menuIcon] ?? Image;
          return (
            <button
              key={item.type}
              type="button"
              draggable
              className="flex min-h-12 w-full cursor-grab flex-col items-center justify-center gap-0.5 rounded px-0.5 py-1 transition-colors hover:bg-bg-dark active:cursor-grabbing"
              title={t(item.menuLabelKey)}
              aria-label={t(item.menuLabelKey)}
              onClick={() => onSelect(item.type)}
              onDragStart={(event) => {
                event.dataTransfer.setData(CANVAS_NODE_DRAG_DATA_TYPE, item.type);
                event.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-dark">
                <Icon className="h-4 w-4 text-accent" />
              </span>
              <span className="w-full break-words text-center text-[10px] leading-3 text-text-dark">
                {t(item.menuLabelKey)}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export function NodePaletteToggle({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="absolute left-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-lg border border-border-dark bg-surface-dark text-text-muted shadow-lg transition-colors hover:bg-bg-dark hover:text-text-dark"
      title={t('canvas.nodePalette.show', '显示节点栏')}
      aria-label={t('canvas.nodePalette.show', '显示节点栏')}
      onClick={onClick}
    >
      <PanelLeftOpen className="h-4 w-4" />
    </button>
  );
}
