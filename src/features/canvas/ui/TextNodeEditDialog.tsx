import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Pencil, Plus, Replace, Search, Sparkles, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiButton, UiCheckbox, UiInput, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import { replaceAllText, replaceTextAt, resolveTextMatchIndexes } from '../application/textNodeEditing';
import {
  appendQuickPhrase,
  loadQuickPhrases,
  saveQuickPhrases,
} from '../application/quickPhrases';
import { isTextAnnotationNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTextAiEditStore } from '@/stores/textAiEditStore';
import type { AiEditResult } from '../application/textAiEdit';

type TextNodeEditDialogMode = 'ai' | 'find';

interface TextNodeEditDialogProps {
  mode: TextNodeEditDialogMode | null;
  node: CanvasNode;
  onClose: () => void;
}


/** 快捷句式浮层：宽度、兜底高度、与按钮的间距、离视口的最小边距。 */
const QUICK_PANEL_WIDTH = 288;
const QUICK_PANEL_FALLBACK_HEIGHT = 300;
const QUICK_PANEL_GAP = 8;
const QUICK_PANEL_MARGIN = 8;

interface ChatModelOption {
  key: string;
  providerId: string;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

function renderHighlightedText(text: string, query: string, caseSensitive: boolean, activeIndex: number): ReactNode {
  const indexes = resolveTextMatchIndexes(text, query, caseSensitive);
  if (indexes.length === 0) return <span>{text || ' '}</span>;
  const queryLength = query.trim().length;
  const parts: ReactNode[] = [];
  let cursor = 0;
  indexes.forEach((index, matchIndex) => {
    if (index > cursor) parts.push(<span key={`text-${index}`}>{text.slice(cursor, index)}</span>);
    parts.push(
      <mark
        key={`match-${index}`}
        data-active={matchIndex === activeIndex ? 'true' : 'false'}
        className={`rounded px-0.5 ${matchIndex === activeIndex ? 'bg-amber-400 text-black' : 'bg-accent/35 text-text-dark'}`}
      >
        {text.slice(index, index + queryLength)}
      </mark>,
    );
    cursor = index + queryLength;
  });
  if (cursor < text.length) parts.push(<span key="text-tail">{text.slice(cursor)}</span>);
  return parts;
}

export function TextNodeEditDialog({ mode, node, onClose }: TextNodeEditDialogProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const customApis = useSettingsStore((state) => state.customApis);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const cinematicAiSelection = useSettingsStore((state) => state.cinematicAiSelection);
  const textNodeAiSelection = useSettingsStore((state) => state.textNodeAiSelection);
  const setTextNodeAiSelection = useSettingsStore((state) => state.setTextNodeAiSelection);
  const [instruction, setInstruction] = useState('');
  // 快捷句式：本地持久化的一批「常用修改要求」，点一下直接追加到输入框。
  const [quickPhrases, setQuickPhrases] = useState<string[]>(() => loadQuickPhrases());
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [quickEditing, setQuickEditing] = useState(false);
  const quickPanelRef = useRef<HTMLDivElement | null>(null);
  const quickButtonRef = useRef<HTMLButtonElement | null>(null);
  // 面板 portal 到 body 上，坐标得自己算（见 updateQuickPanelPosition）。
  const [quickPanelPosition, setQuickPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const [preserveMarkdown, setPreserveMarkdown] = useState(true);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  // 任务状态放在 store 里, 弹窗只是它的视图 —— 关窗后请求继续跑, 重开能接着看。
  const aiTask = useTextAiEditStore((state) =>
    state.task && state.task.nodeId === node.id ? state.task : null,
  );
  const startTextAiEdit = useTextAiEditStore((state) => state.start);
  const applyTextAiEdit = useTextAiEditStore((state) => state.apply);
  const aiResult: AiEditResult | null = aiTask?.result ?? null;
  const isGenerating = aiTask?.status === 'running';
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const initializedNodeIdRef = useRef<string | null>(null);

  const text = isTextAnnotationNode(node) ? node.data.content : '';
  const chatModels = useMemo<ChatModelOption[]>(
    () => customApis.flatMap((api) => (api.chatModels ?? []).map((model) => ({
      key: `${api.id}:${model}`,
      providerId: api.id,
      providerName: api.name,
      model,
      baseUrl: api.baseUrl,
      apiKey: (apiKeys[`custom:${api.id}`] ?? api.apiKey ?? '').trim(),
    }))),
    [apiKeys, customApis],
  );
  const selectedModel = chatModels.find((option) => option.key === selectedModelKey) ?? chatModels[0] ?? null;
  const matchIndexes = useMemo(() => resolveTextMatchIndexes(text, query, caseSensitive), [caseSensitive, query, text]);

  useEffect(() => {
    const isNewNode = initializedNodeIdRef.current !== node.id;
    if (!isNewNode && selectedModelKey) return;
    if (isNewNode) {
      initializedNodeIdRef.current = node.id;
      setError(null);
      setInstruction('');
      setQuery('');
      setReplacement('');
      setReplaceNotice(null);
      setActiveMatchIndex(0);
    }
    const rememberedKey = `${textNodeAiSelection.provider}:${textNodeAiSelection.model}`;
    const globalKey = `${cinematicAiSelection.provider}:${cinematicAiSelection.model}`;
    const preferredKey = chatModels.some((option) => option.key === rememberedKey)
      ? rememberedKey
      : chatModels.some((option) => option.key === globalKey)
        ? globalKey
        : chatModels[0]?.key ?? '';
    setSelectedModelKey(preferredKey);
  }, [
    chatModels,
    cinematicAiSelection.model,
    cinematicAiSelection.provider,
    node.id,
    selectedModelKey,
    textNodeAiSelection.model,
    textNodeAiSelection.provider,
  ]);

  useEffect(() => {
    if (matchIndexes.length === 0) setActiveMatchIndex(0);
    else setActiveMatchIndex((current) => Math.min(current, matchIndexes.length - 1));
  }, [matchIndexes.length]);

  useEffect(() => {
    if (!previewRef.current || mode !== 'find') return;
    previewRef.current.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeMatchIndex, mode, query]);

  /** 点一条句式 → 追加到输入框末尾，并收起面板（选完即走，不挡视线）。 */
  const applyQuickPhrase = (phrase: string) => {
    setInstruction((current) => appendQuickPhrase(current, phrase));
    closeQuickPanel();
  };

  /** 编辑态只改内存；离开编辑态（或收起面板）时统一落盘，避免每敲一个字就写一次。 */
  const commitQuickPhrases = () => {
    setQuickPhrases((current) => saveQuickPhrases(current));
  };

  const closeQuickPanel = () => {
    commitQuickPhrases();
    setQuickPanelOpen(false);
    setQuickEditing(false);
  };

  const toggleQuickEditing = () => {
    if (quickEditing) commitQuickPhrases();
    setQuickEditing((current) => !current);
  };

  const updateQuickPhraseAt = (index: number, value: string) => {
    setQuickPhrases((current) =>
      current.map((item, position) => (position === index ? value : item)),
    );
  };

  const addQuickPhrase = () => {
    setQuickEditing(true);
    setQuickPhrases((current) => [...current, '']);
  };

  const removeQuickPhrase = (index: number) => {
    setQuickPhrases((current) =>
      saveQuickPhrases(current.filter((_, position) => position !== index)),
    );
  };

  /**
   * 面板贴住按钮弹出：右边缘对齐按钮、优先往上翻。
   *
   * 面板是 portal 到 body 的，不能靠父级的 `absolute` —— 弹窗内容区是可滚动的，
   * 绝对定位会被 `overflow` 裁掉一截（表现为「卡片下半截消失」）。所以这里用
   * `position: fixed` + 视口坐标，并做四边夹取，保证永远留在可视区内。
   */
  const updateQuickPanelPosition = useCallback(() => {
    const trigger = quickButtonRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const panel = quickPanelRef.current;
    const width = panel?.offsetWidth || QUICK_PANEL_WIDTH;
    const height = panel?.offsetHeight || QUICK_PANEL_FALLBACK_HEIGHT;
    const margin = QUICK_PANEL_MARGIN;
    const gap = QUICK_PANEL_GAP;

    const left = Math.min(
      Math.max(margin, rect.right - width),
      Math.max(margin, window.innerWidth - width - margin),
    );
    // 上方放得下就往上，否则往下；两种都放不下时贴着视口底边。
    const aboveTop = rect.top - gap - height;
    const belowTop = rect.bottom + gap;
    const top = aboveTop >= margin
      ? aboveTop
      : Math.min(belowTop, Math.max(margin, window.innerHeight - height - margin));

    setQuickPanelPosition({ left, top });
  }, []);

  // 打开时定位一次；之后跟随窗口缩放与滚动（捕获阶段才能收到内层容器的滚动）。
  useEffect(() => {
    if (!quickPanelOpen) return;
    updateQuickPanelPosition();
    window.addEventListener('resize', updateQuickPanelPosition);
    window.addEventListener('scroll', updateQuickPanelPosition, true);
    return () => {
      window.removeEventListener('resize', updateQuickPanelPosition);
      window.removeEventListener('scroll', updateQuickPanelPosition, true);
    };
  }, [quickPanelOpen, quickEditing, quickPhrases.length, updateQuickPanelPosition]);

  /**
   * 点面板外面即收起。
   *
   * 用**捕获阶段**监听：弹窗（UiModal）内部多处会 `stopPropagation`，
   * 冒泡到 document 的 mousedown 会被吞掉，表现为「点旁边没反应」。
   */
  useEffect(() => {
    if (!quickPanelOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (quickPanelRef.current?.contains(target)) return;
      if (quickButtonRef.current?.contains(target)) return;
      closeQuickPanel();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [quickPanelOpen]);

  const handleGenerate = async () => {
    if (!instruction.trim() || !selectedModel) return;
    setError(null);
    setTextNodeAiSelection({ provider: selectedModel.providerId, model: selectedModel.model });
    // 请求交给 store 跑: 这个 await 只等「本地记录写完」, 结果由 aiTask 订阅呈现,
    // 所以中途关掉弹窗也不会中断生成。
    void startTextAiEdit({
      nodeId: node.id,
      text,
      instruction,
      preserveMarkdown,
      baseUrl: selectedModel.baseUrl,
      apiKey: selectedModel.apiKey,
      model: selectedModel.model,
      modelLabel: `${selectedModel.providerName} · ${selectedModel.model}`,
    });
  };

  const replaceAll = () => {
    if (!query.trim()) {
      setReplaceNotice(t('textNodeEdit.enterFind'));
      return;
    }
    if (matchIndexes.length === 0) {
      setReplaceNotice(t('textNodeEdit.noMatches'));
      return;
    }
    updateNodeData(node.id, { content: replaceAllText(text, query, replacement, caseSensitive) });
    setActiveMatchIndex(0);
    setReplaceNotice(t('textNodeEdit.replacedAll', { count: matchIndexes.length }));
  };

  const replaceCurrent = () => {
    if (!query.trim()) {
      setReplaceNotice(t('textNodeEdit.enterFind'));
      return;
    }
    if (matchIndexes.length === 0) {
      setReplaceNotice(t('textNodeEdit.noMatches'));
      return;
    }
    const nextText = replaceTextAt(text, query, replacement, matchIndexes[activeMatchIndex] ?? matchIndexes[0]);
    updateNodeData(node.id, { content: nextText });
    setActiveMatchIndex(Math.min(activeMatchIndex, Math.max(0, resolveTextMatchIndexes(nextText, query, caseSensitive).length - 1)));
    setReplaceNotice(t('textNodeEdit.replacedOne'));
  };

  const title = mode === 'ai' ? t('textNodeEdit.aiTitle') : t('textNodeEdit.findTitle');
  return (
    <UiModal
      isOpen={Boolean(mode)}
      title={title}
      onClose={onClose}
      widthClassName={mode === 'ai' ? 'w-[min(760px,calc(100vw-32px))]' : 'w-[min(680px,calc(100vw-32px))]'}
      footer={
        mode === 'ai' ? (
          <>
            <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</UiButton>
            {aiResult ? <UiButton variant="primary" size="sm" onClick={() => { applyTextAiEdit(node.id); onClose(); }}>{t('textNodeEdit.applyResult')}</UiButton> : null}
          </>
        ) : (
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</UiButton>
        )
      }
    >
      {mode === 'ai' ? (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_230px]">
            <label className="space-y-1.5">
              <span className="block text-xs text-text-muted">{t('textNodeEdit.instruction')}</span>
              <div className="relative">
                <UiTextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t('textNodeEdit.instructionPlaceholder')} className="h-24 pr-11" />
                {/* 快捷句式：常用修改要求一键追加，句式由用户自己维护 */}
                <button ref={quickButtonRef} type="button" aria-label={t('textNodeEdit.quickPhrases')} title={t('textNodeEdit.quickPhrases')} onClick={() => (quickPanelOpen ? closeQuickPanel() : setQuickPanelOpen(true))} className={`absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${quickPanelOpen ? 'border-accent/60 bg-accent/20 text-accent' : 'border-white/15 text-text-muted hover:bg-bg-dark hover:text-text-dark'}`}>
                  <Zap className="h-3.5 w-3.5" />
                </button>
                {quickPanelOpen && typeof document !== 'undefined' && createPortal(
                  <div
                    ref={quickPanelRef}
                    style={{
                      left: quickPanelPosition?.left ?? 0,
                      top: quickPanelPosition?.top ?? 0,
                      // 首次渲染还没量到尺寸，先藏起来，避免在错误位置闪一下。
                      visibility: quickPanelPosition ? 'visible' : 'hidden',
                    }}
                    className="fixed z-[1200] w-72 rounded-lg border border-border-dark bg-surface-dark p-2 shadow-2xl">
                    <div className="flex items-center justify-between px-1 pb-1.5">
                      <span className="text-[11px] font-medium text-text-dark">{t('textNodeEdit.quickPhrases')}</span>
                      <button type="button" onClick={toggleQuickEditing} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark">
                        {quickEditing ? <><Check className="h-3 w-3" />{t('textNodeEdit.quickPhrasesDone')}</> : <><Pencil className="h-3 w-3" />{t('textNodeEdit.quickPhrasesEdit')}</>}
                      </button>
                    </div>
                    <div className="ui-scrollbar max-h-56 space-y-1 overflow-y-auto">
                      {quickPhrases.length === 0 && <p className="px-1 py-2 text-[11px] text-text-muted">{t('textNodeEdit.quickPhrasesEmpty')}</p>}
                      {quickPhrases.map((phrase, index) => (quickEditing ? (
                        <div key={`phrase-edit-${index}`} className="flex items-center gap-1">
                          <UiInput value={phrase} onChange={(event) => updateQuickPhraseAt(index, event.target.value)} placeholder={t('textNodeEdit.quickPhrasesPlaceholder')} spellCheck={false} className="h-7 px-2 py-1 text-xs" />
                          <button type="button" onClick={() => removeQuickPhrase(index)} title={t('textNodeEdit.quickPhrasesRemove')} className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-white/15 text-text-muted transition-colors hover:bg-bg-dark hover:text-red-300"><Trash2 className="h-3 w-3" /></button>
                        </div>
                      ) : (
                        <button key={`phrase-${index}`} type="button" onClick={() => applyQuickPhrase(phrase)} title={phrase} className="block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-text-dark transition-colors hover:bg-bg-dark">{phrase}</button>
                      )))}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between border-t border-border-dark pt-1.5">
                      <button type="button" onClick={addQuickPhrase} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"><Plus className="h-3 w-3" />{t('textNodeEdit.quickPhrasesAdd')}</button>
                      {!quickEditing && <span className="text-[10px] text-text-muted">{t('textNodeEdit.quickPhrasesHint')}</span>}
                    </div>
                  </div>,
                  document.body,
                )}
              </div>
            </label>
            <label className="space-y-1.5"><span className="block text-xs text-text-muted">{t('textNodeEdit.model')}</span><UiSelect value={selectedModelKey} onChange={(event) => { const nextKey = event.target.value; setSelectedModelKey(nextKey); const nextModel = chatModels.find((option) => option.key === nextKey); if (nextModel) setTextNodeAiSelection({ provider: nextModel.providerId, model: nextModel.model }); }} disabled={chatModels.length === 0} aria-label={t('textNodeEdit.model')}>
              {chatModels.length === 0 ? <option value="">{t('textNodeEdit.noModel')}</option> : chatModels.map((option) => <option key={option.key} value={option.key}>{option.providerName} / {option.model}</option>)}
            </UiSelect></label>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-bg-dark/35 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-text-muted"><UiCheckbox checked={preserveMarkdown} onCheckedChange={setPreserveMarkdown} />{t('textNodeEdit.preserveMarkdown')}</label>
            <UiButton variant="primary" size="sm" disabled={isGenerating || !instruction.trim() || !selectedModel} onClick={() => void handleGenerate()}><Sparkles className="h-3.5 w-3.5" />{isGenerating ? t('textNodeEdit.generating') : t('textNodeEdit.run')}</UiButton>
          </div>
          {(error || aiTask?.error) ? <div className="flex gap-2 rounded-lg border border-red-400/30 bg-red-400/10 p-2.5 text-xs text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error || aiTask?.error}</div> : null}
          <div className="grid gap-3 md:grid-cols-2">
            <section className="min-w-0"><h3 className="mb-1.5 text-xs font-medium text-text-muted">{t('textNodeEdit.original')}</h3><div className="ui-scrollbar h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-bg-dark/35 p-3 text-xs leading-5 text-text-muted">{text || t('node.textAnnotation.empty')}</div></section>
            <section className="min-w-0"><h3 className="mb-1.5 text-xs font-medium text-text-muted">{t('textNodeEdit.preview')}</h3><div className="ui-scrollbar h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs leading-5 text-text-dark">{aiResult?.text || t('textNodeEdit.previewHint')}</div></section>
          </div>
          {aiResult ? <div className="space-y-2 rounded-lg border border-white/10 p-3 text-xs"><div className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-4 w-4" />{aiResult.assessment || t('textNodeEdit.assessed')}</div>{aiResult.issues.length > 0 ? <div className="text-amber-200">{t('textNodeEdit.issues')}: {aiResult.issues.join('；')}</div> : null}{aiResult.changes.length > 0 ? <div className="text-text-muted">{t('textNodeEdit.changes')}: {aiResult.changes.join('；')}</div> : null}</div> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <label className="space-y-1"><span className="block text-xs text-text-muted">{t('textNodeEdit.find')}</span><UiInput value={query} onChange={(event) => { setQuery(event.target.value); setReplaceNotice(null); }} placeholder={t('textNodeEdit.findPlaceholder')} autoFocus /></label>
            <label className="space-y-1"><span className="block text-xs text-text-muted">{t('textNodeEdit.replaceWith')}</span><UiInput value={replacement} onChange={(event) => { setReplacement(event.target.value); setReplaceNotice(null); }} placeholder={t('textNodeEdit.replacePlaceholder')} /></label>
            <label className="flex items-end gap-2 pb-2 text-xs text-text-muted"><UiCheckbox checked={caseSensitive} onCheckedChange={setCaseSensitive} />{t('textNodeEdit.caseSensitive')}</label>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 pb-3"><span className="mr-auto text-xs text-text-muted">{query.trim() ? t('textNodeEdit.matchCount', { count: matchIndexes.length }) : t('textNodeEdit.enterFind')}</span><UiButton variant="muted" size="sm" disabled={matchIndexes.length === 0} onClick={() => setActiveMatchIndex((activeMatchIndex - 1 + matchIndexes.length) % matchIndexes.length)}><ArrowLeft className="h-3.5 w-3.5" />{t('textNodeEdit.previous')}</UiButton><UiButton variant="muted" size="sm" disabled={matchIndexes.length === 0} onClick={() => setActiveMatchIndex((activeMatchIndex + 1) % matchIndexes.length)}>{t('textNodeEdit.next')}<ArrowRight className="h-3.5 w-3.5" /></UiButton><UiButton variant="muted" size="sm" disabled={!query.trim()} onClick={replaceCurrent}><Replace className="h-3.5 w-3.5" />{t('textNodeEdit.replace')}</UiButton><UiButton variant="primary" size="sm" disabled={!query.trim()} onClick={replaceAll}><Replace className="h-3.5 w-3.5" />{t('textNodeEdit.replaceAll')}</UiButton></div>
          {replaceNotice ? <div className="flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" />{replaceNotice}</div> : null}
          <div ref={previewRef} className="ui-scrollbar max-h-[48vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-bg-dark/35 p-4 text-sm leading-6 text-text-dark">{renderHighlightedText(text, query, caseSensitive, activeMatchIndex)}</div>
          <div className="flex items-center gap-2 text-[11px] text-text-muted"><Search className="h-3.5 w-3.5" />{t('textNodeEdit.findHint')}</div>
        </div>
      )}
    </UiModal>
  );
}
