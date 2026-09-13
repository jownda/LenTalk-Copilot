import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { AudioLines, ChevronDown, LoaderCircle, Music2, Sparkles, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type AudioGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { CURRENT_RUNTIME_SESSION_ID, buildGenerationErrorReport, getRuntimeDiagnostics, type GenerationDebugContext } from '@/features/canvas/application/generationErrorReport';
import { recordGenerationOutcome } from '@/features/canvas/application/usageRecording';
import { useDebouncedNodeTextCommit } from '@/features/canvas/application/useDebouncedNodeTextCommit';
import {
  getAudioModel,
  getDefaultAudioModelId,
  getModelProvider,
  listAudioModels,
} from '@/features/canvas/models';
import { resolveModelPriceDisplay } from '@/features/canvas/pricing';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodePriceBadge } from '@/features/canvas/ui/NodePriceBadge';
import { resolveRecommendedApiPriceBadge } from './nodePriceBadge';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type AudioGenNodeProps = {
  id: string;
  data: AudioGenNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

const AUDIO_GEN_NODE_MIN_WIDTH = 320;
const AUDIO_GEN_NODE_MIN_HEIGHT = 280;
const AUDIO_GEN_NODE_MAX_WIDTH = 720;
const AUDIO_GEN_NODE_MAX_HEIGHT = 620;
const AUDIO_GEN_NODE_DEFAULT_WIDTH = 400;
const AUDIO_GEN_NODE_DEFAULT_HEIGHT = 340;

/** 语音合成格式(文档 `format` 字段, 示例值 mp3)。 */
const SPEECH_FORMAT_OPTIONS = ['mp3', 'wav', 'pcm', 'opus'] as const;
/** 音效时长(文档 metadata.duration_seconds, 示例 8 秒)。 */
const SOUND_EFFECT_DURATION_OPTIONS = [1, 2, 3, 5, 8, 10, 15, 20, 30] as const;
/** 音乐时长(文档 metadata.music_length_ms, 示例 30000)。 */
const MUSIC_LENGTH_OPTIONS_MS = [15000, 30000, 60000, 120000] as const;

const KIND_LABEL_KEY: Record<'speech' | 'sound-effects' | 'music', string> = {
  speech: 'node.audioGen.kindSpeech',
  'sound-effects': 'node.audioGen.kindSoundEffects',
  music: 'node.audioGen.kindMusic',
};

const KIND_ICON = {
  speech: Volume2,
  'sound-effects': AudioLines,
  music: Music2,
} as const;

export const AudioGenNode = memo(({ id, data, selected, width, height }: AudioGenNodeProps) => {
  const { t, i18n } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const customApis = useSettingsStore((state) => state.customApis);
  const showNodePrice = useSettingsStore((state) => state.showNodePrice);
  const priceDisplayCurrencyMode = useSettingsStore((state) => state.priceDisplayCurrencyMode);
  const usdToCnyRate = useSettingsStore((state) => state.usdToCnyRate);
  const preferDiscountedPrice = useSettingsStore((state) => state.preferDiscountedPrice);
  const grsaiCreditTierId = useSettingsStore((state) => state.grsaiCreditTierId);

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerProviderId, setModelPickerProviderId] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  const { flushCommit, scheduleCommit } = useDebouncedNodeTextCommit({
    nodeId: id,
    field: 'prompt',
    valueRef: promptDraftRef,
    updateNodeData,
  });

  // 与视频节点一致: 模型定义直接从平台配置生成, 不额外 memo(配置变化时组件本身会重渲)。
  const models = listAudioModels();
  const selectedModel = getAudioModel(data.model) ?? getAudioModel(getDefaultAudioModelId());
  const audioKind = selectedModel?.audioKind ?? (data.audioKind as 'speech' | 'sound-effects' | 'music') ?? 'speech';
  const KindIcon = KIND_ICON[audioKind] ?? Volume2;
  const title = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.audioGen, data), [data]);
  const resolvedWidth = Math.max(AUDIO_GEN_NODE_MIN_WIDTH, Math.round(width ?? AUDIO_GEN_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(AUDIO_GEN_NODE_MIN_HEIGHT, Math.round(height ?? AUDIO_GEN_NODE_DEFAULT_HEIGHT));

  const voice = (typeof data.voice === 'string' && data.voice.trim()) || 'alloy';
  const format = (typeof data.format === 'string' && data.format.trim()) || 'mp3';
  const durationSeconds = Math.max(1, Math.round(Number(data.durationSeconds) || 5));
  const musicLengthMs = Math.max(1000, Math.round(Number(data.musicLengthMs) || 30000));
  const lyrics = typeof data.lyrics === 'string' ? data.lyrics : '';

  const modelProviders = useMemo(
    () => Array.from(new Set(models.map((model) => model.providerId))).map(getModelProvider),
    [models],
  );
  const pickerProviderModels = useMemo(
    () => models.filter((model) => model.providerId === modelPickerProviderId),
    [modelPickerProviderId, models],
  );
  const selectedModelName = useMemo(() => {
    if (!selectedModel) return '';
    const providerName = getModelProvider(selectedModel.providerId).label;
    const prefix = `${providerName} · `;
    return selectedModel.displayName.startsWith(prefix)
      ? selectedModel.displayName.slice(prefix.length)
      : selectedModel.displayName;
  }, [selectedModel]);

  const price = useMemo(
    () => selectedModel && showNodePrice
      ? resolveModelPriceDisplay(selectedModel, {
        resolution: '',
        extraParams: {
          duration: audioKind === 'sound-effects' ? durationSeconds : 0,
          musicLengthMs: audioKind === 'music' ? musicLengthMs : undefined,
        },
        language: i18n.language,
        settings: {
          displayCurrencyMode: priceDisplayCurrencyMode,
          usdToCnyRate,
          preferDiscountedPrice,
          grsaiCreditTierId,
        },
      })
      : null,
    [
      audioKind,
      durationSeconds,
      grsaiCreditTierId,
      i18n.language,
      musicLengthMs,
      preferDiscountedPrice,
      priceDisplayCurrencyMode,
      selectedModel,
      showNodePrice,
      usdToCnyRate,
    ],
  );


  // 推荐平台（如知鸟 AI / 炳火）的模型未注册精确 pricing,
  // 用 recommendedApis.pricingRange.audio 区间作为右上角徽章的兜底。
  const recommendedPriceBadge = useMemo(
    () => price
      ? null
      : resolveRecommendedApiPriceBadge(selectedModel?.providerId, customApis, 'audio'),
    [customApis, price, selectedModel?.providerId],
  );
  const nodePrice = price ?? recommendedPriceBadge;
  useEffect(() => {
    if (selectedModel?.providerId) {
      setModelPickerProviderId(selectedModel.providerId);
    }
  }, [selectedModel?.providerId]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }
      setShowModelPicker(false);
    };
    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  /** 换模型时同步 audioKind 与该类型的默认音色/格式, 避免沿用上一条链路的参数。 */
  const selectModel = useCallback((modelId: string) => {
    const next = getAudioModel(modelId);
    updateNodeData(id, {
      model: modelId,
      ...(next ? { audioKind: next.audioKind } : {}),
      ...(next?.defaultVoice ? { voice: next.defaultVoice } : {}),
      ...(next?.defaultFormat ? { format: next.defaultFormat } : {}),
      ...(next?.defaultMusicLengthMs ? { musicLengthMs: next.defaultMusicLengthMs } : {}),
    });
    setShowModelPicker(false);
  }, [id, updateNodeData]);

  const handleGenerate = useCallback(async () => {
    if (!selectedModel) {
      const message = t('node.audioGen.needModel');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    flushCommit();
    const prompt = promptDraftRef.current.trim();
    if (!prompt) {
      const message = t('node.audioGen.needPrompt');
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    // 音频模型全部来自自定义平台(custom:*), 没有 CLI 分支, 所以直接检查密钥。
    const apiKey = apiKeys[selectedModel.providerId] ?? '';
    if (!apiKey) {
      const message = '请在设置中填写 API Key';
      setError(message);
      void showErrorDialog(message, t('common.error'));
      return;
    }
    const customId = selectedModel.providerId.slice('custom:'.length);
    const baseUrl = customApis.find((api) => api.id === customId)?.baseUrl;

    const generationStartedAt = Date.now();
    // 与 AI 视频节点一致: 点击即创建下游「媒体节点」承接结果, 生成中显示转圈,
    // 失败把错误写到该节点上, 成功后填入音频文件路径。
    const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 340, 220), {
      displayName: prompt,
      mediaType: 'audio',
      aspectRatio: DEFAULT_ASPECT_RATIO,
      isGenerating: true,
      generationStartedAt,
      generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      generationDurationMs: selectedModel.expectedDurationMs ?? 45000,
      generationProviderId: selectedModel.providerId,
      generationModel: selectedModel.id,
      providerBaseUrl: baseUrl,
      generationRequest: {
        kind: 'audio',
        clientJobId: id,
        prompt,
        model: selectedModel.id,
        audioKind,
        ...(audioKind === 'speech' ? { voice, format } : {}),
        ...(audioKind === 'sound-effects' ? { durationSeconds } : {}),
        ...(audioKind === 'music' ? { musicLengthMs, ...(lyrics.trim() ? { lyrics: lyrics.trim() } : {}) } : {}),
      },
    });
    updateNodeSize(outputId, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT);
    addEdge(id, outputId);
    setIsGenerating(true);
    setError(null);
    try {
      await canvasAiGateway.setApiKey(selectedModel.providerId, apiKey);
      const audioUrl = await canvasAiGateway.generateAudio({
        prompt,
        model: selectedModel.id,
        audioKind,
        voice: audioKind === 'speech' ? voice : undefined,
        format: audioKind === 'speech' ? format : undefined,
        durationSeconds: audioKind === 'sound-effects' ? durationSeconds : undefined,
        musicLengthMs: audioKind === 'music' ? musicLengthMs : undefined,
        lyrics: audioKind === 'music' && lyrics.trim() ? lyrics.trim() : undefined,
        extraParams: {},
      });
      recordGenerationOutcome({
        nodeId: outputId,
        kind: 'audio',
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        size: audioKind,
        duration: audioKind === 'sound-effects' ? durationSeconds : 0,
        status: 'succeeded',
        durationMs: Date.now() - generationStartedAt,
      });
      updateNodeData(outputId, {
        sourcePath: audioUrl,
        generationResultProtected: true,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
        generationClientSessionId: null,
        generationRequest: undefined,
      });
    } catch (generationError) {
      const resolved = resolveErrorContent(generationError, '音频生成失败');
      setError(resolved.message);
      recordGenerationOutcome({
        nodeId: outputId,
        kind: 'audio',
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        size: audioKind,
        duration: audioKind === 'sound-effects' ? durationSeconds : 0,
        status: 'failed',
        errorMessage: resolved.message,
        durationMs: Date.now() - generationStartedAt,
      });
      // 失败时把请求上下文落到结果节点上, 否则「复制错误报告」只能给出一份空报告。
      const runtimeDiagnostics = await getRuntimeDiagnostics().catch(() => null);
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'audioGen',
        providerId: selectedModel.providerId,
        requestModel: selectedModel.id,
        prompt,
        extraParams: {
          provider_base_url: baseUrl,
          audio_kind: audioKind,
          ...(audioKind === 'speech' ? { voice, format } : {}),
          ...(audioKind === 'sound-effects' ? { duration_seconds: durationSeconds } : {}),
          ...(audioKind === 'music' ? { music_length_ms: musicLengthMs } : {}),
        },
        appVersion: runtimeDiagnostics?.appVersion,
        osName: runtimeDiagnostics?.osName,
        osVersion: runtimeDiagnostics?.osVersion,
        osBuild: runtimeDiagnostics?.osBuild,
        userAgent: runtimeDiagnostics?.userAgent,
      };
      updateNodeData(outputId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: resolved.message,
        generationErrorDetails: resolved.details ?? null,
        generationClientSessionId: null,
        generationDebugContext,
      });
      void showErrorDialog(
        resolved.message,
        t('common.error'),
        resolved.details,
        buildGenerationErrorReport({
          errorMessage: resolved.message,
          errorDetails: resolved.details,
          context: generationDebugContext,
        }),
      );
    } finally {
      setIsGenerating(false);
    }
  }, [
    addEdge,
    addNode,
    apiKeys,
    audioKind,
    customApis,
    durationSeconds,
    findNodePosition,
    flushCommit,
    format,
    id,
    lyrics,
    musicLengthMs,
    selectedModel,
    t,
    updateNodeData,
    updateNodeSize,
    voice,
  ]);

  return (
    <div
      ref={rootRef}
      className={`relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-3 ${selected ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]' : 'border-[rgba(255,255,255,0.18)]'}`}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<KindIcon className="h-4 w-4" />}
        titleText={title}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
        rightSlot={nodePrice ? <NodePriceBadge label={nodePrice.label} title={nodePrice.nativeLabel} /> : null}
      />
      <div className="relative min-h-0 flex-1 rounded-md border border-border-dark bg-bg-dark/60">
        <textarea
          value={promptDraft}
          onChange={(event) => {
            const nextValue = event.target.value;
            promptDraftRef.current = nextValue;
            setPromptDraft(nextValue);
            scheduleCommit();
          }}
          onBlur={flushCommit}
          onMouseDown={(event) => event.stopPropagation()}
          placeholder={t('node.audioGen.placeholder')}
          className="ui-scrollbar nodrag nowheel h-full w-full resize-none overflow-y-auto border-none bg-transparent p-2 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/80 [font-family:inherit]"
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            className="nodrag flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded border border-border-dark bg-bg-dark px-2 text-left text-xs text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              setShowModelPicker((current) => !current);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            aria-expanded={showModelPicker}
            aria-label={t('modelParams.model')}
          >
            <span className="min-w-0 truncate">
              {selectedModelName || (models.length === 0 ? t('node.audioGen.noModels') : '')}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${showModelPicker ? 'rotate-180' : ''}`} />
          </button>
          {showModelPicker && (
            <div
              className="nodrag nowheel absolute left-0 top-[calc(100%+6px)] z-30 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-3 shadow-xl"
              onMouseDown={(event) => event.stopPropagation()}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              {models.length === 0 ? (
                <div className="text-xs text-text-muted">{t('node.audioGen.noModels')}</div>
              ) : (
                <div className="ui-scrollbar max-h-[300px] space-y-3 overflow-y-auto">
                  <section>
                    <div className="mb-2 text-xs font-medium text-text-muted">{t('modelParams.provider')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {modelProviders.map((provider) => {
                        const active = provider.id === modelPickerProviderId;
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            className={`h-8 rounded-lg border px-3 text-xs transition-colors ${active
                              ? 'border-accent/50 bg-accent/15 text-text-dark'
                              : 'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)]'
                              }`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setModelPickerProviderId(provider.id);
                            }}
                          >
                            {provider.label || provider.name}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                  <section>
                    <div className="mb-2 text-xs font-medium text-text-muted">{t('modelParams.model')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {pickerProviderModels.map((model) => {
                        const providerName = getModelProvider(model.providerId).label;
                        const label = model.displayName.startsWith(`${providerName} · `)
                          ? model.displayName.slice(providerName.length + 3)
                          : model.displayName;
                        const active = model.id === selectedModel?.id;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            className={`min-h-8 max-w-full rounded-lg border px-3 py-1.5 text-xs leading-4 transition-colors ${active
                              ? 'border-accent/50 bg-accent/15 text-text-dark'
                              : 'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)] hover:bg-[rgba(255,255,255,0.05)]'
                              }`}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectModel(model.id);
                            }}
                          >
                            <span className="break-words">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}
            </div>
          )}
        </div>
        <span className="shrink-0 rounded border border-border-dark bg-bg-dark px-2 py-1 text-[11px] text-text-muted">
          {t(KIND_LABEL_KEY[audioKind])}
        </span>
      </div>
      {audioKind === 'speech' && (
        <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-1.5">
          <input
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
            value={voice}
            onChange={(event) => updateNodeData(id, { voice: event.target.value })}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.audioGen.voice')}
            aria-label={t('node.audioGen.voice')}
          />
          <select
            className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
            value={format}
            onChange={(event) => updateNodeData(id, { format: event.target.value })}
            aria-label={t('node.audioGen.format')}
          >
            {SPEECH_FORMAT_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      )}
      {audioKind === 'sound-effects' && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-text-muted">{t('node.audioGen.durationSeconds')}</span>
          <select
            className="nodrag h-8 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
            value={durationSeconds}
            onChange={(event) => updateNodeData(id, { durationSeconds: Number(event.target.value) })}
            aria-label={t('node.audioGen.durationSeconds')}
          >
            {SOUND_EFFECT_DURATION_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}s</option>
            ))}
          </select>
        </div>
      )}
      {audioKind === 'music' && (
        <>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-text-muted">{t('node.audioGen.musicLength')}</span>
            <select
              className="nodrag h-8 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
              value={musicLengthMs}
              onChange={(event) => updateNodeData(id, { musicLengthMs: Number(event.target.value) })}
              aria-label={t('node.audioGen.musicLength')}
            >
              {MUSIC_LENGTH_OPTIONS_MS.map((option) => (
                <option key={option} value={option}>{Math.round(option / 1000)}s</option>
              ))}
            </select>
          </div>
          <textarea
            value={lyrics}
            onChange={(event) => updateNodeData(id, { lyrics: event.target.value })}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.audioGen.lyrics')}
            className="ui-scrollbar nodrag nowheel h-16 w-full resize-none rounded border border-border-dark bg-bg-dark p-2 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/80 [font-family:inherit]"
          />
        </>
      )}
      {error && <span className="line-clamp-2 text-[11px] text-red-400">{error}</span>}
      <button
        type="button"
        disabled={isGenerating || !selectedModel || !promptDraft.trim()}
        onClick={() => void handleGenerate()}
        className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        {isGenerating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {isGenerating ? t('node.audioGen.generating') : t('node.audioGen.generate')}
      </button>
      <Handle id="target" type="target" position={Position.Left} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
      <Handle id="source" type="source" position={Position.Right} className="!h-2 !w-2 !border-surface-dark !bg-accent" />
      <NodeResizeHandle
        minWidth={AUDIO_GEN_NODE_MIN_WIDTH}
        minHeight={AUDIO_GEN_NODE_MIN_HEIGHT}
        maxWidth={AUDIO_GEN_NODE_MAX_WIDTH}
        maxHeight={AUDIO_GEN_NODE_MAX_HEIGHT}
      />
    </div>
  );
});

AudioGenNode.displayName = 'AudioGenNode';
