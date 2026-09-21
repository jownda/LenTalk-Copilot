import { LoaderCircle, Music2, Sparkles, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  normalizeSunoMode,
  normalizeSunoOperation,
  normalizeSunoVersion,
  normalizeSunoVocalGender,
  SUNO_MEDIA_OPERATIONS,
  SUNO_MODES,
  SUNO_MODE_LABEL_KEYS,
  SUNO_MUSIC_UNIT_PRICE,
  SUNO_OPERATION_HINT_KEYS,
  SUNO_OPERATION_LABEL_KEYS,
  SUNO_OPERATION_SPECS,
  SUNO_VERSIONS,
  SUNO_VERSION_LABEL_KEYS,
  SUNO_VOCAL_GENDERS,
  SUNO_VOCAL_GENDER_LABEL_KEYS,
  validateSunoMusicInput,
  type SunoOperation,
} from "@/commands/sunoMusic";
import type { AudioGenNodeData } from "@/features/canvas/domain/canvasNodes";
import type { AudioModelDefinition } from "@/features/canvas/models";

import { SunoTagPicker } from "./SunoTagPicker";
import {
  SUNO_NEGATIVE_TAG_GROUPS,
  SUNO_STYLE_TAG_GROUPS,
} from "./sunoTagLibrary";

/** 上游连线上可用来当「源 clip」的候选。 */
export interface SunoClipCandidate {
  clipId: string;
  /** 展示名(上游节点的显示名)。 */
  label: string;
}

export type SunoMusicStudioProps = {
  /** 音乐家族里走 Suno 协议的模型。 */
  models: AudioModelDefinition[];
  data: AudioGenNodeData;
  onChange: (patch: Partial<AudioGenNodeData>) => void;
  /** 节点主输入框的文本 —— 即 Suno 的「主题 / 描述」。 */
  description: string;
  isBusy: boolean;
  /** 从上游连线里捞到的源 clip。 */
  clipCandidates: SunoClipCandidate[];
  /** 当前节点正在跑哪种动作(生成 / 写词), 用来只转对应的那个圈。 */
  activeAction: "generate" | "lyrics" | null;
  message?: { tone: "error" | "success"; text: string };
  onGenerate: () => void;
  /** AI 写词 —— 产出的是歌词文本, 会回填到歌词框。 */
  onWriteLyrics: () => void;
};

const FIELD_CLASS =
  "nodrag h-7 w-full min-w-0 rounded border border-border-dark bg-bg-dark px-1.5 text-[11px] text-text-dark outline-none";
const LABEL_CLASS = "block text-[10px] text-text-muted";
const TEXTAREA_CLASS =
  "nodrag nowheel ui-scrollbar w-full resize-none rounded border border-border-dark bg-bg-dark p-1.5 text-[11px] leading-4 text-text-dark outline-none placeholder:text-text-muted/70";

/** 每个操作把「源 clip」写到哪个节点字段。 */
const CLIP_FIELD_BY_OPERATION: Record<string, keyof AudioGenNodeData> = {
  stems: "sunoClipId",
  stems_all: "sunoClipId",
  mp4: "sunoClipId",
  concat: "sunoClipId",
  extend: "sunoContinueClipId",
  cover: "sunoCoverClipId",
};

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 知鸟 Suno 音乐工作室 —— 按 `param_schema` 的 12 个字段逐项落地。
 *
 * 与 MINIMAX 三卡片的根本差异：这里**不是流水线上的多个工位**，而是**同一个模型的
 * 一种操作**。`operation` 决定其余字段显隐：
 *   - 生成类（generate / extend / cover）吃 version / mode / style / lyrics / title /
 *     vocal_gender / negative_tags
 *   - 后处理类（stems / stems_all / mp4 / concat）只吃一个源 clip
 * 所以是「一个下拉驱动一张表单」，而不是多张并行卡片。
 *
 * 另外两处与旧实现的关键修正:
 *   - 删掉了「演唱音色」下拉 —— Suno 的 `param_schema` **没有 `voice` 字段**，
 *     那是凭空造的控件；真正的声线控制是 `vocal_gender`(auto/m/f)。
 *   - 删掉了「音乐时长」下拉 —— Suno **没有 `music_length_ms`**，曲长由模型决定。
 */
