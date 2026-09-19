import { useState } from 'react';
import { createPortal } from 'react-dom';

import { MoveDiagonal, LayoutTemplate, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { UiGhostIconButton } from '@/components/ui/primitives';
import { TEMPLATE_DRAG_DATA_TYPE, templateDragPayload } from '@/features/templates/templateDrag';
import { useTemplateLibrary } from '@/features/templates/useTemplateLibrary';
import { templateCoverSource, templateIsBroken, type Template } from '@/features/templates/types';

/** 侧边栏宽度：必须容下 3 列卡片（minmax(0,1fr) × 3 + gap + 左右 padding）。 */
const TEMPLATE_PANEL_WIDTH = 440;

interface TemplateSidebarProps {
  open: boolean;
  onClose: () => void;
}

function TemplateCard({ template }: { template: Template }) {
  const { t } = useTranslation();
  const [aspectRatio, setAspectRatio] = useState('16 / 9');
  const broken = templateIsBroken(template);
  const cover = templateCoverSource(template);

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TEMPLATE_DRAG_DATA_TYPE, templateDragPayload(template.id));
        event.dataTransfer.effectAllowed = 'copy';
      }}
      title={template.description?.trim() || template.name}
      data-template-card={template.id}
      className="group flex min-w-0 cursor-grab flex-col overflow-hidden rounded-lg border border-border-dark bg-bg-dark transition-colors hover:border-accent/60 active:cursor-grabbing"
    >
      <div className="relative w-full bg-black" style={{ aspectRatio }}>
        {cover ? (
          <video
            muted
            preload="metadata"
            src={resolveImageDisplayUrl(cover)}
            className="h-full w-full object-contain"
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) setAspectRatio(`${videoWidth} / ${videoHeight}`);
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <LayoutTemplate className="h-5 w-5 text-text-muted" />
          </div>
        )}
        {broken ? (          <span className="absolute left-1 top-1 rounded bg-red-500/85 px-1 py-0.5 text-[10px] leading-none text-white">
            {t('templatePage.broken', '损坏')}
          </span>
        ) : null}
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <MoveDiagonal className="h-3 w-3 text-white" />
        </span>
      </div>
      <div className="min-w-0 px-1.5 py-1">
        <p className="truncate text-[11px] font-medium text-text-dark" title={template.name}>
          {template.name}
        </p>
        <p className="truncate text-[10px] text-text-muted" title={template.pipeline.modelId}>
          {template.pipeline.modelId || t('templatePage.title', '模板')}
        </p>
      </div>
    </div>
  );
}

/**
 * 画布内模板侧边栏：与「素材库」同款右侧抽屉，一行 3 个卡片，卡片可拖入画布。
 *
 * 用 portal 挂到 body：侧边栏是 `fixed` 定位，若留在画布 DOM 内会受祖先
 * `transform`（React Flow 的缩放容器）影响而错位。
 */
export function TemplateSidebar({ open, onClose }: TemplateSidebarProps) {
  const { t } = useTranslation();
  const { templates, loading } = useTemplateLibrary(open);

  if (!open) return null;

  return createPortal(
    <aside
      className="fixed right-0 top-10 z-[140] flex h-[calc(100%-2.5rem)] flex-col border-l border-border-dark bg-surface-dark shadow-2xl"
      style={{ width: TEMPLATE_PANEL_WIDTH }}
      data-template-sidebar
    >
      <header className="flex items-center justify-between border-b border-border-dark px-4 py-3">
        <div className="flex items-center gap-2">
          <LayoutTemplate className="h-4 w-4 text-text-muted" />
          <h2 className="text-sm font-medium text-text-dark">{t('templatePage.title', '模板')}</h2>
        </div>
        <UiGhostIconButton onClick={onClose} title={t('common.close', '关闭')}>
          <X className="h-4 w-4" />
        </UiGhostIconButton>
      </header>

      <p className="border-b border-border-dark px-4 py-2 text-[11px] text-text-muted">
        {t('templateSidebar.dragHint', '按住卡片拖入画布，松开即可放置整套节点与连线')}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading && templates.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('templatePage.loading', '加载中…')}
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <LayoutTemplate className="h-8 w-8 text-text-muted" />
            <p className="text-xs text-text-muted">{t('templatePage.empty', '还没有模板')}</p>
            <p className="text-[11px] text-text-muted">{t('templatePage.emptyHint', '在项目里把一套流程存为模板后，会出现在这里')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} />
            ))}
          </div>
        )}
      </div>
    </aside>,
    document.body,
  );
}
