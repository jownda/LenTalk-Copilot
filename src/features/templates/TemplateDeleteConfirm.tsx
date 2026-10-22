import { useTranslation } from 'react-i18next';

import { UiButton, UiModal } from '@/components/ui/primitives';
import { OverlayLayerProvider, useOverlayLayerFloor } from '@/components/ui/overlayLayer';

interface TemplateDeleteConfirmDialogProps {
  /** 是否展示。 */
  open: boolean;
  /** 待删除模板名，仅用于文案。 */
  templateName: string;
  /** 删除是否进行中（按钮禁用，防重复点击）。 */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 模板删除的轻量确认卡片。
 *
 * 刻意做成独立的小弹窗，而不是复用模板详情弹窗：
 * 详情弹窗会把整份提示词铺开（左栏是提示词编辑器），只想删一个模板时完全没必要看这些。
 * 也没有用 `window.confirm` —— 那个对话框在桌面端（Tauri / WKWebView）的形态随平台而异，
 * 不跟随应用主题，也无法在删除过程中禁用按钮。
 *
 * 层级：宿主若处在高层级容器内（例如画布里的模板详情弹窗 z = 240），
 * 这里会自动再抬 10 层，避免被宿主盖住；没有 Provider 时保持 UiModal 的默认层级。
 */
export function TemplateDeleteConfirmDialog({
  open,
  templateName,
  busy = false,
  onCancel,
  onConfirm,
}: TemplateDeleteConfirmDialogProps) {
  const { t } = useTranslation();
  const hostFloor = useOverlayLayerFloor();

  const dialog = (
    <UiModal
      isOpen={open}
      title={t('templatePage.delete', '删除模板')}
      onClose={onCancel}
      widthClassName="w-[min(380px,calc(100vw-3rem))]"
      footer={
        <>
          <UiButton type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel', '取消')}
          </UiButton>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-500/85 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onConfirm}
            disabled={busy}
          >
            {t('common.delete', '删除')}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-text-dark">
        {t('templatePage.deleteConfirmBody', '确定删除“{{name}}”？删除后无法恢复。', { name: templateName })}
      </p>
    </UiModal>
  );

  return hostFloor > 0 ? <OverlayLayerProvider value={hostFloor + 10}>{dialog}</OverlayLayerProvider> : dialog;
}