export function SunoMusicStudio({
  models,
  data,
  onChange,
  description,
  isBusy,
  clipCandidates,
  activeAction,
  message,
  onGenerate,
  onWriteLyrics,
}: SunoMusicStudioProps) {
  const { t } = useTranslation();

  const rawOperation = readString(data.sunoOperation);
  const operation: SunoOperation = normalizeSunoOperation(rawOperation);
  const spec = SUNO_OPERATION_SPECS[operation];
  const mode = normalizeSunoMode(readString(data.sunoMode));
  const version = normalizeSunoVersion(readString(data.sunoVersion));
  const vocalGender = normalizeSunoVocalGender(readString(data.sunoVocalGender));
  const lyrics = readString(data.lyrics);
  const style = readString(data.sunoStyle);
  const title = readString(data.sunoTitle);
  const negativeTags = readString(data.sunoNegativeTags);
  const continueAt = readString(data.sunoContinueAt);

  const clipField = CLIP_FIELD_BY_OPERATION[operation];
  const clipValue = clipField ? readString(data[clipField]) : "";
  const clipSource = spec.clipSource;

  // 本地校验与链路层**同一个函数** —— UI 显示「能点」而请求被判非法, 或反过来,
  // 都会白扣一次费(平台按提交次数计费)。
  const invalid = validateSunoMusicInput({
    operation,
    prompt: description,
    clipId: readString(data.sunoClipId),
    continueClipId: readString(data.sunoContinueClipId),
    coverClipId: readString(data.sunoCoverClipId),
  });
  const canGenerate = !isBusy && models.length > 0 && invalid === null;
  const canWriteLyrics = !isBusy && models.length > 0 && description.trim().length > 0;

  return (
    <div className="ui-scrollbar nodrag nowheel flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1.5">
      {/* 上方那个大输入框没有标签 —— 这里用灰字把它是什么讲清楚。
          它同时是 generate/cover 的主题, 也是「AI 写词」的输入。 */}
      <p className="text-[10px] leading-4 text-text-muted/90">{t("node.audioGen.suno.promptHint")}</p>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
        <label className={LABEL_CLASS}>
          {t("node.audioGen.model")}
          <select
            className={`${FIELD_CLASS} mt-0.5`}
            value={readString(data.model)}
            onChange={(event) => onChange({ model: event.target.value, audioKind: "music" })}
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          {t("node.audioGen.suno.operation")}
          <select
            className={`${FIELD_CLASS} mt-0.5`}
            value={operation}
            onChange={(event) => onChange({ sunoOperation: event.target.value })}
          >
            {SUNO_MEDIA_OPERATIONS.map((item) => (
              <option key={item} value={item}>
                {t(SUNO_OPERATION_LABEL_KEYS[item])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[10px] leading-4 text-text-muted">{t(SUNO_OPERATION_HINT_KEYS[operation])}</p>

      {/* ---- 源 clip：后处理类操作（含 extend / cover）---- */}
      {clipSource && (
        <div className="space-y-1 rounded-lg border border-border-dark bg-bg-dark/55 p-2">
          <div className="text-[10px] text-text-muted">
            {clipSource === "cover_clip_id"
              ? t("node.audioGen.suno.coverClip")
              : clipSource === "continue_clip_id"
                ? t("node.audioGen.suno.continueClip")
                : t("node.audioGen.suno.sourceClip")}
          </div>
          {clipCandidates.length > 0 ? (
            <select
              className={FIELD_CLASS}
              value={clipCandidates.some((candidate) => candidate.clipId === clipValue) ? clipValue : ""}
              onChange={(event) => clipField && onChange({ [clipField]: event.target.value })}
            >
              <option value="">{t("node.audioGen.suno.pickFromUpstream")}</option>
              {clipCandidates.map((candidate) => (
                <option key={candidate.clipId} value={candidate.clipId}>
                  {candidate.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-[10px] leading-4 text-text-muted">{t("node.audioGen.suno.noUpstreamClip")}</p>
          )}
          {/* 手填覆盖：上游没连、或要用历史结果时走这里。 */}
          <input
            className={FIELD_CLASS}
            value={clipValue}
            placeholder={t("node.audioGen.suno.clipIdPlaceholder")}
            onChange={(event) => clipField && onChange({ [clipField]: event.target.value })}
          />
          {clipSource === "continue_clip_id" && (
            <label className={LABEL_CLASS}>
              {t("node.audioGen.suno.continueAt")}
              <input
                className={`${FIELD_CLASS} mt-0.5`}
                value={continueAt}
                inputMode="decimal"
                placeholder={t("node.audioGen.suno.continueAtPlaceholder")}
                onChange={(event) => onChange({ sunoContinueAt: event.target.value })}
              />
            </label>
          )}
          {spec.multiTrack && (
            <p className="text-[10px] leading-4 text-text-muted">{t("node.audioGen.suno.multiTrackHint")}</p>
          )}
        </div>
      )}

      {/* ---- 生成类操作（generate / extend / cover）---- */}
      {spec.usesSongParams && (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <label className={LABEL_CLASS}>
              {t("node.audioGen.suno.version")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={version}
                onChange={(event) => onChange({ sunoVersion: event.target.value })}
              >
                {SUNO_VERSIONS.map((item) => (
                  <option key={item} value={item}>
                    {t(SUNO_VERSION_LABEL_KEYS[item])}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              {t("node.audioGen.suno.mode")}
              <select
                className={`${FIELD_CLASS} mt-0.5`}
                value={mode}
                onChange={(event) => onChange({ sunoMode: event.target.value })}
              >
                {SUNO_MODES.map((item) => (
                  <option key={item} value={item}>
                    {t(SUNO_MODE_LABEL_KEYS[item])}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL_CLASS}>
              {t("node.audioGen.suno.vocalGender")}
              <select
                className={`${FIELD_CLASS} mt-0.5 disabled:opacity-45`}
                value={vocalGender}
                // param_schema 原文: 「纯音乐模式无效」—— 器乐时不发这个字段, UI 也锁上。
                disabled={mode !== "song"}
                title={mode !== "song" ? t("node.audioGen.suno.vocalGenderSongOnly") : undefined}
                onChange={(event) => onChange({ sunoVocalGender: event.target.value })}
              >
                {SUNO_VOCAL_GENDERS.map((item) => (
                  <option key={item} value={item}>
                    {t(SUNO_VOCAL_GENDER_LABEL_KEYS[item])}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={LABEL_CLASS}>
            {t("node.audioGen.suno.style")}
            <input
              className={`${FIELD_CLASS} mt-0.5`}
              value={style}
              placeholder={t("node.audioGen.suno.stylePlaceholder")}
              onChange={(event) => onChange({ sunoStyle: event.target.value })}
            />
          </label>
          {/* 风格库：平时收起成一行, 点开铺 446 个词, 点一下加入/再点移除。 */}
          <SunoTagPicker
            labelKey="node.audioGen.suno.styleTagsOpen"
            panelLabelKey="node.audioGen.suno.styleTagsPanel"
            groups={SUNO_STYLE_TAG_GROUPS}
            value={style}
            onChange={(next) => onChange({ sunoStyle: next })}
          />

          <label className={LABEL_CLASS}>
            {t("node.audioGen.suno.negativeTags")}
            <input
              className={`${FIELD_CLASS} mt-0.5`}
              value={negativeTags}
              placeholder={t("node.audioGen.suno.negativeTagsPlaceholder")}
              onChange={(event) => onChange({ sunoNegativeTags: event.target.value })}
            />
          </label>
          <SunoTagPicker
            labelKey="node.audioGen.suno.negativeTagsOpen"
            panelLabelKey="node.audioGen.suno.negativeTagsPanel"
            groups={SUNO_NEGATIVE_TAG_GROUPS}
            value={negativeTags}
            onChange={(next) => onChange({ sunoNegativeTags: next })}
            tone="negative"
          />

          <label className={LABEL_CLASS}>
            {t("node.audioGen.suno.title")}
            <input
              className={`${FIELD_CLASS} mt-0.5`}
              value={title}
              placeholder={t("node.audioGen.suno.titlePlaceholder")}
              onChange={(event) => onChange({ sunoTitle: event.target.value })}
            />
          </label>

          <div className="rounded-lg border border-border-dark bg-bg-dark/55 p-2">
            <div className="mb-1 flex items-center justify-between gap-1.5">
              <span className="text-[10px] text-text-muted">{t("node.audioGen.suno.lyrics")}</span>
              <button
                type="button"
                className="nodrag flex h-6 items-center gap-1 rounded border border-border-dark px-1.5 text-[10px] text-text-muted hover:text-text-dark disabled:opacity-45"
                disabled={!canWriteLyrics}
                title={t("node.audioGen.suno.writeLyricsHint")}
                onClick={onWriteLyrics}
              >
                {activeAction === "lyrics" ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <Wand2 className="h-3 w-3" />
                )}
                {t("node.audioGen.suno.writeLyrics")}
              </button>
            </div>
            <textarea
              className={`${TEXTAREA_CLASS} h-16`}
              value={lyrics}
              placeholder={t("node.audioGen.suno.lyricsPlaceholder")}
              onChange={(event) => onChange({ lyrics: event.target.value })}
            />
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-1.5">
        <span className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
          <Music2 className="h-3 w-3 shrink-0" />
          <span className="truncate" title={t("node.audioGen.suno.asyncHint")}>
            {t("node.audioGen.suno.pricePerCall", { price: SUNO_MUSIC_UNIT_PRICE })}
          </span>
        </span>
        <button
          type="button"
          className="nodrag flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          disabled={!canGenerate}
          title={invalid ? t(`node.audioGen.suno.${invalid}`) : undefined}
          onClick={onGenerate}
        >
          {activeAction === "generate" ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          {t("node.audioGen.suno.generate")}
        </button>
      </div>

      {/* 出片操作产出的是 MP4, 不是音频 —— 说清楚, 免得用户以为播放器坏了。 */}
      {spec.output === "video" && (
        <p className="text-[10px] leading-4 text-text-muted">{t("node.audioGen.suno.videoOutputHint")}</p>
      )}
      {invalid && <p className="text-[10px] leading-4 text-text-muted">{t(`node.audioGen.suno.${invalid}`)}</p>}

      {message && (
        <div
          className={`flex items-start gap-1 rounded border px-1.5 py-1 text-[10px] leading-4 ${
            message.tone === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          }`}
        >
          <span className="min-w-0 break-words">{message.text}</span>
        </div>
      )}
    </div>
  );
}
