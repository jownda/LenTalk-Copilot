import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import { AudioLines, ChevronDown, LoaderCircle, Music2, Sparkles, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { generateMmxVoiceId } from "@/commands/minimaxVoice";
import { resolveSunoClipIdForSource } from "@/commands/ai";
import {
  describeSunoValidation,
  normalizeSunoOperation,
  SUNO_OPERATION_SPECS,
  validateSunoMusicInput,
} from "@/commands/sunoMusic";
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type AudioGenNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { canvasAiGateway } from "@/features/canvas/application/canvasServices";
import { resolveErrorContent, showErrorDialog } from "@/features/canvas/application/errorDialog";
import {
  CURRENT_RUNTIME_SESSION_ID,
  buildGenerationErrorReport,
  getRuntimeDiagnostics,
  type GenerationDebugContext,
} from "@/features/canvas/application/generationErrorReport";
import { recordGenerationOutcome } from "@/features/canvas/application/usageRecording";
import { useDebouncedNodeTextCommit } from "@/features/canvas/application/useDebouncedNodeTextCommit";
import {
  AUDIO_FAMILY_LABEL_KEYS,
  AUDIO_FAMILY_ORDER,
  type AudioFamilyLayout,
  type AudioModelFamily,
  getAudioModel,
  getDefaultAudioModelId,
  listAudioModels,
  resolveAudioFamilyLayout,
} from "@/features/canvas/models";
import type { AudioModelDefinition } from "@/features/canvas/models";
import { resolveModelPriceDisplay } from "@/features/canvas/pricing";
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from "@/features/canvas/ui/NodeHeader";
import { NodePriceBadge } from "@/features/canvas/ui/NodePriceBadge";
import { resolveRecommendedApiPriceBadge } from "./nodePriceBadge";
import { AudioVoiceControls } from "./AudioVoiceControls";
import { MmxVoiceStudio, type MmxActiveCard } from "./audio/MmxVoiceStudio";
import { findMmxSystemVoice, shouldCaptureMmxVoicePreview } from "./audio/mmxVoiceLibrary";
import { SunoMusicStudio, type SunoClipCandidate } from "./audio/SunoMusicStudio";
import { useAudioPreview } from "./audio/useAudioPreview";
import { rememberVoice, resolveVoiceForModel } from "./audio/voiceMemory";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { useCanvasStore } from "@/stores/canvasStore";
import { useSettingsStore } from "@/stores/settingsStore";

type AudioGenNodeProps = {
  id: string;
  data: AudioGenNodeData;
  selected?: boolean;
  width?: number;
  height?: number;
};

/**
 * 音频节点的画布尺寸 —— **所有音频页共用**。
 *
 * 统一到 MINIMAX 页原来的尺寸(520×620): 三卡片布局本来就需要这么大, 否则三块挤在一起读不了。
 * 连**最小尺寸**一起统一, 是因为顶部提示词框的宽度 = 节点宽度 − 内边距 —— 最小宽若还留 320,
 * 老节点或用户拖窄的节点又会跟 MINIMAX 页不一致。统一最小值才能让画布上**已有**的节点
 * 也立刻对齐, 而不只是新建的节点。
 */
const AUDIO_GEN_NODE_MIN_WIDTH = 520;
const AUDIO_GEN_NODE_MIN_HEIGHT = 620;
const AUDIO_GEN_NODE_MAX_WIDTH = 900;
const AUDIO_GEN_NODE_MAX_HEIGHT = 1000;
const AUDIO_GEN_NODE_DEFAULT_WIDTH = 520;
const AUDIO_GEN_NODE_DEFAULT_HEIGHT = 620;
/**
 * 顶部提示词框的默认高度 —— **所有音频页共用**。
 *
 * 取值来自 MINIMAX 页在默认尺寸(520×620)下的实测: 可用高 = 620 − 上下内边距 24 − 间隙 8 = 588,
 * 该框占三分之一 = 196。它原来是 `flex-1`, 高度完全被下面的面板挤 —— 标准 TTS 页只剩 ~100px,
 * 而 MINIMAX 页有 ~196px, 同一类节点大小不一。现在固定高度, 剩余空间全部留给下面的面板(面板自己滚)。
 */
const AUDIO_PROMPT_DEFAULT_HEIGHT = 196;

/** 音乐时长(文档 metadata.music_length_ms, 示例 30000)。 */
const MUSIC_LENGTH_OPTIONS_MS = [15000, 30000, 60000, 120000] as const;

const KIND_ICON = {
  speech: Volume2,
  "sound-effects": AudioLines,
  music: Music2,
} as const;

type FamilyGroup = { family: AudioModelFamily; models: AudioModelDefinition[] };

/**
 * 家族布局 → 音频类型。
 *
 * 抽成函数而不是内联三元: 内联写法即便显式标注联合类型, TS 也会用初始化表达式把它
 * 收窄成 `"music" | "speech"`, 于是下游所有 `audioKind === "sound-effects"` 会被判成
 * 恒假报 TS2367。函数返回类型不会被这么收窄。
 * 目前只有 speech / music 两种布局, 但价格计算、时长参数与错误报告都保留了音效分支,
 * 将来加音效家族时不用再改这里。
 */
function resolveNodeAudioKind(layout: AudioFamilyLayout): "speech" | "sound-effects" | "music" {
  return layout === "music" ? "music" : "speech";
}

/**
 * 右上角的模型家族选择器。
 *
 * 之前模型选择藏在节点主体里, 而且只有「一个模型」，看不出家族归属。现在:
 *   - 位置统一到右上角(与图片/视频节点一致);
 *   - 选的是**家族**(MINIMAX / indexTTS / ChatGPT / Gemini / 豆包 / ElevenLabs / Suno),
 *     选完主体就切换成该家族专属的 UI 排布;
 *   - 家族内还有多个具体模型时, 由各家族面板自己的下拉再选。
 */
function AudioFamilyPicker({
  groups,
  value,
  onChange,
  label,
}: {
  groups: FamilyGroup[];
  value: AudioModelFamily;
  onChange: (family: AudioModelFamily) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside, true);
    return () => document.removeEventListener("mousedown", handleOutside, true);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="nodrag flex h-6 max-w-[190px] items-center gap-1 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={label}
        title={label}
      >
        <span className="min-w-0 truncate">{t(AUDIO_FAMILY_LABEL_KEYS[value])}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          className="nodrag nowheel absolute right-0 top-[calc(100%+4px)] z-30 w-[210px] rounded-lg border border-[rgba(255,255,255,0.16)] bg-surface-dark p-1 shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          {groups.map((group) => (
            <button
              key={group.family}
              type="button"
              className={`flex h-7 w-full items-center justify-between gap-2 rounded px-2 text-left text-[11px] transition-colors ${
                group.family === value
                  ? "bg-accent/20 text-text-dark"
                  : "text-text-muted hover:bg-white/5 hover:text-text-dark"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(group.family);
                setOpen(false);
              }}
            >
              <span className="truncate">{t(AUDIO_FAMILY_LABEL_KEYS[group.family])}</span>
              <span className="shrink-0 text-[10px] opacity-70">{group.models.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * AI 音频生成节点。
 *
 * 结构(2026-09-20 起):
 *   右上角 = 模型家族选择器  →  主体按家族渲染专属排布
 *   - MINIMAX  : 三卡片工作室(音色克隆 / 音色设计 / 语音合成), 见 MmxVoiceStudio
 *   - indexTTS : 声线参考 / 语气参考（RunningHub 双样音工作流）
 *   - ChatGPT / Gemini / 豆包 / ElevenLabs : 音色 + 情绪 + 输出格式
 *   - Suno     : 风格 + 歌词 + 时长
 *
 * 上一版是「按创作模式分页」(声音克隆/文字转语音/音乐创作) 并让所有平台共用一套字段,
 * 结果是给 OpenAI 显示「上传克隆样音」、给 Suno 显示「情绪强度」。按家族分页后,
 * 每个家族只出现自己真正支持的控件。
 */
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
  const saveVoiceProfile = useSettingsStore((state) => state.saveVoiceProfile);
  const saveSystemVoicePreview = useSettingsStore((state) => state.saveSystemVoicePreview);
  const rememberLastVoice = useSettingsStore((state) => state.rememberLastVoice);
  const voiceProfiles = useSettingsStore((state) => state.voiceProfiles);
  const showNodePrice = useSettingsStore((state) => state.showNodePrice);
  const priceDisplayCurrencyMode = useSettingsStore((state) => state.priceDisplayCurrencyMode);
  const usdToCnyRate = useSettingsStore((state) => state.usdToCnyRate);
  const preferDiscountedPrice = useSettingsStore((state) => state.preferDiscountedPrice);
  const grsaiCreditTierId = useSettingsStore((state) => state.grsaiCreditTierId);

  const [isGenerating, setIsGenerating] = useState(false);
  const [activeCard, setActiveCard] = useState<MmxActiveCard>(null);
  const [cardMessage, setCardMessage] = useState<
    Partial<Record<"clone" | "design" | "speech", { tone: "error" | "success"; text: string }>>
  >({});
  const [error, setError] = useState<string | null>(null);
  /** Suno 音乐页正在跑哪个动作 —— 让「生成」和「AI 写词」各自只转自己的圈。 */
  const [sunoAction, setSunoAction] = useState<"generate" | "lyrics" | null>(null);
  const [sunoMessage, setSunoMessage] = useState<{ tone: "error" | "success"; text: string } | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? "");
  const promptDraftRef = useRef(promptDraft);
  const { flushCommit, scheduleCommit } = useDebouncedNodeTextCommit({
    nodeId: id,
    field: "prompt",
    valueRef: promptDraftRef,
    updateNodeData,
  });

  // 模型定义直接从平台配置生成。必须 memo: `listAudioModels()` 每次返回新数组,
  // 裸调用会让下游 useMemo 每次渲染都判定为「变了」。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const models = useMemo(() => listAudioModels(), [customApis]);

  /** 家族分组 —— 只保留真正有模型的家族, 顺序按 AUDIO_FAMILY_ORDER。 */
  const familyGroups = useMemo<FamilyGroup[]>(() => {
    const buckets = new Map<AudioModelFamily, AudioModelDefinition[]>();
    for (const model of models) {
      const family = model.family ?? "other";
      const bucket = buckets.get(family);
      if (bucket) bucket.push(model);
      else buckets.set(family, [model]);
    }
    return AUDIO_FAMILY_ORDER.filter((family) => buckets.has(family)).map((family) => ({
      family,
      models: buckets.get(family) ?? [],
    }));
  }, [models]);

  const storedFamily = (typeof data.audioFamily === "string" ? data.audioFamily : "") as AudioModelFamily | "";
  const family = familyGroups.some((group) => group.family === storedFamily)
    ? (storedFamily as AudioModelFamily)
    : (familyGroups[0]?.family ?? "other");
  const layout = resolveAudioFamilyLayout(family);
  const familyModels = useMemo(
    () => familyGroups.find((group) => group.family === family)?.models ?? [],
    [family, familyGroups],
  );

  const selectedModelFromData = getAudioModel(data.model) ?? getAudioModel(getDefaultAudioModelId());
  /** 家族内的当前模型: 数据里的那个若属于本家族就用它, 否则退回本家族第一个。 */
  const selectedModel = useMemo(() => {
    const inFamily = familyModels.find((model) => model.id === selectedModelFromData?.id);
    return inFamily ?? familyModels[0];
  }, [familyModels, selectedModelFromData?.id]);

  const audioKind = resolveNodeAudioKind(layout);
  const KindIcon = KIND_ICON[audioKind] ?? Volume2;
  const title = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.audioGen, data), [data]);

  const isMmxStudio = layout === "mmx-studio";
  /** 音乐家族里走 Suno 协议的模型(知鸟的 `music`)。协议标记与链路层同源。 */
  const isSunoMusic = selectedModel?.musicProtocol === "suno";
  const resolvedWidth = Math.max(
    AUDIO_GEN_NODE_MIN_WIDTH,
    Math.round(width ?? AUDIO_GEN_NODE_DEFAULT_WIDTH),
  );

  /**
   * 上游连线上能当「源 clip」的结果。
   *
   * 只订阅 `edges` —— 节点位置一变 `nodes` 就是新数组, 订阅它会让拖拽时整棵子树重渲染。
   * 而 clip 是在**生成完成后**才写进上游媒体节点的(那时 edges 没变), 所以另加一个
   * refresh token, 生成成功后手动触发一次重算。
   */
  const canvasEdges = useCanvasStore((state) => state.edges);
  const [sunoClipRefreshToken, setSunoClipRefreshToken] = useState(0);
  const sunoClipCandidates = useMemo<SunoClipCandidate[]>(() => {
    // 让 token 进入依赖并真正被读取, 否则 lint 会判定它是多余依赖。
    void sunoClipRefreshToken;
    const canvasNodes = useCanvasStore.getState().nodes;
    const candidates: SunoClipCandidate[] = [];
    for (const edge of canvasEdges) {
      if (edge.target !== id) continue;
      const source = canvasNodes.find((node) => node.id === edge.source);
      const raw = (source?.data as Record<string, unknown> | undefined)?.sunoResultClipId;
      const clipId = typeof raw === "string" ? raw.trim() : "";
      if (!clipId || candidates.some((item) => item.clipId === clipId)) continue;
      const displayName = (source?.data as Record<string, unknown> | undefined)?.displayName;
      candidates.push({
        clipId,
        label: typeof displayName === "string" && displayName.trim() ? displayName.trim() : clipId,
      });
    }
    return candidates;
  }, [canvasEdges, id, sunoClipRefreshToken]);

  const voice = (typeof data.voice === "string" && data.voice.trim()) || "";
  const voiceProfileId =
    typeof data.voiceProfileId === "string" && data.voiceProfileId.trim() ? data.voiceProfileId : undefined;
  const referenceAudio =
    typeof data.referenceAudio === "string" && data.referenceAudio.trim() ? data.referenceAudio : undefined;
  const indexTtsSecondReferenceAudio =
    typeof data.indexTtsSecondReferenceAudio === "string" && data.indexTtsSecondReferenceAudio.trim()
      ? data.indexTtsSecondReferenceAudio
      : undefined;
  const storedIndexTtsLanguage = typeof data.indexTtsLanguage === "string" ? data.indexTtsLanguage.toUpperCase() : "";
  const indexTtsLanguage = ["ZH", "EN", "JA", "ES", "AR"].includes(storedIndexTtsLanguage)
    ? storedIndexTtsLanguage
    : "ZH";
  const indexTtsMode = data.indexTtsMode === "polyphone" ? "polyphone" : "emotion-reference";
  const indexTtsPronunciation = typeof data.indexTtsPronunciation === "string" ? data.indexTtsPronunciation : "";
  const emotion = (typeof data.emotion === "string" && data.emotion.trim()) || "natural";
  const emotionIntensity = Math.max(0, Math.min(100, Math.round(Number(data.emotionIntensity) || 50)));
  /** 自然语言风格指令(GM 系列 / GT-4o Mini TTS) —— 空的就不发。 */
  const instructions = typeof data.instructions === "string" ? data.instructions : "";
  /** 语速(GT 系列) —— 空则用模型默认值。 */
  const speed = typeof data.speed === "string" ? data.speed : "";

  // 「全局记住最后的音色」: 节点内的 voiceByModel 只记一个节点, 这里把每次选定的音色
  // 写进 settingsStore —— 新建的音频节点会默认带出该模型上次用过的音色, 不用每次重挑。
  // 空音色(清除选择)不写入, 旧记忆保留。
  useEffect(() => {
    if (selectedModel && voice) rememberLastVoice(selectedModel.id, voice);
  }, [rememberLastVoice, selectedModel, voice]);
  const storedFormat = (typeof data.format === "string" && data.format.trim()) || "mp3";
  /**
   * 实际使用的输出格式。
   *
   * 旧节点可能存着别的模型的格式 —— 例如在 GT TTS 上用的 `mp3`, 切到 GM 系列后平台
   * 只认 `wav`。这里就地校正(不改节点数据, 只用于渲染与请求), 否则会发出一个格式错误。
   */
  const formatOptions = selectedModel?.formatOptions;
  const format =
    formatOptions && formatOptions.length > 0 && !formatOptions.includes(storedFormat)
      ? (selectedModel?.defaultFormat ?? storedFormat)
      : storedFormat;
  const durationSeconds = Math.max(1, Math.round(Number(data.durationSeconds) || 5));
  const musicLengthMs = Math.max(1000, Math.round(Number(data.musicLengthMs) || 30000));
  const lyrics = typeof data.lyrics === "string" ? data.lyrics : "";

  const isIndexTts = Boolean(
    selectedModel && /index[-_ ]?tts/i.test(`${selectedModel.displayName} ${selectedModel.id}`),
  );
  // IndexTTS2.5 接入的是 RunningHub 的「声线 + 情感参考」应用；它只消费两段样音、
  // 语言和文本，不显示无效的音色、格式、情绪向量、语速或音素参数。
  const resolvedHeight = Math.max(AUDIO_GEN_NODE_MIN_HEIGHT, Math.round(height ?? AUDIO_GEN_NODE_DEFAULT_HEIGHT));

  const price = useMemo(
    () =>
      selectedModel && showNodePrice
        ? resolveModelPriceDisplay(selectedModel, {
            resolution: "",
            extraParams: {
              duration: audioKind === "sound-effects" ? durationSeconds : 0,
              musicLengthMs: audioKind === "music" ? musicLengthMs : undefined,
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

  const recommendedPriceBadge = useMemo(
    () => (price ? null : resolveRecommendedApiPriceBadge(selectedModel?.providerId, customApis, "audio")),
    [customApis, price, selectedModel?.providerId],
  );
  const nodePrice = price ?? recommendedPriceBadge;

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? "";
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  const selectFamily = useCallback(
    (next: AudioModelFamily) => {
      // 切家族时同步把模型换成本家族的第一个, 否则会留着上个家族的模型、参数区对不上。
      const first = familyGroups.find((group) => group.family === next)?.models[0];
      if (!first) {
        updateNodeData(id, { audioFamily: next });
        return;
      }
      // 先把「旧模型 → 当前音色」存下来, 再按新模型的记忆/默认值取音色。
      const memory = rememberVoice(data.voiceByModel, selectedModel?.id, voice);
      updateNodeData(id, {
        audioFamily: next,
        model: first.id,
        audioKind: first.audioKind,
        voiceByModel: memory,
        voice: resolveVoiceForModel(memory, first),
        ...(first.defaultFormat ? { format: first.defaultFormat } : {}),
        ...(first.defaultMusicLengthMs ? { musicLengthMs: first.defaultMusicLengthMs } : {}),
        // 音色与档案是绑在一起的, 换了模型这条链就断了。
        voiceProfileId: undefined,
        referenceAudio: undefined,
        indexTtsSecondReferenceAudio: undefined,
        indexTtsLanguage: undefined,
        indexTtsMode: undefined,
        indexTtsPronunciation: undefined,
      });
    },
    [data.voiceByModel, familyGroups, id, selectedModel?.id, updateNodeData, voice],
  );

  /**
   * 页面内的模型切换器。
   *
   * 右上角选的是**家族**, 而一个家族里往往有多个模型: Gemini 家族有 GM-3.1 Flash /
   * GM-2.5 Pro, ChatGPT 家族有 GT TTS / GT TTS HD / GT-4o Mini TTS。没有这一步,
   * 用户切到家族页后就只能停在「家族第一个模型」上, 同族其它模型永远选不到。
   *
   * 切模型必须把音色与输出格式一起换成新模型的 —— GM 的 `Zephyr` 在 GT 系列里不存在,
   * 留着就会发出一个平台不认的音色。但**不能每次都重置**: 优先还原该模型上次选过的
   * 音色(`voiceByModel`), 只有没选过才退回它的默认值。
   */
  const selectModel = useCallback(
    (modelId: string) => {
      const next = familyModels.find((model) => model.id === modelId);
      if (!next) return;
      const memory = rememberVoice(data.voiceByModel, selectedModel?.id, voice);
      updateNodeData(id, {
        model: next.id,
        audioKind: next.audioKind,
        voiceByModel: memory,
        voice: resolveVoiceForModel(memory, next),
        ...(next.defaultFormat ? { format: next.defaultFormat } : {}),
        voiceProfileId: undefined,
        referenceAudio: undefined,
        indexTtsSecondReferenceAudio: undefined,
        indexTtsLanguage: undefined,
        indexTtsMode: undefined,
        indexTtsPronunciation: undefined,
      });
    },
    [data.voiceByModel, familyModels, id, selectedModel?.id, updateNodeData, voice],
  );

  /** 解析某个模型所属的自定义平台根地址与密钥。 */
  const resolveProviderContext = useCallback(
    (model: AudioModelDefinition) => {
      const customId = model.providerId.slice("custom:".length);
      const baseUrl = customApis.find((api) => api.id === customId)?.baseUrl;
      return { apiKey: apiKeys[model.providerId] ?? "", baseUrl };
    },
    [apiKeys, customApis],
  );

  // ---------------------------------------------------------------------
  // ③ 语音合成(以及其它家族的生成动作)
  // ---------------------------------------------------------------------
  const handleGenerate = useCallback(
    async (isPreview = false) => {
      if (!selectedModel) {
        const message = t("node.audioGen.needModel");
        setError(message);
        void showErrorDialog(message, t("common.error"));
        return;
      }
      flushCommit();
      const prompt = isPreview
        ? t("node.audioGen.previewSentence", { voice: voice || "default" })
        : promptDraftRef.current.trim();
      if (!prompt) {
        const message = t("node.audioGen.needPrompt");
        setError(message);
        void showErrorDialog(message, t("common.error"));
        return;
      }
      if (isIndexTts && !referenceAudio) {
        const message = "请先选择声线参考样音";
        setError(message);
        void showErrorDialog(message, t("common.error"));
        return;
      }
      if (isIndexTts && indexTtsMode === "emotion-reference" && !indexTtsSecondReferenceAudio) {
        const message = "请先选择情感参考样音";
        setError(message);
        void showErrorDialog(message, t("common.error"));
        return;
      }
      if (isMmxStudio && !voice) {
        // speech-2.8 只吃 voice_id —— 没有音色就没有可发出的请求。
        const message = t("node.audioGen.mmx.needVoice");
        setCardMessage((current) => ({ ...current, speech: { tone: "error", text: message } }));
        return;
      }
      if (isSunoMusic) {
        // 提交前就地校验: 平台按**提交次数**计费(⚡0.17/次), 参数不合法也是在扣费之后
        // 才报错(平台的鉴权/校验在计费之后), 所以这一道必须由客户端挡住。
        const sunoOperation = normalizeSunoOperation(typeof data.sunoOperation === "string" ? data.sunoOperation : "");
        const failure = validateSunoMusicInput({
          operation: sunoOperation,
          prompt,
          clipId: typeof data.sunoClipId === "string" ? data.sunoClipId : "",
          continueClipId: typeof data.sunoContinueClipId === "string" ? data.sunoContinueClipId : "",
          coverClipId: typeof data.sunoCoverClipId === "string" ? data.sunoCoverClipId : "",
        });
        if (failure) {
          setSunoMessage({ tone: "error", text: describeSunoValidation(failure) });
          return;
        }
        if (SUNO_OPERATION_SPECS[sunoOperation].output === "text") {
          // `lyrics` 产出的是文本, 走「AI 写词」按钮, 不该出现在生成流程里。
          setSunoMessage({ tone: "error", text: t("node.audioGen.suno.lyricsIsText") });
          return;
        }
      }
      const { apiKey, baseUrl } = resolveProviderContext(selectedModel);
      if (!apiKey) {
        const message = "请在设置中填写 API Key";
        setError(message);
        void showErrorDialog(message, t("common.error"));
        return;
      }

      const generationStartedAt = Date.now();
      const outputId = addNode(CANVAS_NODE_TYPES.audio, findNodePosition(id, 380, 220), {
        displayName: isPreview
          ? `${t("node.audioGen.preview")} · ${voice}`
          : prompt || (indexTtsMode === "polyphone" ? "IndexTTS2.5 多音字语音克隆" : "IndexTTS2.5 情感参考克隆"),
        mediaType: "audio",
        aspectRatio: DEFAULT_ASPECT_RATIO,
        isGenerating: true,
        generationStartedAt,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDurationMs: selectedModel.expectedDurationMs ?? 45000,
        generationProviderId: selectedModel.providerId,
        generationModel: selectedModel.id,
        providerBaseUrl: baseUrl,
        generationRequest: {
          kind: "audio",
          clientJobId: id,
          prompt,
          model: selectedModel.id,
          audioKind,
          creativeMode: layout === "music" ? "music" : "speech",
          ...(audioKind === "speech"
            ? {
                voice,
                format,
                voiceProfileId,
                // 参考样音只在「支持内联样音」的家族上传 —— 海螺 speech-2.8 没有这个字段,
                // 带上也会被平台静默忽略(历史上「克隆了但声音没变」的根因)。
                ...(isMmxStudio ? {} : { referenceAudio }),
                ...(isIndexTts ? {} : { emotion, emotionIntensity }),
                ...(!isIndexTts && instructions.trim() ? { instructions: instructions.trim() } : {}),
                ...(!isIndexTts && speed.trim() ? { speed: speed.trim() } : {}),
              }
            : {}),
          ...(audioKind === "music" ? { musicLengthMs, ...(lyrics.trim() ? { lyrics: lyrics.trim() } : {}) } : {}),
          ...(isIndexTts && indexTtsSecondReferenceAudio ? { indexTtsSecondReferenceAudio } : {}),
          ...(isIndexTts ? { indexTtsLanguage, indexTtsMode, indexTtsPronunciation } : {}),
          ...(isIndexTts
            ? {
                extraParams: {
                  index_tts_language: indexTtsLanguage,
                  index_tts_mode: indexTtsMode,
                  ...(indexTtsMode === "emotion-reference" && indexTtsSecondReferenceAudio
                    ? { index_tts_second_audio: indexTtsSecondReferenceAudio }
                    : {}),
                  ...(indexTtsMode === "polyphone" && indexTtsPronunciation.trim()
                    ? { index_tts_pronunciation: indexTtsPronunciation.trim() }
                    : {}),
                },
              }
            : {}),
        },
      });
      updateNodeSize(outputId, EXPORT_RESULT_NODE_DEFAULT_WIDTH, EXPORT_RESULT_NODE_LAYOUT_HEIGHT);
      addEdge(id, outputId);
      setIsGenerating(true);
      if (isMmxStudio) setActiveCard("speech");
      if (isSunoMusic) {
        setSunoAction("generate");
        setSunoMessage(undefined);
      }
      setError(null);
      if (isMmxStudio) setCardMessage((current) => ({ ...current, speech: undefined }));
      try {
        await canvasAiGateway.setApiKey(selectedModel.providerId, apiKey);
        const audioUrl = await canvasAiGateway.generateAudio({
          prompt,
          model: selectedModel.id,
          audioKind,
          voice: audioKind === "speech" && !isIndexTts ? voice : undefined,
          voiceId: isMmxStudio ? voice : undefined,
          referenceAudio: audioKind === "speech" && !isMmxStudio ? referenceAudio : undefined,
          emotion: audioKind === "speech" && !isIndexTts ? emotion : undefined,
          emotionIntensity: audioKind === "speech" && !isIndexTts ? emotionIntensity : undefined,
          instructions: audioKind === "speech" && !isIndexTts && instructions.trim() ? instructions.trim() : undefined,
          speed: audioKind === "speech" && !isIndexTts && speed.trim() ? speed.trim() : undefined,
          format: audioKind === "speech" && !isIndexTts ? format : undefined,
          durationSeconds: audioKind === "sound-effects" ? durationSeconds : undefined,
          musicLengthMs: audioKind === "music" && !isSunoMusic ? musicLengthMs : undefined,
          lyrics: audioKind === "music" && lyrics.trim() ? lyrics.trim() : undefined,
          // Suno 的 12 个字段(顶层扁平, 与字子动画的 metadata 信封是两套协议)。
          // 没在 Suno 页时整块不发, 免得给别的链路塞平台不认的字段。
          suno: isSunoMusic
            ? {
                operation: normalizeSunoOperation(typeof data.sunoOperation === "string" ? data.sunoOperation : ""),
                version: typeof data.sunoVersion === "string" ? data.sunoVersion : undefined,
                mode: typeof data.sunoMode === "string" ? data.sunoMode : undefined,
                style: typeof data.sunoStyle === "string" ? data.sunoStyle : undefined,
                title: typeof data.sunoTitle === "string" ? data.sunoTitle : undefined,
                vocalGender: typeof data.sunoVocalGender === "string" ? data.sunoVocalGender : undefined,
                negativeTags: typeof data.sunoNegativeTags === "string" ? data.sunoNegativeTags : undefined,
                clipId: typeof data.sunoClipId === "string" ? data.sunoClipId : undefined,
                continueClipId: typeof data.sunoContinueClipId === "string" ? data.sunoContinueClipId : undefined,
                continueAt: typeof data.sunoContinueAt === "string" ? data.sunoContinueAt : undefined,
                coverClipId: typeof data.sunoCoverClipId === "string" ? data.sunoCoverClipId : undefined,
              }
            : undefined,
          mmxParams: isMmxStudio
            ? {
                version: typeof data.mmxVersion === "string" ? data.mmxVersion : undefined,
                tier: typeof data.mmxTier === "string" ? data.mmxTier : undefined,
                speed: typeof data.mmxSpeed === "string" ? data.mmxSpeed : undefined,
                pitch: typeof data.mmxPitch === "string" ? data.mmxPitch : undefined,
                emotion: typeof data.mmxEmotion === "string" ? data.mmxEmotion : undefined,
                soundEffects: typeof data.mmxSoundEffect === "string" ? data.mmxSoundEffect : undefined,
              }
            : undefined,
          extraParams: isIndexTts
            ? {
                index_tts_language: indexTtsLanguage,
                index_tts_mode: indexTtsMode,
                ...(indexTtsMode === "emotion-reference" && indexTtsSecondReferenceAudio
                  ? { index_tts_second_audio: indexTtsSecondReferenceAudio }
                  : {}),
                ...(indexTtsMode === "polyphone" && indexTtsPronunciation.trim()
                  ? { index_tts_pronunciation: indexTtsPronunciation.trim() }
                  : {}),
              }
            : undefined,
        });
        recordGenerationOutcome({
          nodeId: outputId,
          kind: "audio",
          providerId: selectedModel.providerId,
          modelId: selectedModel.id,
          size: audioKind,
          duration: audioKind === "sound-effects" ? durationSeconds : 0,
          status: "succeeded",
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
          // 把结果自带的 Suno clip 落到输出媒体节点上 —— 下游的续写/翻唱/分离/拼接
          // 靠它当源。生成接口只返回媒体路径, 这个值由链路层的内存表带回来。
          ...(isSunoMusic
            ? {
                sunoResultClipId: resolveSunoClipIdForSource(audioUrl) ?? undefined,
              }
            : {}),
        });
        // 没有官方试听的音色(legacy 44 条)第一次被用来合成成功后, 把这份结果收编为
        // 它的本地试听 —— 下次在下拉里就能直接点着听, 不用再花一次合成的钱。
        // 有官方样本的不收(官方的更好), 非官方系统音色/非 MiniMax 页不归这条管。
        if (audioKind === "speech" && voice) {
          const systemVoice = isMmxStudio ? findMmxSystemVoice(voice) : undefined;
          if (shouldCaptureMmxVoicePreview(systemVoice)) {
            saveSystemVoicePreview(voice, audioUrl);
          }
        }
        if (isSunoMusic) {
          // 上游的 clip 列表在生成完成后才变, edges 没动, 手动触发一次重算。
          setSunoClipRefreshToken((current) => current + 1);
          setSunoMessage({ tone: "success", text: t("node.audioGen.suno.generateDone") });
        }
      } catch (generationError) {
        const resolved = resolveErrorContent(generationError, "音频生成失败");
        setError(resolved.message);
        recordGenerationOutcome({
          nodeId: outputId,
          kind: "audio",
          providerId: selectedModel.providerId,
          modelId: selectedModel.id,
          size: audioKind,
          duration: audioKind === "sound-effects" ? durationSeconds : 0,
          status: "failed",
          errorMessage: resolved.message,
          durationMs: Date.now() - generationStartedAt,
        });
        const runtimeDiagnostics = await getRuntimeDiagnostics().catch(() => null);
        const generationDebugContext: GenerationDebugContext = {
          sourceType: "audioGen",
          providerId: selectedModel.providerId,
          requestModel: selectedModel.id,
          prompt,
          extraParams: {
            provider_base_url: baseUrl,
            audio_kind: audioKind,
            audio_family: family,
            ...(audioKind === "speech"
              ? {
                  ...(isIndexTts ? {} : { voice, format, voice_profile_id: voiceProfileId }),
                  reference_audio: isMmxStudio ? "（海螺 speech-2.8 不带参考样音）" : referenceAudio,
                  ...(isIndexTts && indexTtsMode === "emotion-reference" && indexTtsSecondReferenceAudio
                    ? { index_tts_second_audio: indexTtsSecondReferenceAudio }
                    : {}),
                  ...(isIndexTts
                    ? {
                        index_tts_language: indexTtsLanguage,
                        index_tts_mode: indexTtsMode,
                        ...(indexTtsMode === "polyphone" && indexTtsPronunciation.trim()
                          ? { index_tts_pronunciation: indexTtsPronunciation.trim() }
                          : {}),
                      }
                    : {}),
                  mmx_tier: data.mmxTier,
                  mmx_version: data.mmxVersion,
                  mmx_speed: data.mmxSpeed,
                  mmx_pitch: data.mmxPitch,
                  mmx_emotion: data.mmxEmotion,
                  mmx_sound_effect: data.mmxSoundEffect,
                }
              : {}),
            ...(audioKind === "sound-effects" ? { duration_seconds: durationSeconds } : {}),
            ...(audioKind === "music" ? { music_length_ms: musicLengthMs } : {}),
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
        if (isMmxStudio) {
          setCardMessage((current) => ({ ...current, speech: { tone: "error", text: resolved.message } }));
        }
        if (isSunoMusic) {
          setSunoMessage({ tone: "error", text: resolved.message });
        }
        void showErrorDialog(
          resolved.message,
          t("common.error"),
          resolved.details,
          buildGenerationErrorReport({
            errorMessage: resolved.message,
            context: generationDebugContext,
            errorDetails: resolved.details,
          }),
        );
      } finally {
        setIsGenerating(false);
        setActiveCard(null);
        setSunoAction(null);
      }
    },
    [
      addEdge,
      addNode,
      audioKind,
      data.mmxEmotion,
      data.mmxPitch,
      data.mmxSoundEffect,
      data.mmxSpeed,
      data.mmxTier,
      data.mmxVersion,
      data.sunoClipId,
      data.sunoContinueAt,
      data.sunoContinueClipId,
      data.sunoCoverClipId,
      data.sunoMode,
      data.sunoNegativeTags,
      data.sunoOperation,
      data.sunoStyle,
      data.sunoTitle,
      data.sunoVersion,
      data.sunoVocalGender,
      durationSeconds,
      emotion,
      emotionIntensity,
      family,
      findNodePosition,
      flushCommit,
      format,
      id,
      indexTtsSecondReferenceAudio,
      indexTtsLanguage,
      indexTtsMode,
      indexTtsPronunciation,
      instructions,
      isMmxStudio,
      isSunoMusic,
      layout,
      lyrics,
      musicLengthMs,
      referenceAudio,
      resolveProviderContext,
      saveSystemVoicePreview,
      selectedModel,
      speed,
      t,
      updateNodeData,
      updateNodeSize,
      voice,
      voiceProfileId,
    ],
  );

  // ---------------------------------------------------------------------
  // ④ Suno 的 AI 写词 —— 产出歌词**文本**, 不是音频
  // ---------------------------------------------------------------------
  /**
   * `operation=lyrics`：按主题生成歌词并回填歌词框。
   *
   * 刻意不进 `handleGenerate`：那条路的契约是「产出并落一个媒体节点」，
   * 而这里产出的是文本 —— 混在一起会让「生成」按钮发一个结果语义完全不同的请求。
   */
  const handleWriteLyrics = useCallback(async () => {
    const model = selectedModel;
    if (!model) return;
    const description = promptDraftRef.current.trim();
    if (!description) {
      setSunoMessage({ tone: "error", text: t("node.audioGen.suno.needPrompt") });
      return;
    }
    const { apiKey } = resolveProviderContext(model);
    if (!apiKey) {
      const message = t("node.audioGen.needApiKey");
      setSunoMessage({ tone: "error", text: message });
      return;
    }
    flushCommit();
    setSunoAction("lyrics");
    setSunoMessage(undefined);
    try {
      await canvasAiGateway.setApiKey(model.providerId, apiKey);
      const generated = await canvasAiGateway.generateAudioLyrics({
        prompt: description,
        model: model.id,
      });
      const text = generated.trim();
      if (!text) {
        setSunoMessage({ tone: "error", text: t("node.audioGen.suno.lyricsEmpty") });
        return;
      }
      updateNodeData(id, { lyrics: text });
      setSunoMessage({ tone: "success", text: t("node.audioGen.suno.lyricsReady") });
    } catch (writeError) {
      const resolved = resolveErrorContent(writeError, t("node.audioGen.suno.writeLyricsFailed"));
      setSunoMessage({ tone: "error", text: resolved.message });
    } finally {
      setSunoAction(null);
    }
  }, [flushCommit, id, resolveProviderContext, selectedModel, t, updateNodeData]);

  // ---------------------------------------------------------------------
  // ① 音色克隆 / ② 音色设计 —— 建音色资产(按次一次性计费), 产出 voice_id
  // ---------------------------------------------------------------------
  const handleCreateVoice = useCallback(
    async (kind: "clone" | "design") => {
      const isClone = kind === "clone";
      const configuredModelId = isClone ? data.mmxCloneModel : data.mmxDesignModel;
      const target =
        familyModels.find(
          (model) => model.id === configuredModelId && model.operation === (isClone ? "voice-clone" : "voice-design"),
        ) ?? familyModels.find((model) => model.operation === (isClone ? "voice-clone" : "voice-design"));
      const cardKey = isClone ? ("clone" as const) : ("design" as const);
      if (!target) {
        const message = t("node.audioGen.mmx.needModel");
        setCardMessage((current) => ({ ...current, [cardKey]: { tone: "error", text: message } }));
        return;
      }
      const { apiKey, baseUrl } = resolveProviderContext(target);
      if (!apiKey) {
        const message = "请在设置中填写 API Key";
        setCardMessage((current) => ({ ...current, [cardKey]: { tone: "error", text: message } }));
        return;
      }
      if (isClone && !referenceAudio) {
        const message = t("node.audioGen.mmx.needSample");
        setCardMessage((current) => ({ ...current, [cardKey]: { tone: "error", text: message } }));
        return;
      }

      // ⚠️ 必须**先落库再发请求**: 平台按 voice_id 幂等(同一 ID 重复克隆不二次收费),
      // 把 ID 提前写进节点, 失败重试才会沿用同一个, 而不是每点一次生成一个新 ID。
      const existingVoiceId = isClone ? data.mmxCloneVoiceId : data.mmxDesignVoiceId;
      const voiceId =
        typeof existingVoiceId === "string" && existingVoiceId.trim() ? existingVoiceId.trim() : generateMmxVoiceId();
      const rawName = isClone ? data.mmxCloneVoiceName : data.mmxDesignVoiceName;
      // 克隆分支上面已经拦过「没有样音」，这里再兜一次是为了让 TS 收窄类型
      // (TS 不跨 isClone 这个布尔别名收窄 referenceAudio)。
      const sampleSource = referenceAudio ?? "";
      const fallbackName = isClone
        ? sampleSource
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^.]+$/, "") || t("node.audioGen.myVoice")
        : (typeof data.voiceDesignPrompt === "string" ? data.voiceDesignPrompt : "").trim().slice(0, 24) ||
          t("node.audioGen.myVoice");
      const name = (typeof rawName === "string" && rawName.trim()) || fallbackName;

      updateNodeData(id, {
        ...(isClone
          ? { mmxCloneVoiceId: voiceId, mmxCloneVoiceName: name }
          : { mmxDesignVoiceId: voiceId, mmxDesignVoiceName: name }),
      });
      const startedAt = Date.now();
      setActiveCard(cardKey);
      setCardMessage((current) => ({ ...current, [cardKey]: undefined }));
      try {
        await canvasAiGateway.setApiKey(target.providerId, apiKey);
        const result = await canvasAiGateway.generateAudioAsset({
          model: target.id,
          prompt: isClone ? name : typeof data.voiceDesignPrompt === "string" ? data.voiceDesignPrompt : "",
          voiceId,
          sampleAudio: isClone ? referenceAudio : undefined,
          previewText: isClone
            ? undefined
            : typeof data.voiceDesignPreviewText === "string"
              ? data.voiceDesignPreviewText
              : "",
          format,
          extraParams: { provider_base_url: baseUrl },
        });
        const profile = saveVoiceProfile({
          name,
          providerId: target.providerId,
          voiceId: result.voiceId,
          source: isClone ? "clone" : "design",
          family: "speech-2.8",
          referenceAudio: isClone ? referenceAudio : undefined,
          designPrompt: isClone ? undefined : typeof data.voiceDesignPrompt === "string" ? data.voiceDesignPrompt : "",
          previewAudio: result.previewAudio,
          status: "ready",
        });
        // 联动: 建好的音色立刻成为「③ 语音合成」的当前音色 —— 三张卡就是这样串起来的。
        updateNodeData(id, {
          voice: result.voiceId,
          voiceProfileId: profile.id,
          ...(isClone
            ? { mmxClonePreviewAudio: result.previewAudio ?? undefined }
            : { mmxDesignPreviewAudio: result.previewAudio ?? undefined }),
        });
        recordGenerationOutcome({
          nodeId: id,
          kind: "audio",
          providerId: target.providerId,
          modelId: target.id,
          size: isClone ? "voice-clone" : "voice-design",
          duration: 0,
          status: "succeeded",
          durationMs: Date.now() - startedAt,
        });
        setCardMessage((current) => ({
          ...current,
          [cardKey]: {
            tone: "success",
            text: t("node.audioGen.mmx.createDone", { name, voiceId: result.voiceId }),
          },
        }));
      } catch (creationError) {
        const resolved = resolveErrorContent(creationError, isClone ? "音色克隆失败" : "音色设计失败");
        setCardMessage((current) => ({ ...current, [cardKey]: { tone: "error", text: resolved.message } }));
        recordGenerationOutcome({
          nodeId: id,
          kind: "audio",
          providerId: target.providerId,
          modelId: target.id,
          size: isClone ? "voice-clone" : "voice-design",
          duration: 0,
          status: "failed",
          errorMessage: resolved.message,
          durationMs: Date.now() - startedAt,
        });
        const runtimeDiagnostics = await getRuntimeDiagnostics().catch(() => null);
        void showErrorDialog(
          resolved.message,
          t("common.error"),
          resolved.details,
          buildGenerationErrorReport({
            errorMessage: resolved.message,
            errorDetails: resolved.details,
            context: {
              sourceType: "audioGen",
              providerId: target.providerId,
              requestModel: target.id,
              prompt: isClone ? name : typeof data.voiceDesignPrompt === "string" ? data.voiceDesignPrompt : "",
              extraParams: {
                provider_base_url: baseUrl,
                audio_family: family,
                operation: isClone ? "voice-clone" : "voice-design",
                voice_id: voiceId,
                sample_audio: isClone ? referenceAudio : undefined,
                preview_text: isClone ? undefined : data.voiceDesignPreviewText,
                // 重试会沿用同一个 voice_id, 平台不会重复扣费 —— 这一点写进报告便于排查账单。
                voice_id_idempotent: true,
              },
              appVersion: runtimeDiagnostics?.appVersion,
              osName: runtimeDiagnostics?.osName,
              osVersion: runtimeDiagnostics?.osVersion,
              osBuild: runtimeDiagnostics?.osBuild,
              userAgent: runtimeDiagnostics?.userAgent,
            },
          }),
        );
      } finally {
        setActiveCard(null);
      }
    },
    [
      data.mmxCloneModel,
      data.mmxCloneVoiceId,
      data.mmxCloneVoiceName,
      data.mmxDesignModel,
      data.mmxDesignVoiceId,
      data.mmxDesignVoiceName,
      data.voiceDesignPreviewText,
      data.voiceDesignPrompt,
      family,
      familyModels,
      format,
      id,
      referenceAudio,
      resolveProviderContext,
      saveVoiceProfile,
      t,
      updateNodeData,
    ],
  );

  /**
   * 音色试听 —— 给**音色库里没有现成试听音频**的音色现场合成一条。
   *
   * 官方原文: 「当前克隆动作不产出试听(试听 = 创建后首次真实合成)」。所以想听到这个音色,
   * 必须再发一次 speech-2.8。这一步是**额外计费**(按字符, 一句 20 字约 $0.0009), 所以做成
   * 用户显式点击, 而不是克隆成功后偷偷发一条。
   *
   * 返回值交给 `useAudioPreview` 去播 —— 本函数只负责「把音频弄到手」, 不碰播放状态,
   * 这样试听动画在全节点是同一套。
   */
  const handlePreviewVoice = useCallback(
    async (voiceIdInput: string): Promise<string | undefined> => {
      const voiceId = voiceIdInput.trim();
      const speechModel = familyModels.find((model) => model.operation === "speech");
      if (!voiceId || !speechModel) return undefined;
      const { apiKey, baseUrl } = resolveProviderContext(speechModel);
      if (!apiKey) {
        setCardMessage((current) => ({ ...current, clone: { tone: "error", text: "请在设置中填写 API Key" } }));
        return undefined;
      }
      setActiveCard("voice-preview");
      try {
        await canvasAiGateway.setApiKey(speechModel.providerId, apiKey);
        const source = await canvasAiGateway.generateAudio({
          prompt: t("node.audioGen.previewSentence", { voice: voiceId }),
          model: speechModel.id,
          audioKind: "speech",
          voice: voiceId,
          voiceId,
          format,
          mmxParams: {
            version: typeof data.mmxVersion === "string" ? data.mmxVersion : undefined,
            tier: typeof data.mmxTier === "string" ? data.mmxTier : undefined,
          },
          extraParams: { provider_base_url: baseUrl },
        });
        // 试听结果写回音色档案 —— 这是**这笔钱最值钱的副产品**: 下次再点试听直接播本地
        // 这条, 不再重复发一次按字符计费的合成。以前只落在节点的 mmxClonePreviewAudio 上,
        // 换个节点就又得重新付一次。
        const profile = voiceProfiles.find((item) => item.voiceId === voiceId);
        if (profile) {
          saveVoiceProfile({ ...profile, previewAudio: source });
        }
        // 兼容既有字段: 克隆卡靠它从「生成试听」切换成「试听」。
        if (voiceId === (typeof data.mmxCloneVoiceId === "string" ? data.mmxCloneVoiceId.trim() : "")) {
          updateNodeData(id, { mmxClonePreviewAudio: source });
        }
        if (voiceId === (typeof data.mmxDesignVoiceId === "string" ? data.mmxDesignVoiceId.trim() : "")) {
          updateNodeData(id, { mmxDesignPreviewAudio: source });
        }
        return source;
      } catch (previewError) {
        const resolved = resolveErrorContent(previewError, "试听失败");
        setCardMessage((current) => ({ ...current, clone: { tone: "error", text: resolved.message } }));
        return undefined;
      } finally {
        setActiveCard(null);
      }
    },
    [
      data.mmxCloneVoiceId,
      data.mmxDesignVoiceId,
      data.mmxTier,
      data.mmxVersion,
      familyModels,
      format,
      id,
      resolveProviderContext,
      saveVoiceProfile,
      t,
      updateNodeData,
      voiceProfiles,
    ],
  );

  /**
   * 取内置音色的试听音频 —— 「拿到音频」与「放出来」是两件事, 这里只管前者。
   *
   * 播放状态统一由 `useAudioPreview` 持有, 所以调用方是
   * `preview.toggle(key, () => requestBuiltinVoicePreview(id))`:
   * 同一个音色第二次点试听时命中 localStorage 缓存, 不再发第二次请求(它会真计费)。
   */
  const requestBuiltinVoicePreview = useCallback(
    async (previewVoice: string): Promise<string | undefined> => {
      if (!selectedModel) return undefined;
      const cacheKey = `lentalk-audio-voice-preview:${selectedModel.id}:${previewVoice}:${format}`;
      try {
        const cached = window.localStorage.getItem(cacheKey);
        if (cached) return cached;
      } catch {
        // 缓存不可用时照旧现场生成。
      }
      const { apiKey, baseUrl } = resolveProviderContext(selectedModel);
      if (!apiKey) throw new Error(t("node.audioGen.needApiKey"));
      await canvasAiGateway.setApiKey(selectedModel.providerId, apiKey);
      const generated = await canvasAiGateway.generateAudio({
        prompt: t("node.audioGen.previewSentence", { voice: previewVoice }),
        model: selectedModel.id,
        audioKind: "speech",
        voice: previewVoice,
        format,
        extraParams: { provider_base_url: baseUrl },
      });
      try {
        window.localStorage.setItem(cacheKey, generated);
      } catch {
        // 缓存不可用时仍然返回本次生成结果。
      }
      return generated;
    },
    [format, resolveProviderContext, selectedModel, t],
  );

  /** 全节点唯一的试听控制器 —— 通用 TTS 面板与海螺三卡片共用, 保证同时只响一条。 */
  const audioPreview = useAudioPreview();

  // Suno 页的这个框是「歌曲主题/描述」, 不是通用提示词 —— 用专门的例子说清楚。
  const promptPlaceholder = isMmxStudio
    ? t("node.audioGen.mmx.speechPlaceholder")
    : isSunoMusic
      ? t("node.audioGen.suno.promptPlaceholder")
      : t("node.audioGen.placeholder");

  return (
    <div
      ref={rootRef}
      className={`relative flex h-full flex-col gap-2 overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/90 p-3 ${selected ? "border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]" : "border-[rgba(255,255,255,0.18)]"}`}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<KindIcon className="h-4 w-4" />}
        titleText={title}
        editable
        onTitleChange={(displayName) => updateNodeData(id, { displayName })}
        rightSlot={
          <div className="flex items-center gap-1.5">
            {nodePrice ? <NodePriceBadge label={nodePrice.label} title={nodePrice.nativeLabel} /> : null}
            <AudioFamilyPicker
              groups={familyGroups}
              value={family}
              onChange={selectFamily}
              label={t("modelParams.model")}
            />
          </div>
        }
      />

      {/* 顶部提示词框: 固定默认高度(所有音频页一致), 剩余空间给下面的面板。 */}
      <div
        className="relative shrink-0 rounded-md border border-border-dark bg-bg-dark/60"
        style={{ height: `${AUDIO_PROMPT_DEFAULT_HEIGHT}px` }}
      >
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
          placeholder={promptPlaceholder}
          title={isSunoMusic ? t("node.audioGen.suno.promptHint") : undefined}
          className="ui-scrollbar nodrag nowheel h-full w-full resize-none overflow-y-auto border-none bg-transparent p-2 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/80 [font-family:inherit]"
        />
      </div>

      {isMmxStudio ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MmxVoiceStudio
            models={familyModels}
            data={data}
            onChange={(patch) => updateNodeData(id, patch)}
            speechText={promptDraft}
            isBusy={isGenerating || activeCard !== null}
            activeCard={activeCard}
            cardMessage={cardMessage}
            preview={audioPreview}
            onCreateVoice={(kind) => void handleCreateVoice(kind)}
            onRequestVoicePreview={handlePreviewVoice}
            onGenerateSpeech={() => void handleGenerate()}
          />
        </div>
      ) : isSunoMusic ? (
        /* 知鸟 Suno: 一个下拉驱动的表单 —— 12 个 param_schema 字段, 按 operation 显隐。
           通用音乐面板(歌词 + 时长)对它不成立: Suno 没有时长字段, 而它有 8 种操作。 */
        <SunoMusicStudio
          models={familyModels}
          data={data}
          onChange={(patch) => updateNodeData(id, patch)}
          description={promptDraft}
          isBusy={isGenerating}
          clipCandidates={sunoClipCandidates}
          activeAction={sunoAction}
          message={sunoMessage}
          onGenerate={() => void handleGenerate()}
          onWriteLyrics={() => void handleWriteLyrics()}
        />
      ) : (
        <>
          {/* 面板区自己滚动: 顶部提示词框已固定高度, 剩余空间有限 ——
              面板内容(尤其 indexTTS 的一堆参数)超出时在内部滚, 不撑破节点。
              `pr-1.5` 给滚动条让位, 免得面板里靠右的控件(音色行的试听键等)被压在滚动条下面。 */}
          <div className="ui-scrollbar nodrag nowheel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1.5">
            <AudioVoiceControls
              panel={layout === "music" ? "music" : "speech"}
              model={selectedModel}
              models={familyModels}
              onSelectModel={selectModel}
              voice={voice}
              voiceProfileId={voiceProfileId}
              referenceAudio={referenceAudio}
              indexTtsSecondReferenceAudio={indexTtsSecondReferenceAudio}
              indexTtsLanguage={indexTtsLanguage}
              indexTtsMode={indexTtsMode}
              indexTtsPronunciation={indexTtsPronunciation}
              instructions={instructions}
              speed={speed}
              emotion={emotion}
              emotionIntensity={emotionIntensity}
              format={format}
              isIndexTts={isIndexTts}
              onChange={(patch) => updateNodeData(id, patch)}
              preview={audioPreview}
              onRequestVoicePreview={requestBuiltinVoicePreview}
            />
            {/* 通用音乐面板(字子动画 `music-2.6` 等): 只有歌词 + 时长, 同步返回音频。
                走 Suno 协议的模型已在上面被 SunoMusicStudio 接管 —— 那边的字段表
                (8 种 operation / version / mode / vocal_gender)对它们不成立。 */}
            {layout === "music" && (
              <>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[11px] text-text-muted">{t("node.audioGen.musicLength")}</span>
                  <select
                    className="nodrag h-8 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
                    value={musicLengthMs}
                    onChange={(event) => updateNodeData(id, { musicLengthMs: Number(event.target.value) })}
                    aria-label={t("node.audioGen.musicLength")}
                  >
                    {MUSIC_LENGTH_OPTIONS_MS.map((option) => (
                      <option key={option} value={option}>
                        {Math.round(option / 1000)}s
                      </option>
                    ))}
                  </select>
                </div>
                <textarea
                  value={lyrics}
                  onChange={(event) => updateNodeData(id, { lyrics: event.target.value })}
                  onMouseDown={(event) => event.stopPropagation()}
                  placeholder={t("node.audioGen.lyrics")}
                  className="ui-scrollbar nodrag nowheel h-16 w-full shrink-0 resize-none rounded border border-border-dark bg-bg-dark p-2 text-xs leading-5 text-text-dark outline-none placeholder:text-text-muted/80 [font-family:inherit]"
                />
              </>
            )}
          </div>
          {error && <span className="line-clamp-2 text-[11px] text-red-400">{error}</span>}
          <button
            type="button"
            disabled={
              isGenerating || !selectedModel || !promptDraft.trim() || (!isMmxStudio && !voice && layout !== "music")
            }
            onClick={() => void handleGenerate()}
            className="nodrag mt-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isGenerating ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {isGenerating ? t("node.audioGen.generating") : t("node.audioGen.generate")}
          </button>
        </>
      )}

      {/* 试听失败(缺密钥 / 网络 / 音色无效)在这里露一句 —— 试听不属于生成流程,
          既不弹错误框, 也不该塞进某张卡片的消息区(通用 TTS 面板根本没有卡片)。 */}
      {audioPreview.error && <span className="line-clamp-2 text-[11px] text-red-400">{audioPreview.error}</span>}

      <Handle
        id="target"
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        id="source"
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle
        minWidth={AUDIO_GEN_NODE_MIN_WIDTH}
        minHeight={AUDIO_GEN_NODE_MIN_HEIGHT}
        maxWidth={AUDIO_GEN_NODE_MAX_WIDTH}
        maxHeight={AUDIO_GEN_NODE_MAX_HEIGHT}
      />
    </div>
  );
});

AudioGenNode.displayName = "AudioGenNode";
