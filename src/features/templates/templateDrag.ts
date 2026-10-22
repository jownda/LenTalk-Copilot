/**
 * 模板卡片拖入画布的拖拽载荷。
 *
 * 与素材库（`features/library/importAssets.ts`）的 ASSET/PROMPT 拖拽同构：
 * 用独立的自定义 MIME 承载 `{ id }`，画布侧凭此类型识别并落图。
 */
export const TEMPLATE_DRAG_DATA_TYPE = 'application/x-storyboard-template';

export function templateDragPayload(templateId: string): string {
  return JSON.stringify({ id: templateId });
}

export function parseTemplateDragPayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    if (typeof parsed?.id !== 'string') return null;
    const id = parsed.id.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
