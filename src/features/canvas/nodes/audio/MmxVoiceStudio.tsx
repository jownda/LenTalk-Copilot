import { useCallback, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Bookmark, Check, LoaderCircle, Sparkles, Upload, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { persistLibraryAssetBinary, persistLibraryAssetFile } from "@/commands/assetLibrary";
import {
  MMX_DEFAULT_SPEECH_EMOTION,
  MMX_DEFAULT_SPEECH_PITCH,
  MMX_DEFAULT_SPEECH_SOUND_EFFECT,
  MMX_DEFAULT_SPEECH_SPEED,
  MMX_DEFAULT_SPEECH_TIER,
  MMX_DEFAULT_SPEECH_VERSION,
  MMX_SAMPLE_EXTENSIONS,
  MMX_SPEECH_EMOTIONS,
  MMX_SPEECH_PITCHES,
  MMX_SPEECH_SOUND_EFFECTS,
  MMX_SPEECH_SPEEDS,
  MMX_SPEECH_TIERS,
  MMX_SPEECH_VERSIONS,
  resolveMmxCreatePrice,
  validateMmxSample,
} from "@/commands/minimaxVoice";
import type { AudioGenNodeData } from "@/features/canvas/domain/canvasNodes";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { AudioModelDefinition } from "@/features/canvas/models";
import { useSettingsStore } from "@/stores/settingsStore";

import { VoicePreviewButton } from "./VoicePreviewButton";
import { VoiceSelect, type VoiceSelectOption } from "./VoiceSelect";
import {
  MMX_DEFAULT_LANGUAGE,
  MMX_SYSTEM_VOICES,
  MMX_VOICE_LANGUAGES,
  findMmxSystemVoice,
  isMmxSystemVoiceId,
  mmxVoiceGroupOf,
  mmxVoicesForLanguage,
  resolveMmxVoicePreview,
} from "./mmxVoiceLibrary";
import type { AudioPreviewController } from "./useAudioPreview";

/** 卡片当前在跑哪件事 —— 三张卡共用一份忙闲状态, 避免同时发起两笔计费。 */
export type MmxActiveCard = "clone" | "design" | "speech" | "voice-preview" | null;

export type MmxVoiceStudioProps = {
  /** MINIMAX 家族的全部模型(三张卡各取所需)。 */
  models: AudioModelDefinition[];
  data: AudioGenNodeData;
  onChange: (patch: Partial<AudioGenNodeData>) => void;
  /** 合成文本(与节点主输入框同一个值)。 */
  speechText: string;
  isBusy: boolean;
  activeCard: MmxActiveCard;
  /** 各卡片的错误/成功提示, key = 卡片。 */
  cardMessage: Partial<Record<"clone" | "design" | "speech", { tone: "error" | "success"; text: string }>>;
  /** 全节点唯一的试听控制器(与通用 TTS 面板共用同一份, 保证同时只响一条)。 */
  preview: AudioPreviewController;
  onCreateVoice: (kind: "clone" | "design") => void;
  /**
   * 取某个音色的试听音频。
   *
   * 音色库里的音色若自带 `previewAudio` 就直接播那一条; 没有的话这里会**现场跑一次
   * speech-2.8**(按字符计费), 所以只能由用户点试听键触发, 不能预取。
   */
  onRequestVoicePreview: (voiceId: string) => Promise<string | undefined>;
  onGenerateSpeech: () => void;
};

const FIELD_CLASS =
  "nodrag h-7 w-full min-w-0 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark outline-none";
const CARD_CLASS = "rounded-lg border border-border-dark bg-bg-dark/55 p-2";
const LABEL_CLASS = "text-[10px] text-text-muted";

function CardHeader({ index, title, price, hint }: { index: number; title: string; price: string; hint: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[10px] text-accent">
          {index}
        </span>
        <span className="truncate text-[11px] text-text-dark">{title}</span>
      </div>
      <span className="shrink-0 text-[10px] text-text-muted" title={hint}>
        {price}
      </span>
    </div>
  );
}

/** 单卡片内的模型(供应商)选择 —— 三张卡各自独立, 可以跨平台组合。 */
function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: AudioModelDefinition[];
  value?: string;
  onChange: (modelId: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <select
      className={FIELD_CLASS}
      value={value ?? models[0]?.id ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.displayName}
        </option>
      ))}
    </select>
  );
}

