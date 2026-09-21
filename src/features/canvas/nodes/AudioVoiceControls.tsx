import { useCallback, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BookmarkPlus, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { persistLibraryAssetBinary, persistLibraryAssetFile } from "@/commands/assetLibrary";
import type { AudioGenNodeData } from "@/features/canvas/domain/canvasNodes";
import type { AudioCreativePanel, AudioModelDefinition, AudioVoiceEntry } from "@/features/canvas/models";
import { useSettingsStore } from "@/stores/settingsStore";

import { VoiceSelect, type VoiceSelectOption } from "./audio/VoiceSelect";
import type { AudioPreviewSource, AudioPreviewController } from "./audio/useAudioPreview";
import { VoicePreviewButton } from "./audio/VoicePreviewButton";

const EMOTIONS = ["natural", "calm", "happy", "sad", "angry", "whisper", "energetic"] as const;

/** 认不出音色表的模型(其它平台)退回这一份, 保持改造前的兜底行为。 */
const FALLBACK_VOICE_IDS = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const FALLBACK_FORMATS = ["mp3", "wav", "pcm", "opus"];

type AudioVoiceControlsProps = {
  panel: AudioCreativePanel;
  /** 当前模型。 */
  model?: AudioModelDefinition;
  /** 当前家族下的全部模型 —— 页面内的「模型」下拉用它, 每个页面都必须能换模型。 */
  models?: AudioModelDefinition[];
  /** 切换模型(由节点统一处理参数重置)。 */
  onSelectModel?: (modelId: string) => void;
  voice: string;
  voiceProfileId?: string;
  referenceAudio?: string;
  indexTtsSecondReferenceAudio?: string;
  /** RunningHub IndexTTS2.5 的合成语言。 */
  indexTtsLanguage?: string;
  /** IndexTTS 当前工作流卡片。 */
  indexTtsMode?: "emotion-reference" | "polyphone";
  /** 多音字手工读音表。 */
  indexTtsPronunciation?: string;
  /** 自然语言风格指令(GM 系列 / GT-4o Mini TTS 独有)。 */
  instructions?: string;
  /** 语速(GT 系列独有, 平台接受 0.25-4.0 小数)。 */
  speed?: string;
  emotion: string;
  emotionIntensity: number;
  format: string;
  onChange: (patch: Partial<AudioGenNodeData>) => void;
  /** 全局唯一的试听控制器(由节点持有, 保证同时只有一条声音在响)。 */
  preview: AudioPreviewController;
  /**
   * 取某个音色的试听音频 —— 有现成的直接返回路径, 没有就现场合成一条。
   * 现场合成是**真实计费**, 所以只能由用户点试听键触发, 不能预取。
   */
  onRequestVoicePreview: (voiceId: string) => AudioPreviewSource | Promise<AudioPreviewSource>;
  /** IndexTTS 使用独立的「双样音 + 文本」工作流面板。 */
  isIndexTts?: boolean;
};

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * 页面内的「模型」选择器。
 *
 * 右上角那个选的是**家族**(MINIMAX / indexTTS / ChatGPT / Gemini / …), 家族里还可能有
 * 多个具体模型 —— 比如 Gemini 家族同时有 GM-3.1 Flash 与 GM-2.5 Pro、ChatGPT 家族有
 * GT TTS / GT TTS HD / GT-4o Mini TTS。没有这个下拉, 用户切到 Gemini 页就只能在
 * 「家族第一个模型」上打转, 另一个模型永远选不到。
 */
function ModelPicker({
  models,
  value,
  onChange,
}: {
  models?: AudioModelDefinition[];
  value?: string;
  onChange?: (modelId: string) => void;
}) {
  const { t } = useTranslation();
  if (!models || models.length === 0 || !onChange) return null;
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[10px] text-text-muted">{t("node.audioGen.model")}</span>
      <select
        className="nodrag h-7 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark"
        value={value ?? models[0]?.id ?? ""}
        onChange={(event) => onChange(event.target.value)}
        aria-label={t("node.audioGen.model")}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 音色选项: 优先用模型的真实音色表, 认不出时退回平台给的扁平候选。 */
function useVoiceEntries(model?: AudioModelDefinition): AudioVoiceEntry[] {
  return useMemo(() => {
    const catalogVoices = model?.voiceCatalog?.voices;
    if (catalogVoices && catalogVoices.length > 0) return catalogVoices;
    const flat = model?.voiceOptions ?? FALLBACK_VOICE_IDS;
    return flat.map((id) => ({ id }));
  }, [model]);
}

/** 「Zephyr · 明亮 / Bright」—— 名字是平台值, 后半段是可读的风格说明。 */
function voiceLabel(entry: AudioVoiceEntry, withStyle: boolean): string {
  const label = entry.name ?? entry.id;
  return withStyle && entry.style ? `${label} · ${entry.style}` : label;
}

/**
 * 音色选项 —— 音色库(已克隆/设计)在前, 模型预置音色在后。
 *
 * 两者合成**同一份列表**是刻意的: 用户要的是「选 + 听」在一个地方完成。以前音色库在
 * 原生下拉里、预置音色在下面另一块网格里, 同一件事被劈成两个控件, 而且那块网格还常驻。
 */
function useVoiceOptions(
  model: AudioModelDefinition | undefined,
  voice: string,
): VoiceSelectOption[] {
  const { t } = useTranslation();
  const profiles = useSettingsStore((state) => state.voiceProfiles);
  const entries = useVoiceEntries(model);

  return useMemo(() => {
    const options: VoiceSelectOption[] = [];
    const seen = new Set<string>();
    for (const profile of profiles) {
      if (seen.has(profile.voiceId)) continue;
      seen.add(profile.voiceId);
      options.push({
        value: profile.voiceId,
        label: profile.name,
        hint: profile.source === "design" ? t("node.audioGen.designVoiceTag") : undefined,
        group: t("node.audioGen.savedVoices"),
        previewAudio: profile.previewAudio,
      });
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      options.push({
        value: entry.id,
        label: voiceLabel(entry, true),
        hint: undefined,
        group: `${t("node.audioGen.builtinVoices")} (${entries.length})`,
      });
    }
    // 节点上存着一个不属于当前模型的音色时(换了模型/换了平台), 仍要能显示出来,
    // 否则触发器会变成空的「自定义音色」, 用户看不出当前到底在用哪个。
    const current = voice.trim();
    if (current && !seen.has(current)) {
      options.push({ value: current, label: current, group: t("node.audioGen.customVoice") });
    }
    return options;
  }, [entries, profiles, t, voice]);
}

/** 音色选择器 = 下拉 + 内联试听。 */
function VoicePicker({
  model,
  voice,
  voiceProfileId,
  onChange,
  preview,
  onRequestVoicePreview,
}: Pick<
  AudioVoiceControlsProps,
  "model" | "voice" | "voiceProfileId" | "onChange" | "preview" | "onRequestVoicePreview"
>) {
  const { t } = useTranslation();
  const profiles = useSettingsStore((state) => state.voiceProfiles);
  const options = useVoiceOptions(model, voice);

  return (
    <VoiceSelect
      className="flex-1"
      size="md"
      options={options}
      value={voiceProfileId ? (profiles.find((item) => item.id === voiceProfileId)?.voiceId ?? voice) : voice}
      onChange={(next) => {
        // 音色库里选出来的要连带把档案信息一起带上(样音/情绪), 否则「克隆了但声音没变」。
        const profile = profiles.find((item) => item.voiceId === next);
        onChange({
          voice: next,
          voiceProfileId: profile?.id,
          referenceAudio: profile?.referenceAudio,
          ...(profile?.emotion ? { emotion: profile.emotion } : {}),
        });
      }}
      placeholder={t("node.audioGen.pickVoice")}
      clearLabel={t("node.audioGen.voiceSelectNone")}
      ariaLabel={t("node.audioGen.voice")}
      preview={preview}
      resolvePreview={(option) => option.previewAudio ?? onRequestVoicePreview(option.value)}
    />
  );
}

export function AudioVoiceControls({
  panel,
  model,
  models,
  onSelectModel,
  voice,
  voiceProfileId,
  referenceAudio,
  indexTtsSecondReferenceAudio,
  indexTtsLanguage = "ZH",
  indexTtsMode = "emotion-reference",
  indexTtsPronunciation = "",
  instructions,
  speed,
  emotion,
  emotionIntensity,
  format,
  onChange,
  preview,
  onRequestVoicePreview,
  isIndexTts = false,
}: AudioVoiceControlsProps) {
  const { t } = useTranslation();
  const saveVoiceProfile = useSettingsStore((state) => state.saveVoiceProfile);
  const removeVoiceProfile = useSettingsStore((state) => state.removeVoiceProfile);
  const profiles = useSettingsStore((state) => state.voiceProfiles);
  const [profileName, setProfileName] = useState("");
  const [isSavingSample, setIsSavingSample] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const secondReferenceFileInputRef = useRef<HTMLInputElement>(null);
  const selectedProfile = profiles.find((item) => item.id === voiceProfileId);

  const catalog = model?.voiceCatalog;
  const formatOptions = model?.formatOptions ?? FALLBACK_FORMATS;
  const speedRange = catalog?.speed;

  const applyReferenceAudio = useCallback(
    (source: string) => {
      onChange({ referenceAudio: source, voiceProfileId: undefined });
    },
    [onChange],
  );

  const applySecondReferenceAudio = useCallback(
    (source?: string) => {
      onChange({ indexTtsSecondReferenceAudio: source || undefined });
    },
    [onChange],
  );


  const persistSelectedFile = useCallback(
    async (file: File) => {
      const extension = file.name.split(".").pop()?.trim() || "mp3";
      const nativePath = (file as File & { path?: unknown }).path;
      const source =
        isTauri() && typeof nativePath === "string" && nativePath.trim()
          ? await persistLibraryAssetFile(nativePath, extension)
          : await persistLibraryAssetBinary(new Uint8Array(await file.arrayBuffer()), extension);
      applyReferenceAudio(source);
    },
    [applyReferenceAudio],
  );

  const persistSecondReferenceFile = useCallback(
    async (file: File) => {
      const extension = file.name.split(".").pop()?.trim() || "mp3";
      const nativePath = (file as File & { path?: unknown }).path;
      const source =
        isTauri() && typeof nativePath === "string" && nativePath.trim()
          ? await persistLibraryAssetFile(nativePath, extension)
          : await persistLibraryAssetBinary(new Uint8Array(await file.arrayBuffer()), extension);
      applySecondReferenceAudio(source);
    },
    [applySecondReferenceAudio],
  );


  const chooseSecondReferenceAudio = useCallback(async () => {
    if (!isTauri()) {
      secondReferenceFileInputRef.current?.click();
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "webm"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setIsSavingSample(true);
    try {
      const extension = selected.split(".").pop()?.trim() || "mp3";
      applySecondReferenceAudio(await persistLibraryAssetFile(selected, extension));
    } finally {
      setIsSavingSample(false);
    }
  }, [applySecondReferenceAudio]);


  const chooseReferenceAudio = useCallback(async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [
        { name: t("node.audioGen.sampleAudio"), extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "webm"] },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    setIsSavingSample(true);
    try {
      const extension = selected.split(".").pop()?.trim() || "mp3";
      applyReferenceAudio(await persistLibraryAssetFile(selected, extension));
    } finally {
      setIsSavingSample(false);
    }
  }, [applyReferenceAudio, t]);

  const saveProfile = useCallback(() => {
    const fallbackName = referenceAudio ? fileName(referenceAudio).replace(/\.[^.]+$/, "") : voice;
    const profile = saveVoiceProfile({
      name: profileName.trim() || fallbackName || t("node.audioGen.myVoice"),
      providerId: model?.providerId,
      voiceId: voice,
      referenceAudio,
      emotion,
    });
    setProfileName("");
    onChange({ voiceProfileId: profile.id });
  }, [emotion, model?.providerId, onChange, profileName, referenceAudio, saveVoiceProfile, t, voice]);

  // 「上传样音 → 存进音色库 → 在 TTS 面板里把它选出来」本来是两步的同一件事。
  // 抽成变量后既能当独立面板(panel="voice-clone"), 也能追加渲染进支持克隆的 TTS
  // 面板(panel="speech")—— 家族分页后 indexTTS / CosyVoice / Fish-Speech /
  // ElevenLabs 这些非 MiniMax 模型走的是后者, 不追加的话样音上传入口会整个消失。
  const cloneSampleSection = (
    <div className="space-y-1.5">
      <div className="rounded border border-border-dark bg-bg-dark/55 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-muted">{t("node.audioGen.voiceClone")}</span>
          <span className="text-[10px] text-text-muted">
            {model?.supportsVoiceClone ? t("node.audioGen.cloneReady") : t("node.audioGen.cloneCompatibility")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="nodrag flex h-8 shrink-0 items-center gap-1 rounded border border-border-dark px-2 text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-45"
            disabled={isSavingSample}
            onClick={() => void chooseReferenceAudio()}
          >
            <Upload className="h-3.5 w-3.5" />{" "}
            {isSavingSample ? t("node.audioGen.savingSample") : t("node.audioGen.chooseSample")}
          </button>
        </div>
        {referenceAudio && (
          <div className="mt-1 truncate text-[10px] text-text-muted" title={referenceAudio}>
            {t("node.audioGen.selectedSample")}: {fileName(referenceAudio)}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.webm"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void persistSelectedFile(file);
          event.currentTarget.value = "";
        }}
      />
      <div className="flex items-center gap-1.5">
        <input
          className="nodrag h-8 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
          value={profileName}
          onChange={(event) => setProfileName(event.target.value)}
          placeholder={t("node.audioGen.voiceName")}
        />
        <button
          type="button"
          className="nodrag flex h-8 items-center gap-1 rounded border border-border-dark px-2 text-[11px] text-text-dark hover:bg-white/10"
          onClick={saveProfile}
        >
          <BookmarkPlus className="h-3.5 w-3.5" /> {t("node.audioGen.saveVoice")}
        </button>
      </div>
      {selectedProfile && (
        <button
          type="button"
          className="nodrag flex h-7 items-center gap-1 text-[11px] text-text-muted hover:text-red-300"
          onClick={() => {
            removeVoiceProfile(selectedProfile.id);
            onChange({ voiceProfileId: undefined });
          }}
        >
          <Trash2 className="h-3.5 w-3.5" /> {t("node.audioGen.removeVoice")}
        </button>
      )}
    </div>
  );

  const modelPicker = <ModelPicker models={models} value={model?.id} onChange={onSelectModel} />;

  if (panel === "voice-clone") {
    return (
      <div className="space-y-1.5">
        {modelPicker}
        {cloneSampleSection}
      </div>
    );
  }

  if (panel === "music") {
    // 音乐面板只留模型下拉。
    //
    // 这里**不再渲染「演唱音色」选择器** —— 它是凭空造的控件: 知鸟 Suno 的
    // param_schema 里没有 `voice`(声线由 `vocal_gender` 控制), 字子动画的音乐
    // 请求体也只有 `metadata{lyrics_text, music_length_ms}`。原来的提示语
    // 「音乐模型通常忽略此项」等于承认了它没用。
    // 歌词与时长由节点主体渲染(通用的在下面, Suno 的走 SunoMusicStudio)。
    return <div className="space-y-1.5 rounded border border-border-dark bg-bg-dark/40 p-2">{modelPicker}</div>;
  }

  // IndexTTS 有两条独立的 RunningHub 工作流。顶部两张卡片明确切换工作流，下面只展示
  // 当前卡真正会提交的字段，避免“多音字模式还要求上传情感样音”这类误导。
  if (isIndexTts) {
    const referencePreviewKey = "index-tts-reference";
    const tonePreviewKey = "index-tts-second-reference";
    const isPolyphone = indexTtsMode === "polyphone";
    return (
      <div className="space-y-2">
        {modelPicker}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className={`nodrag rounded border p-2 text-left transition-colors ${!isPolyphone ? "border-accent/60 bg-accent/10" : "border-border-dark bg-bg-dark/45 hover:bg-white/5"}`}
            onClick={() => onChange({ indexTtsMode: "emotion-reference" })}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium text-text-dark">情感参考克隆</span>
              {!isPolyphone && <span className="rounded bg-accent/15 px-1 py-0.5 text-[8px] text-accent">当前</span>}
            </div>
            <p className="mt-1 text-[9px] leading-3 text-text-muted">两段样音锁定声线与表达。</p>
          </button>
          <button
            type="button"
            className={`nodrag rounded border p-2 text-left transition-colors ${isPolyphone ? "border-accent/60 bg-accent/10" : "border-border-dark bg-bg-dark/45 hover:bg-white/5"}`}
            onClick={() => onChange({ indexTtsMode: "polyphone" })}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-medium text-text-dark">多音字语音克隆</span>
              {isPolyphone && <span className="rounded bg-accent/15 px-1 py-0.5 text-[8px] text-accent">当前</span>}
            </div>
            <p className="mt-1 text-[9px] leading-3 text-text-muted">手工标注读音，优先于词典。</p>
          </button>
        </div>

        <div className="rounded border border-accent/25 bg-accent/5 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-medium text-text-dark">
                {isPolyphone ? "IndexTTS2.5 多音字语音克隆" : "IndexTTS2.5 情感参考克隆"}
              </div>
              <p className="mt-0.5 text-[9px] leading-3 text-text-muted">
                {isPolyphone
                  ? "上传一段声线样音；可为指定词语写入拼音，覆盖默认读音。"
                  : "声线与情感样音都必填；情感样音决定朗读的语气与情绪。"}
              </p>
            </div>
            <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[9px] text-accent">
              {isPolyphone ? "多音字" : "情感参考"}
            </span>
          </div>

          <div className="space-y-1.5 rounded border border-border-dark bg-bg-dark/50 p-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-text-muted">声线参考 <span className="text-red-300">必填</span></span>
              {referenceAudio && (
                <button
                  type="button"
                  className="nodrag text-[10px] text-text-muted hover:text-red-300"
                  onClick={() => applyReferenceAudio("")}
                >
                  清除
                </button>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                className="nodrag flex h-7 shrink-0 items-center gap-1 rounded border border-border-dark px-2 text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-45"
                onClick={() => void chooseReferenceAudio()}
                disabled={isSavingSample}
              >
                <Upload className="h-3.5 w-3.5" />
                {referenceAudio ? "替换声线样音" : "选择声线样音"}
              </button>
              {referenceAudio && (
                <>
                  <VoicePreviewButton
                    size="sm"
                    state={preview.stateOf(referencePreviewKey)}
                    onClick={() => preview.toggle(referencePreviewKey, () => referenceAudio)}
                    title="播放声线样音"
                  />
                  <span className="min-w-0 truncate text-[10px] text-text-muted" title={referenceAudio}>{fileName(referenceAudio)}</span>
                </>
              )}
            </div>
          </div>

          {!isPolyphone ? (
            <div className="mt-1.5 space-y-1.5 rounded border border-border-dark bg-bg-dark/50 p-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-muted">情感参考 <span className="text-red-300">必填</span></span>
                {indexTtsSecondReferenceAudio && (
                  <button type="button" className="nodrag text-[10px] text-text-muted hover:text-red-300" onClick={() => applySecondReferenceAudio()}>
                    清除
                  </button>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="nodrag flex h-7 shrink-0 items-center gap-1 rounded border border-border-dark px-2 text-[11px] text-text-dark hover:bg-white/10 disabled:opacity-45"
                  onClick={() => void chooseSecondReferenceAudio()}
                  disabled={isSavingSample}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {indexTtsSecondReferenceAudio ? "替换情感样音" : "选择情感样音"}
                </button>
                {indexTtsSecondReferenceAudio && (
                  <>
                    <VoicePreviewButton size="sm" state={preview.stateOf(tonePreviewKey)} onClick={() => preview.toggle(tonePreviewKey, () => indexTtsSecondReferenceAudio)} title="播放情感样音" />
                    <span className="min-w-0 truncate text-[10px] text-text-muted" title={indexTtsSecondReferenceAudio}>{fileName(indexTtsSecondReferenceAudio)}</span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <label className="mt-1.5 block rounded border border-border-dark bg-bg-dark/50 p-1.5">
              <span className="mb-1 block text-[10px] text-text-muted">手工读音标注 <span className="text-text-muted/70">可选</span></span>
              <textarea
                className="nodrag nowheel ui-scrollbar h-16 w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 font-mono text-[10px] leading-4 text-text-dark outline-none placeholder:text-text-muted/70"
                value={indexTtsPronunciation}
                onChange={(event) => onChange({ indexTtsPronunciation: event.target.value })}
                placeholder={"行|XING2|ZH\n银行|YIN2 HANG2|ZH\n重庆|CHONG2 QING4|ZH"}
                aria-label="IndexTTS 多音字手工读音标注"
              />
              <span className="mt-1 block text-[9px] leading-3 text-text-muted">每行：词语 | 拼音（声调数字） | 语言。顶部文本也可直接写成 &lt;行|HANG2&gt;。</span>
            </label>
          )}
          <label className="mt-1.5 flex items-center gap-2 rounded border border-border-dark bg-bg-dark/50 px-1.5 py-1">
            <span className="shrink-0 text-[10px] text-text-muted">合成语言</span>
            <select
              className="nodrag h-6 min-w-0 flex-1 rounded border border-border-dark bg-bg-dark px-1 text-[10px] text-text-dark"
              value={indexTtsLanguage}
              onChange={(event) => onChange({ indexTtsLanguage: event.target.value })}
              aria-label="IndexTTS2.5 合成语言"
            >
              <option value="ZH">中文</option>
              <option value="EN">English</option>
              <option value="JA">日本語</option>
              <option value="ES">Español</option>
              <option value="AR">العربية</option>
            </select>
          </label>
          <p className="mt-1.5 text-[9px] leading-3 text-text-muted">
            {isPolyphone ? "请输入要朗读的文本；标注为空时按模型词典自动判断读音。" : "请输入要朗读的文本；两段样音分别提供声线与情感。"}
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.webm"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void persistSelectedFile(file);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={secondReferenceFileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.webm"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void persistSecondReferenceFile(file);
            event.currentTarget.value = "";
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {modelPicker}
      <div className="grid grid-cols-[minmax(0,1fr)_92px] gap-1.5">
        <VoicePicker
          model={model}
          voice={voice}
          voiceProfileId={voiceProfileId}
          onChange={onChange}
          preview={preview}
          onRequestVoicePreview={onRequestVoicePreview}
        />
        <select
          className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
          value={format}
          onChange={(event) => onChange({ format: event.target.value })}
          aria-label={t("node.audioGen.format")}
        >
          {formatOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      {/* 自然语言风格指令 —— GM 系列与 GT-4o Mini TTS 的核心差异点:
          「以温柔耳语朗读」「快速兴奋」这类描述走这个字段, 不是 emotion 枚举。 */}
      {catalog?.supportsInstructions && (
        <label className="block">
          <span className="mb-1 block text-[10px] text-text-muted">{t("node.audioGen.instructions")}</span>
          <textarea
            className="nodrag nowheel ui-scrollbar h-12 w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 text-[11px] leading-4 text-text-dark outline-none placeholder:text-text-muted/70"
            value={instructions ?? ""}
            placeholder={t("node.audioGen.instructionsPlaceholder")}
            onChange={(event) => onChange({ instructions: event.target.value })}
          />
        </label>
      )}
      {speedRange && (
        <label className="flex items-center gap-1.5">
          <span className="shrink-0 text-[10px] text-text-muted">{t("node.audioGen.speed")}</span>
          <input
            className="nodrag h-7 w-16 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark"
            type="number"
            min={speedRange.min}
            max={speedRange.max}
            step={speedRange.step}
            value={speed ?? speedRange.default}
            onChange={(event) => onChange({ speed: event.target.value })}
            aria-label={t("node.audioGen.speed")}
          />
          <span className="text-[10px] text-text-muted">
            {t("node.audioGen.speedRange", { min: speedRange.min, max: speedRange.max })}
          </span>
        </label>
      )}
      {/* 支持克隆的模型(除 MiniMax 外)在这里保留「上传样音建音色」入口, 紧贴音色选择器。 */}
      {panel === "speech" && model?.supportsVoiceClone && cloneSampleSection}
      {/* 这里原本还有一块常驻的「内置音色」网格(音色名 + 耳机图标的试听键)。
          它和上面的音色下拉是同一件事的两半(选在这儿、听在那儿), 而且一直占着版面。
          现在试听并进了下拉本身(VoiceSelect 每行自带试听), 所以整块删掉。 */}
      <div className="grid grid-cols-[100px_minmax(0,1fr)_38px] items-center gap-1.5">
        <select
          className="nodrag h-8 rounded border border-border-dark bg-bg-dark px-1 text-xs text-text-dark"
          value={emotion}
          onChange={(event) => onChange({ emotion: event.target.value })}
          aria-label={t("node.audioGen.emotion")}
        >
          {EMOTIONS.map((option) => (
            <option key={option} value={option}>
              {t(`node.audioGen.emotions.${option}`)}
            </option>
          ))}
        </select>
        <input
          className="nodrag w-full accent-[var(--accent-color,#3B82F6)]"
          type="range"
          min="0"
          max="100"
          step="5"
          value={emotionIntensity}
          onChange={(event) => onChange({ emotionIntensity: Number(event.target.value) })}
          aria-label={t("node.audioGen.emotionIntensity")}
        />
        <span className="text-right text-[10px] text-text-muted">{emotionIntensity}%</span>
      </div>
    </div>
  );
}
