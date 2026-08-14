import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard,
  MousePointer2,
  Scan,
  MousePointerClick,
  Move,
  ImagePlus,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import {
  SHORTCUT_IDS,
  bindingFromEvent,
  shortcutLabel,
  useKeyboardShortcutStore,
  type ShortcutId,
} from '@/stores/keyboardShortcutStore';
import { UiButton, UiModal } from '@/components/ui/primitives';

interface ShortcutSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 画布快捷键设置:展示所有功能的快捷键,点击可重新录制,支持单个/全部恢复默认 */
export function ShortcutSettingsDialog({ open, onClose }: ShortcutSettingsDialogProps) {
  const { t } = useTranslation();
  const bindings = useKeyboardShortcutStore((state) => state.bindings);
  const setBinding = useKeyboardShortcutStore((state) => state.setBinding);
  const resetOne = useKeyboardShortcutStore((state) => state.resetOne);
  const resetAll = useKeyboardShortcutStore((state) => state.resetAll);

  const isMac =
    typeof navigator !== 'undefined'
      && /(Mac|iPhone|iPad|iPod)/i.test(`${navigator.platform} ${navigator.userAgent}`);
  /** 录制状态:正在录制中的快捷键 id */
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  /** 冲突提示:新录制快捷键与哪个功能冲突 */
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const shortcutNames = useMemo<Record<ShortcutId, string>>(() => ({
    undo: t('canvas.shortcuts.undo', '撤销'),
    redo: t('canvas.shortcuts.redo', '重做'),
    group: t('canvas.shortcuts.group', '分组'),
    copy: t('canvas.shortcuts.copy', '复制'),
    paste: t('canvas.shortcuts.paste', '粘贴'),
    delete: t('canvas.shortcuts.delete', '删除'),
  }), [t]);

  // 关闭或切换录制时清理冲突提示
  useEffect(() => {
    if (!open) {
      setRecordingId(null);
      setConflictMessage(null);
    }
  }, [open]);

  // 录制监听
  useEffect(() => {
    if (!open || !recordingId) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // Esc 取消录制
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setRecordingId(null);
        setConflictMessage(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // 冲突检测:新绑定与其他功能相同
      const conflictedId = SHORTCUT_IDS.find(
        (id) => id !== recordingId && shortcutLabel(bindings[id], isMac) === shortcutLabel(binding, isMac)
      );
      if (conflictedId) {
        setConflictMessage(
          t('canvas.shortcuts.conflict', '该快捷键已被「{{name}}」使用', {
            name: shortcutNames[conflictedId],
          })
        );
      } else {
        setConflictMessage(null);
      }
      setBinding(recordingId, binding);
      setRecordingId(null);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [bindings, isMac, open, recordingId, setBinding, shortcutNames, t]);

  const handleStartRecord = (id: ShortcutId) => {
    setRecordingId((current) => (current === id ? null : id));
    setConflictMessage(null);
  };

  return (
    <UiModal
      isOpen={open}
      onClose={onClose}
      title={t('canvas.shortcuts.title', '快捷键设置')}
      widthClassName="w-[min(480px,calc(100vw-40px))]"
      footer={(
        <>
          <UiButton variant="muted" size="sm" onClick={resetAll} disabled={recordingId !== null}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('canvas.shortcuts.resetAll', '恢复默认')}
          </UiButton>
          <UiButton variant="primary" size="sm" onClick={onClose}>
            {t('common.close', '关闭')}
          </UiButton>
        </>
      )}
    >
      <p className="mb-3 text-[11px] leading-4 text-text-muted">
        {t('canvas.shortcuts.hint', '点击任意快捷键即可重新录制;按 Esc 取消录制。')}
      </p>
      {conflictMessage && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {conflictMessage}
        </div>
      )}
      <div className="ui-scrollbar max-h-[340px] space-y-1 overflow-y-auto">
        {SHORTCUT_IDS.map((id) => {
          const binding = bindings[id];
          const isRecording = recordingId === id;
          return (
            <div
              key={id}
              role="button"
              tabIndex={0}
              onClick={() => handleStartRecord(id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleStartRecord(id);
                }
              }}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 transition-colors ${
                isRecording
                  ? 'border-accent/60 bg-accent/15'
                  : 'border-border-dark bg-surface-dark hover:border-accent/40'
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Keyboard className={`h-3.5 w-3.5 shrink-0 ${isRecording ? 'text-accent' : 'text-text-muted/60'}`} />
                <span className="truncate text-xs text-text-dark">{shortcutNames[id]}</span>
              </span>
              {isRecording ? (
                <span className="shrink-0 text-xs text-accent">
                  {t('canvas.shortcuts.recording', '按下新的快捷键…')}
                </span>
              ) : (
                <span className="flex shrink-0 items-center gap-1.5">
                  <kbd className="rounded border border-border-dark bg-bg-dark px-1.5 py-0.5 font-mono text-[11px] text-text-dark">
                    {shortcutLabel(binding, isMac)}
                  </kbd>
                  <button
                    type="button"
                    className="rounded p-1 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                    title={t('canvas.shortcuts.resetOne', '恢复默认')}
                    onClick={(event) => {
                      event.stopPropagation();
                      resetOne(id);
                    }}
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* 操作提示 */}
      <div className="mt-4">
        <div className="mb-2 flex items-center gap-1.5">
          <MousePointerClick className="h-3.5 w-3.5 text-text-muted" />
          <span className="text-[11px] font-medium text-text-muted">
            {t('canvas.shortcuts.tipsTitle', '操作提示')}
          </span>
        </div>
        <div className="space-y-1.5">
          {[
            { icon: Scan, text: t('canvas.shortcuts.tipSelect', '框选多个节点: 在画布空白处按住鼠标左键拖拽') },
            { icon: MousePointer2, text: t('canvas.shortcuts.tipMultiSelect', '逐个多选: 按住 ⌘(Mac) / Ctrl(Win) 依次点击节点') },
            { icon: MousePointerClick, text: t('canvas.shortcuts.tipAddNode', '添加节点: 在画布空白处双击, 从菜单选择节点类型') },
            { icon: Move, text: t('canvas.shortcuts.tipPan', '平移画布: 按住空格键拖拽空白处(滚动滚轮缩放)') },
            { icon: ImagePlus, text: t('canvas.shortcuts.tipAssetDrop', '素材入画: 从素材库拖拽图片/视频/音频到画布') },
            { icon: Sparkles, text: t('canvas.shortcuts.tipPromptDrop', '提示词入画: 从提示词库拖拽提示词卡片到画布, 自动创建 AI 图片节点') },
          ].map(({ icon: TipIcon, text }) => (
            <div key={text} className="flex items-start gap-2 rounded-md border border-border-dark/60 bg-surface-dark px-2.5 py-1.5">
              <TipIcon className="mt-px h-3.5 w-3.5 shrink-0 text-text-muted/60" />
              <span className="min-w-0 text-[11px] leading-4 text-text-muted">{text}</span>
            </div>
          ))}
        </div>
      </div>
    </UiModal>
  );
}