/** 读音频时长(秒)。读不到就返回 undefined —— 不阻断流程, 只是跳过时长校验。 */
async function probeAudioDurationSeconds(source: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const finish = (value?: number) => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      resolve(value);
    };
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : undefined);
    };
    audio.onerror = () => finish(undefined);
    audio.preload = "metadata";
    audio.src = resolveImageDisplayUrl(source);
  });
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * MINIMAX 海螺语音工作室 —— 三张卡片, 独立又互相透传。
 *
 * 三张卡不是「三个可替换的模型」, 而是流水线上的三个工位:
 *   ① 音色克隆(样音 → voice_id)  ② 音色设计(文字 → voice_id + 试听)
 *   ③ 语音合成 2.8(文本 + voice_id → 配音音频)
 *
 * 联动就一条线: ①② 产出 voice_id 写入**全局音色库**, ③ 从音色库里选。
 * 因为音色库挂在 settingsStore 上, 所以天然跨项目复用 —— 这正是产品的卖点。
 * 每张卡各有自己的模型下拉, 于是「用 A 平台克隆、用 B 平台合成」是允许的。
 */
export function MmxVoiceStudio({
  models,
  data,
  onChange,
  speechText,
  isBusy,
  activeCard,
  cardMessage,
  preview,
  onCreateVoice,
  onRequestVoicePreview,
  onGenerateSpeech,
}: MmxVoiceStudioProps) {
  const { t } = useTranslation();
  const voiceProfiles = useSettingsStore((state) => state.voiceProfiles);
  /** 官方音色的本地试听缓存(legacy 音色首次合成成功后自动收录, 见 AudioGenNode)。 */
  const systemVoicePreviews = useSettingsStore((state) => state.systemVoicePreviews);
  const [isPickingSample, setIsPickingSample] = useState(false);
  /**
   * 官方音色库的语言过滤器 —— 纯 UI 状态, 不入节点数据。
   *
   * 327 条铺在一个下拉里没法用, 先按语言收窄到几十条。不落库的理由: 它是「本次浏览的视角」,
   * 不是作品的一部分; 换节点/重开项目时回到默认(中文)反而更顺手。
   */
  const [voiceLanguage, setVoiceLanguage] = useState(MMX_DEFAULT_LANGUAGE);
  /** 语言下拉里那个「(58)」的计数来源 —— 全表就是最终表, 不再有「仅已确认」开关。 */
  const voiceLanguageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const voice of MMX_SYSTEM_VOICES) {
      counts.set(voice.lang, (counts.get(voice.lang) ?? 0) + 1);
    }
    return counts;
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cloneModels = useMemo(() => models.filter((model) => model.operation === "voice-clone"), [models]);
  const designModels = useMemo(() => models.filter((model) => model.operation === "voice-design"), [models]);
  const speechModels = useMemo(() => models.filter((model) => model.operation === "speech"), [models]);

  const referenceAudio = typeof data.referenceAudio === "string" ? data.referenceAudio : "";
  const cloneVoiceId = (typeof data.mmxCloneVoiceId === "string" && data.mmxCloneVoiceId) || "";
  const designVoiceId = (typeof data.mmxDesignVoiceId === "string" && data.mmxDesignVoiceId) || "";
  const cloneVoiceName = typeof data.mmxCloneVoiceName === "string" ? data.mmxCloneVoiceName : "";
  const designVoiceName = typeof data.mmxDesignVoiceName === "string" ? data.mmxDesignVoiceName : "";
  const designPrompt = typeof data.voiceDesignPrompt === "string" ? data.voiceDesignPrompt : "";
  const designPreviewText = typeof data.voiceDesignPreviewText === "string" ? data.voiceDesignPreviewText : "";

  const storedVoiceId = (typeof data.voice === "string" && data.voice.trim()) || "";
  /**
   * 当前音色 —— **必须真存在**才算选上了。两种来源:
   *   1. 音色库(克隆/设计产出的资产);
   *   2. **官方系统音色**(`mmxVoiceLibrary` 里那 327 条, 官方音色 id)。
   *
   * 除了这两种一律视为「没选」。这一条顺手清掉了历史脏数据: 早期版本会给这个字段写 GT 系列的
   * `alloy`, 那是个 MiniMax 从未见过的音色, 留着会让「生成配音」在只有一个假音色时也可点。
   */
  const profileVoiceIds = useMemo(
    () => new Set(voiceProfiles.map((profile) => profile.voiceId)),
    [voiceProfiles],
  );
  const currentVoiceId =
    storedVoiceId && (profileVoiceIds.has(storedVoiceId) || isMmxSystemVoiceId(storedVoiceId))
      ? storedVoiceId
      : "";
  /** 当前选中的如果是官方音色, 就把它的描述/标签摊开给用户看(表里 58 条中文音色都带描述)。 */
  const currentSystemVoice = currentVoiceId ? findMmxSystemVoice(currentVoiceId) : undefined;
  /**
   * 音色卡片下面那一行灰字 —— 选了官方音色就显示它的「分组 · 年龄 · 场景 —— 描述」,
   * 没选就退回一句「这个库是什么、试听为什么不要钱」。
   *
   * legacy 那 44 条没有描述, 所以尾部要判空: 否则会留下一截孤零零的「——」。
   */
  const voiceDetailText = useMemo(() => {
    if (!currentSystemVoice) return t("node.audioGen.mmx.voiceLibraryHint");
    const meta = [
      t(`node.audioGen.mmx.voiceGroups.${mmxVoiceGroupOf(currentSystemVoice)}`),
      currentSystemVoice.age,
      currentSystemVoice.scenes.slice(0, 2).join(" / ") || currentSystemVoice.lang,
    ];
    const head = meta.filter(Boolean).join(" · ");
    return currentSystemVoice.desc ? `${head} —— ${currentSystemVoice.desc}` : head;
  }, [currentSystemVoice, t]);

  /** 样音落盘 + 前置校验: 时长/体积/格式不合法就地拦住, 别花 ⚡2.2 换一个参数错误。 */
  const applySample = useCallback(
    async (source: string, meta: { bytes?: number; name?: string }) => {
      const durationSeconds = await probeAudioDurationSeconds(source);
      const rejection = validateMmxSample({
        durationSeconds,
        bytes: meta.bytes,
        fileName: meta.name ?? source,
      });
      if (rejection) {
        onChange({ referenceAudio: source, mmxCloneVoiceId: undefined, mmxCloneVoiceName: undefined });
        // 校验结果写回节点, 由节点统一弹错误框(与生成失败同一条通道)。
        onChange({ generationError: rejection } as Partial<AudioGenNodeData>);
        return;
      }
      onChange({
        referenceAudio: source,
        // 换了样音就是换了一个音色资产 —— 旧的 voice_id 必须作废, 否则会复用到上一个样本的音色。
        mmxCloneVoiceId: undefined,
        mmxCloneVoiceName: undefined,
        generationError: null,
      } as Partial<AudioGenNodeData>);
    },
    [onChange],
  );

  const chooseSample = useCallback(async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: [...MMX_SAMPLE_EXTENSIONS] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setIsPickingSample(true);
    try {
      const extension = selected.split(".").pop()?.trim() || "mp3";
      const persisted = await persistLibraryAssetFile(selected, extension);
      await applySample(persisted, { name: selected });
    } finally {
      setIsPickingSample(false);
    }
  }, [applySample]);

  const onPickFile = useCallback(
    async (file: File) => {
      setIsPickingSample(true);
      try {
        const extension = file.name.split(".").pop()?.trim() || "mp3";
        const nativePath = (file as File & { path?: unknown }).path;
        const persisted =
          isTauri() && typeof nativePath === "string" && nativePath.trim()
            ? await persistLibraryAssetFile(nativePath, extension)
            : await persistLibraryAssetBinary(new Uint8Array(await file.arrayBuffer()), extension);
        await applySample(persisted, { bytes: file.size, name: file.name });
      } finally {
        setIsPickingSample(false);
      }
    },
    [applySample],
  );

  const clonePreview = typeof data.mmxClonePreviewAudio === "string" ? data.mmxClonePreviewAudio : "";
  const designPreview = typeof data.mmxDesignPreviewAudio === "string" ? data.mmxDesignPreviewAudio : "";

  /**
   * 语音合成卡的候选音色 —— **音色库(我的) + 官方系统音色**。
   *
   * 官方那 327 条是抓来的官方文档「系统音色列表」(见 `mmxVoiceLibrary.ts`), 交集里的每条试听
   * 都是官方现成的 MP3 —— 所以「听一下」不再需要现场跑一次按字符计费的合成。为了不让几百行
   * 糊成一片, 官方音色**先按语言收窄**(默认中文普通话), 再按 男声 / 女声 / 童声 分组。
   *
   * 分组顺序有讲究: VoiceSelect 按**首次出现**建立分组, 所以音色表在数据文件里就已经按
   * 语言 → 分组排好, 这里只负责原样推入, 不再重排 —— 乱序会让「男声」小标题出现两次。
   */
  const speechVoiceOptions = useMemo<VoiceSelectOption[]>(() => {
    const options: VoiceSelectOption[] = [];
    const seen = new Set<string>();
    for (const profile of voiceProfiles) {
      if (seen.has(profile.voiceId)) continue;
      seen.add(profile.voiceId);
      options.push({
        value: profile.voiceId,
        label: profile.name,
        hint: profile.source === "design" ? t("node.audioGen.designVoiceTag") : undefined,
        group: t("node.audioGen.mmx.voiceGroupMine"),
        previewAudio: profile.previewAudio,
      });
    }
    for (const voice of mmxVoicesForLanguage(voiceLanguage)) {
      if (seen.has(voice.id)) continue;
      seen.add(voice.id);
      // 官方样本优先; legacy 音色没有官方样本, 但只要合成过一次就有本地缓存 ——
      // 有缓存就能试听, 试听键从「永不渲染」变成「用过一次就出现」。
      const previewAudio = resolveMmxVoicePreview(voice, systemVoicePreviews);
      options.push({
        value: voice.id,
        label: voice.name,
        // 有风格标签就显示它; 老音色没有风格 —— 没试听时说明「文档收录 · 无试听」,
        // 有本地试听后换成「试听来自上次生成」, 把来源讲清楚。
        hint:
          voice.style ||
          (voice.legacy
            ? t(previewAudio ? "node.audioGen.mmx.generatedPreviewTag" : "node.audioGen.mmx.legacyVoiceTag")
            : undefined),
        group: t(`node.audioGen.mmx.voiceGroups.${mmxVoiceGroupOf(voice)}`),
        previewAudio: previewAudio || undefined,
        previewUnavailable: !previewAudio,
        description: voice.desc || undefined,
      });
    }
    return options;
  }, [t, voiceProfiles, voiceLanguage, systemVoicePreviews]);

  return (
    // `pr-1.5` 给滚动条让位: 卡片是满宽的, 卡内整行的按钮(试听/克隆/合成)原本紧贴右边缘,
    // 会被那 7px 滚动条压住 —— 看起来在、点下去没反应。
    <div className="ui-scrollbar nodrag nowheel flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1.5">
      {/* 非 Tauri(浏览器预览)环境没有原生文件选择器, 退回 <input type=file>。 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/mpeg,audio/mp4,audio/wav,.mp3,.m4a,.wav"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onPickFile(file);
        }}
      />
      <div className={`${CARD_CLASS} grid grid-cols-2 gap-1.5`}>
        {/* ① 音色克隆 */}
        <div className="min-w-0 space-y-1.5">
          <CardHeader
            index={1}
            title={t("node.audioGen.mmx.cloneTitle")}
            price={t("node.audioGen.mmx.pricePerCall", { price: resolveMmxCreatePrice("voice-clone") })}
            hint={t("node.audioGen.mmx.cloneHint")}
          />
          <ModelSelect
            models={cloneModels}
            value={typeof data.mmxCloneModel === "string" ? data.mmxCloneModel : undefined}
            onChange={(modelId) => onChange({ mmxCloneModel: modelId })}
          />
          {referenceAudio ? (
            <div className="flex min-w-0 items-center gap-1">
              <VoicePreviewButton
                block
                className="min-w-0 flex-1"
                label={fileName(referenceAudio)}
                state={preview.stateOf("mmx:reference-sample")}
                onClick={() => preview.toggle("mmx:reference-sample", () => referenceAudio)}
                disabled={isPickingSample}
                title={t("node.audioGen.preview")}
              />
              <button
                type="button"
                className="nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-dark text-text-muted hover:bg-white/10 hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isPickingSample || isBusy}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => void chooseSample()}
                title={t("node.audioGen.mmx.changeSample")}
                aria-label={t("node.audioGen.mmx.changeSample")}
              >
                <Upload className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="nodrag flex h-7 w-full items-center justify-center gap-1 rounded border border-border-dark bg-bg-dark text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-45"
              disabled={isPickingSample || isBusy}
              onClick={() => void chooseSample()}
            >
              <Upload className="h-3 w-3" />
              {isPickingSample ? t("node.audioGen.savingSample") : t("node.audioGen.chooseSample")}
            </button>
          )}
          <input
            className={FIELD_CLASS}
            value={cloneVoiceName}
            placeholder={t("node.audioGen.voiceName")}
            onChange={(event) => onChange({ mmxCloneVoiceName: event.target.value })}
          />
          <div className="truncate text-[10px] text-text-muted" title={cloneVoiceId}>
            {cloneVoiceId ? `ID: ${cloneVoiceId}` : t("node.audioGen.mmx.voiceIdAuto")}
          </div>
          <button
            type="button"
            className="nodrag flex h-7 w-full items-center justify-center gap-1 rounded-md bg-accent text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isBusy || !referenceAudio || cloneModels.length === 0}
            onClick={() => onCreateVoice("clone")}
          >
            {activeCard === "clone" ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Bookmark className="h-3 w-3" />
            )}
            {t("node.audioGen.mmx.startClone")}
          </button>
          {clonePreview ? (
            <VoicePreviewButton
              block
              label={t("node.audioGen.preview")}
              state={preview.stateOf("mmx:clone")}
              onClick={() => preview.toggle("mmx:clone", () => clonePreview)}
            />
          ) : (
            cloneVoiceId && (
              // 平台原文: 「当前克隆动作不产出试听」—— 想听必须再发一次 speech-2.8。
              // 那一次是额外按字符计费的, 所以按钮文案与悬浮说明都点明「生成试听」,
              // 而不是克隆成功后偷偷发一条。
              <VoicePreviewButton
                block
                label={t("node.audioGen.mmx.makePreview")}
                title={t("node.audioGen.mmx.previewCostHint")}
                disabled={isBusy}
                state={preview.stateOf("mmx:clone")}
                onClick={() =>
                  preview.toggle("mmx:clone", () => onRequestVoicePreview(cloneVoiceId))
                }
              />
            )
          )}
        </div>

        {/* ② 音色设计 */}
        <div className="min-w-0 space-y-1.5 border-l border-border-dark pl-1.5">
          <CardHeader
            index={2}
            title={t("node.audioGen.mmx.designTitle")}
            price={t("node.audioGen.mmx.pricePerCall", { price: resolveMmxCreatePrice("voice-design") })}
            hint={t("node.audioGen.mmx.designHint")}
          />
          <ModelSelect
            models={designModels}
            value={typeof data.mmxDesignModel === "string" ? data.mmxDesignModel : undefined}
            onChange={(modelId) => onChange({ mmxDesignModel: modelId })}
          />
          <textarea
            className="nodrag nowheel ui-scrollbar h-12 w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 text-[11px] leading-4 text-text-dark outline-none placeholder:text-text-muted/70"
            value={designPrompt}
            placeholder={t("node.audioGen.mmx.designPromptPlaceholder")}
            onChange={(event) => onChange({ voiceDesignPrompt: event.target.value, mmxDesignVoiceId: undefined })}
          />
          <textarea
            className="nodrag nowheel ui-scrollbar h-9 w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 text-[11px] leading-4 text-text-dark outline-none placeholder:text-text-muted/70"
            value={designPreviewText}
            placeholder={t("node.audioGen.mmx.previewTextPlaceholder")}
            onChange={(event) => onChange({ voiceDesignPreviewText: event.target.value })}
          />
          <input
            className={FIELD_CLASS}
            value={designVoiceName}
            placeholder={t("node.audioGen.voiceName")}
            onChange={(event) => onChange({ mmxDesignVoiceName: event.target.value })}
          />
          <div className="truncate text-[10px] text-text-muted" title={designVoiceId}>
            {designVoiceId ? `ID: ${designVoiceId}` : t("node.audioGen.mmx.voiceIdAuto")}
          </div>
          <button
            type="button"
            className="nodrag flex h-7 w-full items-center justify-center gap-1 rounded-md bg-accent text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isBusy || !designPrompt.trim() || !designPreviewText.trim() || designModels.length === 0}
            onClick={() => onCreateVoice("design")}
          >
            {activeCard === "design" ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {t("node.audioGen.mmx.startDesign")}
          </button>
          {designPreview && (
            <VoicePreviewButton
              block
              label={t("node.audioGen.preview")}
              state={preview.stateOf("mmx:design")}
              onClick={() => preview.toggle("mmx:design", () => designPreview)}
            />
          )}
        </div>
      </div>

      {/* ③ 语音合成 —— 消费 ①② 产出的 voice_id */}
      <div className={CARD_CLASS}>
        <CardHeader
          index={3}
          title={t("node.audioGen.mmx.speechTitle")}
          price={t("node.audioGen.mmx.speechPrice")}
          hint={t("node.audioGen.mmx.speechHint")}
        />
        <div className="space-y-1.5">
          {/* 语言说明: 平台元数据把 speech-2.8 标为「多语言」, 但它的 param_schema 里
              **没有任何语言字段**(全平台 117 个模型都没有一个) —— 语言随输入文本自动识别。
              所以这里放一句说明, 而不是塞一个平台会静默忽略的假下拉, 免得用户以为选了没生效。 */}
          <p className="text-[10px] leading-4 text-text-muted">{t("node.audioGen.mmx.multilingualHint")}</p>
          <ModelSelect
            models={speechModels}
            value={typeof data.model === "string" ? data.model : undefined}
            onChange={(modelId) => onChange({ model: modelId, audioKind: "speech" })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            {/* 音色库选择器 = 选 + 听。候选 = 我的音色库(克隆/设计) + 官方 327 条系统音色。
                默认**什么都不选** —— MiniMax 没有预置音色, 空着才是正确初始态。 */}
            <VoiceSelect
              options={speechVoiceOptions}
              value={currentVoiceId}
              onChange={(next) => {
                const profile = voiceProfiles.find((item) => item.voiceId === next);
                onChange({
                  voice: next,
                  voiceProfileId: profile?.id,
                  ...(profile?.emotion ? { emotion: profile.emotion } : {}),
                });
              }}
              placeholder={t("node.audioGen.mmx.pickVoice")}
              clearLabel={t("node.audioGen.voiceSelectNone")}
              emptyHint={t("node.audioGen.mmx.voiceLibraryEmpty")}
              ariaLabel={t("node.audioGen.voice")}
              preview={preview}
              resolvePreview={(option) => option.previewAudio ?? onRequestVoicePreview(option.value)}
              listHeader={
                // 官方音色有十几种语言, 不收窄就没法挑。放在展开面板里 = 需要时才占版面。
                <div className="flex items-center gap-1">
                  <span className="shrink-0 text-[10px] text-text-muted">
                    {t("node.audioGen.mmx.voiceLanguage")}
                  </span>
                  <select
                    className="nodrag h-6 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1 text-[10px] text-text-dark outline-none"
                    value={voiceLanguage}
                    onChange={(event) => setVoiceLanguage(event.target.value)}
                    aria-label={t("node.audioGen.mmx.voiceLanguage")}
                  >
                    {MMX_VOICE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>
                        {`${lang} (${voiceLanguageCounts.get(lang) ?? 0})`}
                      </option>
                    ))}
                  </select>
                </div>
              }
            />
            <select
              className={FIELD_CLASS}
              value={(typeof data.mmxTier === "string" && data.mmxTier) || MMX_DEFAULT_SPEECH_TIER}
              onChange={(event) => onChange({ mmxTier: event.target.value })}
              aria-label={t("node.audioGen.mmx.tier")}
            >
              {MMX_SPEECH_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {t(`node.audioGen.mmx.tiers.${tier}`)}
                </option>
              ))}
            </select>
          </div>
          {/* 选中官方音色 → 摊开它的描述(官方音色库每条都带一段几十字的说明);
              还没选 → 用同一行说明这个库是什么、试听为什么不要钱。 */}
          <p
            className="line-clamp-3 text-[10px] leading-4 text-text-muted"
            title={currentSystemVoice?.desc || t("node.audioGen.mmx.voiceLibraryHint")}
          >
            {voiceDetailText}
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <label className={LABEL_CLASS}>
              {t("node.audioGen.mmx.version")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={(typeof data.mmxVersion === "string" && data.mmxVersion) || MMX_DEFAULT_SPEECH_VERSION}
                onChange={(event) => onChange({ mmxVersion: event.target.value })}
              >
                {MMX_SPEECH_VERSIONS.map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              {t("node.audioGen.mmx.speed")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={(typeof data.mmxSpeed === "string" && data.mmxSpeed) || MMX_DEFAULT_SPEECH_SPEED}
                onChange={(event) => onChange({ mmxSpeed: event.target.value })}
              >
                {MMX_SPEECH_SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              {t("node.audioGen.mmx.pitch")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={(typeof data.mmxPitch === "string" && data.mmxPitch) || MMX_DEFAULT_SPEECH_PITCH}
                onChange={(event) => onChange({ mmxPitch: event.target.value })}
              >
                {MMX_SPEECH_PITCHES.map((pitch) => (
                  <option key={pitch} value={pitch}>
                    {t(
                      `node.audioGen.mmx.pitches.${pitch === "-6" ? "minus6" : pitch === "-3" ? "minus3" : pitch === "0" ? "zero" : `plus${pitch}`}`,
                    )}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <label className={LABEL_CLASS}>
              {t("node.audioGen.mmx.emotion")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={(typeof data.mmxEmotion === "string" && data.mmxEmotion) || MMX_DEFAULT_SPEECH_EMOTION}
                onChange={(event) => onChange({ mmxEmotion: event.target.value })}
              >
                {MMX_SPEECH_EMOTIONS.map((emotion) => (
                  <option key={emotion} value={emotion}>
                    {t(`node.audioGen.mmx.emotions.${emotion}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              {t("node.audioGen.mmx.soundEffect")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={
                  (typeof data.mmxSoundEffect === "string" && data.mmxSoundEffect) || MMX_DEFAULT_SPEECH_SOUND_EFFECT
                }
                onChange={(event) => onChange({ mmxSoundEffect: event.target.value })}
              >
                {MMX_SPEECH_SOUND_EFFECTS.map((effect) => (
                  <option key={effect} value={effect}>
                    {t(`node.audioGen.mmx.soundEffects.${effect}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center justify-between gap-1.5">
            <span className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
              <Volume2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{t("node.audioGen.mmx.characters", { count: speechText.length })}</span>
            </span>
            <button
              type="button"
              className="nodrag flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={isBusy || !speechText.trim() || !currentVoiceId || speechModels.length === 0}
              onClick={onGenerateSpeech}
            >
              {activeCard === "speech" ? (
                <LoaderCircle className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              {t("node.audioGen.mmx.generateSpeech")}
            </button>
          </div>
          {!currentVoiceId && (
            <p className="text-[10px] leading-4 text-text-muted">{t("node.audioGen.mmx.needVoice")}</p>
          )}
        </div>
      </div>

      {(["clone", "design", "speech"] as const).map((key) => {
        const message = cardMessage[key];
        if (!message) return null;
        return (
          <div
            key={key}
            className={`flex items-start gap-1 rounded border px-1.5 py-1 text-[10px] leading-4 ${
              message.tone === "error"
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {message.tone === "success" && <Check className="mt-0.5 h-3 w-3 shrink-0" />}
            <span className="min-w-0 break-words">{message.text}</span>
          </div>
        );
      })}
    </div>
  );
}
