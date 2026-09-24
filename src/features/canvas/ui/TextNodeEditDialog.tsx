import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Mic, Replace, Search, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { chatCompletion } from '@/commands/ai';
import { UiButton, UiCheckbox, UiInput, UiModal, UiSelect, UiTextArea } from '@/components/ui';
import { replaceAllText, replaceTextAt, resolveTextMatchIndexes } from '../application/textNodeEditing';
import { isTextAnnotationNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type TextNodeEditDialogMode = 'ai' | 'find';

interface TextNodeEditDialogProps {
  mode: TextNodeEditDialogMode | null;
  node: CanvasNode;
  onClose: () => void;
}

interface AiEditResult {
  text: string;
  assessment: string;
  issues: string[];
  changes: string[];
}

interface ChatModelOption {
  key: string;
  providerId: string;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface SpeechRecognitionEventLike extends Event {
  results: { length: number; [index: number]: { [index: number]: { transcript: string } } };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

const AI_EDIT_SYSTEM_PROMPT = `你是影视编剧和分镜连续性审校助手。你需要根据用户的自然语言要求修改一段文本，并对修改后的整段文本做逻辑审校。

审校必须检查：
1. 事件顺序、因果关系、时间线和人物身份是否前后一致。
2. 人物所在空间、相互位置、视线和朝向是否与动作及身体部位一致。例如医生与病人面对面时，病人说膝盖痛通常面向医生；如果说腰椎痛，需要明确病人转身背对医生或医生从背后检查，不能让文字同时表达两种冲突的朝向。
3. 场景转换、道具状态、动作主体和指代对象是否清楚。
4. 修改要求没有覆盖的事实、语气、Markdown 结构尽量保持不变。
发现逻辑、动作或朝向冲突时，必须优先在 text 中主动修复，让整段自洽；issues 只记录已修复的关键冲突或确实无法确认的事项，不能只指出问题而不修正文案。

只返回 JSON，不要使用 Markdown 代码围栏，格式必须是：
{"text":"修改后的完整文本","assessment":"通顺或存在问题","issues":["问题1"],"changes":["修改点1"]}
如果没有问题，issues 返回空数组。text 必须是完整文本，不能只返回改动片段。`;

function stripJsonFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseAiEditResult(raw: string): AiEditResult {
  const cleaned = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as Partial<AiEditResult>;
    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      return {
        text: parsed.text,
        assessment: typeof parsed.assessment === 'string' ? parsed.assessment : '',
        issues: Array.isArray(parsed.issues) ? parsed.issues.filter((item): item is string => typeof item === 'string') : [],
        changes: Array.isArray(parsed.changes) ? parsed.changes.filter((item): item is string => typeof item === 'string') : [],
      };
    }
  } catch {
    // Some compatible endpoints ignore the JSON instruction. Keep their plain-text result usable.
  }
  return { text: cleaned, assessment: '', issues: [], changes: [] };
}

function buildAiUserPrompt(text: string, instruction: string, preserveMarkdown: boolean): string {
  return [
    '请修改下面的文本。',
    `用户修改要求：${instruction.trim()}`,
    preserveMarkdown ? '请保留原有 Markdown 标记和段落结构。' : '可以根据语义调整段落结构，但不要添加无关内容。',
    '',
    '原文：',
    text,
  ].join('\n');
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
  const { t, i18n } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const customApis = useSettingsStore((state) => state.customApis);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const cinematicAiSelection = useSettingsStore((state) => state.cinematicAiSelection);
  const textNodeAiSelection = useSettingsStore((state) => state.textNodeAiSelection);
  const setTextNodeAiSelection = useSettingsStore((state) => state.setTextNodeAiSelection);
  const [instruction, setInstruction] = useState('');
  const [preserveMarkdown, setPreserveMarkdown] = useState(true);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [aiResult, setAiResult] = useState<AiEditResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
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
      setAiResult(null);
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

  useEffect(() => () => speechRecognitionRef.current?.stop(), []);

  const toggleVoiceInput = () => {
    if (isListening) {
      speechRecognitionRef.current?.stop();
      setIsListening(false);
      return;
    }
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setError(t('textNodeEdit.voiceUnsupported'));
      return;
    }
    const recognition = new Recognition();
    recognition.lang = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[event.results.length - 1]?.[0]?.transcript?.trim();
      if (transcript) setInstruction((current) => `${current.trim()}${current.trim() ? ' ' : ''}${transcript}`);
    };
    recognition.onerror = () => {
      setIsListening(false);
      setError(t('textNodeEdit.voiceFailed'));
    };
    recognition.onend = () => setIsListening(false);
    speechRecognitionRef.current = recognition;
    setError(null);
    setIsListening(true);
    recognition.start();
  };

  const handleGenerate = async () => {
    if (!instruction.trim() || !selectedModel) return;
    setIsGenerating(true);
    setError(null);
    setTextNodeAiSelection({ provider: selectedModel.providerId, model: selectedModel.model });
    try {
      const raw = await chatCompletion(selectedModel.baseUrl, selectedModel.apiKey, selectedModel.model, [
        { role: 'system', content: AI_EDIT_SYSTEM_PROMPT },
        { role: 'user', content: buildAiUserPrompt(text, instruction, preserveMarkdown) },
      ]);
      const result = parseAiEditResult(raw);
      if (!result.text.trim()) throw new Error(t('textNodeEdit.aiEmptyResult'));
      setAiResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsGenerating(false);
    }
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
            {aiResult ? <UiButton variant="primary" size="sm" onClick={() => { updateNodeData(node.id, { content: aiResult.text }); onClose(); }}>{t('textNodeEdit.applyResult')}</UiButton> : null}
          </>
        ) : (
          <UiButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</UiButton>
        )
      }
    >
      {mode === 'ai' ? (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[1fr_230px]">
            <label className="space-y-1.5"><span className="block text-xs text-text-muted">{t('textNodeEdit.instruction')}</span><div className="relative"><UiTextArea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t('textNodeEdit.instructionPlaceholder')} className="h-24 pr-11" /><button type="button" aria-label={isListening ? t('textNodeEdit.stopVoice') : t('textNodeEdit.startVoice')} title={isListening ? t('textNodeEdit.stopVoice') : t('textNodeEdit.startVoice')} onClick={toggleVoiceInput} className={`absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${isListening ? 'border-red-400/60 bg-red-400/20 text-red-200' : 'border-white/15 text-text-muted hover:bg-bg-dark hover:text-text-dark'}`}><Mic className="h-3.5 w-3.5" /></button></div></label>
            <label className="space-y-1.5"><span className="block text-xs text-text-muted">{t('textNodeEdit.model')}</span><UiSelect value={selectedModelKey} onChange={(event) => { const nextKey = event.target.value; setSelectedModelKey(nextKey); const nextModel = chatModels.find((option) => option.key === nextKey); if (nextModel) setTextNodeAiSelection({ provider: nextModel.providerId, model: nextModel.model }); }} disabled={chatModels.length === 0} aria-label={t('textNodeEdit.model')}>
              {chatModels.length === 0 ? <option value="">{t('textNodeEdit.noModel')}</option> : chatModels.map((option) => <option key={option.key} value={option.key}>{option.providerName} / {option.model}</option>)}
            </UiSelect></label>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-bg-dark/35 px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-text-muted"><UiCheckbox checked={preserveMarkdown} onCheckedChange={setPreserveMarkdown} />{t('textNodeEdit.preserveMarkdown')}</label>
            <UiButton variant="primary" size="sm" disabled={isGenerating || !instruction.trim() || !selectedModel} onClick={() => void handleGenerate()}><Sparkles className="h-3.5 w-3.5" />{isGenerating ? t('textNodeEdit.generating') : t('textNodeEdit.run')}</UiButton>
          </div>
          {error ? <div className="flex gap-2 rounded-lg border border-red-400/30 bg-red-400/10 p-2.5 text-xs text-red-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div> : null}
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
