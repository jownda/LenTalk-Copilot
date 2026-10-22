/**
 * 知鸟AI · Suno 音乐链路（`music` 模型）协议模块。
 *
 * 事实来源（2026-09-20 实测，全部**免鉴权**可复核）：
 *   - `GET https://cuai.token6688.com/v1/logical-models` → `models[].param_schema`
 *     是**权威字段表**（12 个字段，见下）
 *   - `GET https://cuai.token6688.com/api/v1/models` → 价格元数据
 *     （`unit_price_micro_usd = 171429`、`billing_unit = per_request`）
 *   - 无 key 探测：`/v1/audio/speech` `401` ✓、`/v1/audio/speech/async` `401` ✓、
 *     `GET /v1/tasks/{id}` `401` ✓；`/v1/audio/music` **`404`** ✗
 *
 * **本项目旧实现走的正是那条不存在的 `/v1/audio/music`**，且请求体是字子动画的
 * `metadata{lyrics_text, music_length_ms}` —— 所以这个页面的音乐生成一直是打不通的。
 *
 * 与 MiniMax 链路的三处关键差异：
 *   1. **异步**。Suno 出歌中位 60–120 秒，走 `POST /v1/audio/speech/async` 拿
 *      `task_id`，再 `GET /v1/tasks/{task_id}` 轮询到终态取 CDN URL。
 *   2. **没有 `voice` 字段**。声线由 `vocal_gender`(`auto|m|f`) 控制，音色由
 *      `style` 风格标签间接影响。旧 UI 给的「演唱音色」下拉平台根本不认。
 *   3. **没有 `music_length_ms`**。曲长由模型决定，不能指定（那是字子动画的字段）。
 *
 * 计费：按次 ⚡0.171429（`per_request`，与提交次数挂钩，与时长/字符无关）。
 */

/** 平台侧模型名。**必须精确匹配** —— 见下方 `resolveSunoMusicOperation` 的顺序说明。 */
export const SUNO_MUSIC_MODEL = "music";

/** 音乐生成与语音合成**共用**同一个端点，靠 `model` 分流。 */
export const SUNO_AUDIO_PATH = "/v1/audio/speech";
/** 异步入口：返回 `task_id` 而非音频字节。 */
export const SUNO_ASYNC_PATH = "/v1/audio/speech/async";

/** 网关统一的任务查询端点（与提交路径不同，别拼成 `/v1/audio/speech/{id}`）。 */
export function resolveSunoTaskPath(taskId: string): string {
  return `/v1/tasks/${encodeURIComponent(taskId)}`;
}

/** 文档「建议每 3 秒轮询一次」。 */
export const SUNO_POLL_INTERVAL_MS = 3000;
/** 平台的 `max_prompt_chars`。 */
export const SUNO_MAX_PROMPT_CHARS = 5000;
/** 按次计费单价（⚡，即 USD）。 */
export const SUNO_MUSIC_UNIT_PRICE = 0.171429;
/** 平台原始计费单位：1e-6 USD / 次。 */
export const SUNO_MUSIC_UNIT_PRICE_MICRO_USD = 171429;

// ---------------------------------------------------------------------------
// operation（8 种，照抄 param_schema 的 enum 与顺序）
// ---------------------------------------------------------------------------

export type SunoOperation = "generate" | "extend" | "cover" | "lyrics" | "stems" | "stems_all" | "mp4" | "concat";

export const SUNO_OPERATIONS: SunoOperation[] = [
  "generate",
  "extend",
  "cover",
  "lyrics",
  "stems",
  "stems_all",
  "mp4",
  "concat",
];

export const SUNO_DEFAULT_OPERATION: SunoOperation = "generate";

/** 该操作消费哪个「源 clip」字段；`null` = 不吃已生成的曲子（纯生成）。 */
export type SunoClipSource = "clip_id" | "continue_clip_id" | "cover_clip_id" | null;

export interface SunoOperationSpec {
  /** 源 clip 字段名，`null` 表示不需要。 */
  clipSource: SunoClipSource;
  /** 是否需要 `input`（主题 / 描述）。 */
  needsPrompt: boolean;
  /** `version` / `mode` / `style` / `lyrics` / `title` / `vocal_gender` / `negative_tags` 是否生效。 */
  usesSongParams: boolean;
  /** 产出物类型。`mp4` 出的是**视频文件**，不是音频。 */
  output: "audio" | "video" | "text";
  /** 是否产出多条音轨（分离类当前只落第一条，见 `extractSunoFileUrls`）。 */
  multiTrack: boolean;
}

/**
 * 每个 operation 吃什么字段 —— 逐条对照 `param_schema.*.description`：
 *   - `clip_id`:        "operation=stems/stems_all/mp4/concat 必填"
 *   - `continue_clip_id`+`continue_at`: "operation=extend 必填 / 可选"
 *   - `cover_clip_id`:  "operation=cover 必填"
 *   - `lyrics`:         "operation=lyrics 需 prompt"（写出歌词**文本**，不产音频）
 */
export const SUNO_OPERATION_SPECS: Record<SunoOperation, SunoOperationSpec> = {
  generate: { clipSource: null, needsPrompt: true, usesSongParams: true, output: "audio", multiTrack: false },
  extend: {
    clipSource: "continue_clip_id",
    needsPrompt: false,
    usesSongParams: true,
    output: "audio",
    multiTrack: false,
  },
  cover: { clipSource: "cover_clip_id", needsPrompt: true, usesSongParams: true, output: "audio", multiTrack: false },
  lyrics: { clipSource: null, needsPrompt: true, usesSongParams: false, output: "text", multiTrack: false },
  stems: { clipSource: "clip_id", needsPrompt: false, usesSongParams: false, output: "audio", multiTrack: true },
  stems_all: { clipSource: "clip_id", needsPrompt: false, usesSongParams: false, output: "audio", multiTrack: true },
  mp4: { clipSource: "clip_id", needsPrompt: false, usesSongParams: false, output: "video", multiTrack: false },
  concat: { clipSource: "clip_id", needsPrompt: false, usesSongParams: false, output: "audio", multiTrack: false },
};

/**
 * 产出**媒体**的操作 —— 这是音乐页下拉里的 7 项。
 *
 * `lyrics` 单独摘出去：它的产出是歌词**文本**而不是音频/视频，做成「AI 写词」按钮
 * 挂在歌词框旁边（结果回填歌词框）才符合它的语义。混进下拉会让「生成」按钮
 * 在一个产出文本的操作上返回「媒体路径」。
 *
 * 必须定义在 `SUNO_OPERATION_SPECS` **之后** —— 它在模块初始化时就要读那张表。
 */
export const SUNO_MEDIA_OPERATIONS: SunoOperation[] = SUNO_OPERATIONS.filter(
  (operation) => SUNO_OPERATION_SPECS[operation].output !== "text",
);

/** operation 在 UI 上的名字（i18n key）。 */
export const SUNO_OPERATION_LABEL_KEYS: Record<SunoOperation, string> = {
  generate: "node.audioGen.suno.operations.generate",
  extend: "node.audioGen.suno.operations.extend",
  cover: "node.audioGen.suno.operations.cover",
  lyrics: "node.audioGen.suno.operations.lyrics",
  stems: "node.audioGen.suno.operations.stems",
  stems_all: "node.audioGen.suno.operations.stemsAll",
  mp4: "node.audioGen.suno.operations.mp4",
  concat: "node.audioGen.suno.operations.concat",
};

/** operation 的一句说明（i18n key），对应 param_schema 的 `options[].description`。 */
export const SUNO_OPERATION_HINT_KEYS: Record<SunoOperation, string> = {
  generate: "node.audioGen.suno.operationHints.generate",
  extend: "node.audioGen.suno.operationHints.extend",
  cover: "node.audioGen.suno.operationHints.cover",
  lyrics: "node.audioGen.suno.operationHints.lyrics",
  stems: "node.audioGen.suno.operationHints.stems",
  stems_all: "node.audioGen.suno.operationHints.stemsAll",
  mp4: "node.audioGen.suno.operationHints.mp4",
  concat: "node.audioGen.suno.operationHints.concat",
};

/**
 * 判定某个模型是否走 Suno 协议。
 *
 * **精确匹配**是有意的：`music-2.6` / `suno-v3` 这类名字在字子动画、FHL 上是
 * **另一套协议**（`metadata{lyrics_text, music_length_ms}` / OpenAI 兼容），
 * 靠 `/(?:music|suno)/` 这种宽匹配会把它们误判进 Suno 链路。
 * 知鸟的 Suno 模型 id 就是裸的 `music`，所以只认它。
 */
export function resolveSunoMusicOperation(model: string | undefined): SunoOperation | null {
  const normalized = (model ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized !== SUNO_MUSIC_MODEL && normalized !== "suno") return null;
  return SUNO_DEFAULT_OPERATION;
}

/** 该模型是不是 Suno 协议的模型。 */
export function isSunoMusicModel(model: string | undefined): boolean {
  return resolveSunoMusicOperation(model) !== null;
}

// ---------------------------------------------------------------------------
// 参数枚举（照抄 param_schema 的 enum / options，不要自己编档位）
// ---------------------------------------------------------------------------

/** `version` —— 官方自 2026-09-09 起只提供 V6 系列，v5/v4.5 是渠道专供旧引擎。 */
export const SUNO_VERSIONS = ["chirp-v6", "chirp-v6-mini", "chirp-v5", "chirp-v4-5"] as const;
export const SUNO_DEFAULT_VERSION = "chirp-v6";

export const SUNO_VERSION_LABEL_KEYS: Record<string, string> = {
  "chirp-v6": "node.audioGen.suno.versions.v6",
  "chirp-v6-mini": "node.audioGen.suno.versions.v6Mini",
  "chirp-v5": "node.audioGen.suno.versions.v5",
  "chirp-v4-5": "node.audioGen.suno.versions.v4_5",
};

/** `mode` —— 歌曲(含人声) / 纯音乐(器乐)。 */
export const SUNO_MODES = ["song", "instrumental"] as const;
export type SunoMode = (typeof SUNO_MODES)[number];
export const SUNO_DEFAULT_MODE: SunoMode = "song";

export const SUNO_MODE_LABEL_KEYS: Record<SunoMode, string> = {
  song: "node.audioGen.suno.modes.song",
  instrumental: "node.audioGen.suno.modes.instrumental",
};

/** `vocal_gender` —— **仅 song 模式有效**（param_schema 原文）。 */
export const SUNO_VOCAL_GENDERS = ["auto", "m", "f"] as const;
export type SunoVocalGender = (typeof SUNO_VOCAL_GENDERS)[number];
export const SUNO_DEFAULT_VOCAL_GENDER: SunoVocalGender = "auto";

export const SUNO_VOCAL_GENDER_LABEL_KEYS: Record<SunoVocalGender, string> = {
  auto: "node.audioGen.suno.vocalGenders.auto",
  m: "node.audioGen.suno.vocalGenders.male",
  f: "node.audioGen.suno.vocalGenders.female",
};

/** 把任意字符串收窄成合法枚举，非法值退回默认（节点里存的是自由 string）。 */
export function normalizeSunoVersion(value: string | undefined): string {
  const normalized = (value ?? "").trim();
  return (SUNO_VERSIONS as readonly string[]).includes(normalized) ? normalized : SUNO_DEFAULT_VERSION;
}

export function normalizeSunoMode(value: string | undefined): SunoMode {
  const normalized = (value ?? "").trim().toLowerCase();
  return (SUNO_MODES as readonly string[]).includes(normalized) ? (normalized as SunoMode) : SUNO_DEFAULT_MODE;
}

export function normalizeSunoVocalGender(value: string | undefined): SunoVocalGender {
  const normalized = (value ?? "").trim().toLowerCase();
  return (SUNO_VOCAL_GENDERS as readonly string[]).includes(normalized)
    ? (normalized as SunoVocalGender)
    : SUNO_DEFAULT_VOCAL_GENDER;
}

export function normalizeSunoOperation(value: string | undefined): SunoOperation {
  const normalized = (value ?? "").trim().toLowerCase();
  return (SUNO_OPERATIONS as readonly string[]).includes(normalized)
    ? (normalized as SunoOperation)
    : SUNO_DEFAULT_OPERATION;
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

export interface SunoMusicBodyInput {
  operation: SunoOperation;
  /** 主题 / 描述（灵感模式的 `gpt_description_prompt` 来源）。 */
  prompt?: string;
  version?: string;
  mode?: string;
  style?: string;
  lyrics?: string;
  title?: string;
  vocalGender?: string;
  negativeTags?: string;
  clipId?: string;
  continueClipId?: string;
  continueAt?: string;
  coverClipId?: string;
}

/** 按 operation 决定必填的源 clip 字段名（`null` = 不需要）。 */
export function requiredSunoClipField(operation: SunoOperation): SunoClipSource {
  return SUNO_OPERATION_SPECS[operation].clipSource;
}

/**
 * 组装音乐请求体。
 *
 * 形状是**顶层扁平**（与 speech 同端点、同风格），不是字子动画那种
 * `metadata{...}` 信封 —— 这是本次修正的核心。
 *
 * `input` 沿用同一端点上已验证过的文本字段名（speech-2.8 走的就是它）。
 * 音乐侧的信封形状尚未实跑确认，见 docs/api_docs/ZhiniaoAI_Suno_Music_Chain.md。
 */
export function buildSunoMusicBody(apiModel: string, input: SunoMusicBodyInput): Record<string, unknown> {
  const spec = SUNO_OPERATION_SPECS[input.operation];
  const body: Record<string, unknown> = { model: apiModel, operation: input.operation };

  const prompt = input.prompt?.trim();
  if (prompt) body.input = prompt;

  if (spec.usesSongParams) {
    body.version = normalizeSunoVersion(input.version);
    const mode = normalizeSunoMode(input.mode);
    body.mode = mode;

    const style = input.style?.trim();
    if (style) body.style = style;
    const lyrics = input.lyrics?.trim();
    if (lyrics) body.lyrics = lyrics;
    const title = input.title?.trim();
    if (title) body.title = title;
    const negativeTags = input.negativeTags?.trim();
    if (negativeTags) body.negative_tags = negativeTags;

    // param_schema 原文: 「歌曲模式下控制演唱者声线 (纯音乐模式无效)」——
    // 纯器乐时不要发这个字段, 免得平台按「有人声」误判。
    if (mode === "song") body.vocal_gender = normalizeSunoVocalGender(input.vocalGender);
  }

  if (spec.clipSource === "clip_id") {
    const clipId = input.clipId?.trim();
    if (clipId) body.clip_id = clipId;
  }
  if (spec.clipSource === "continue_clip_id") {
    const sourceClipId = input.continueClipId?.trim();
    if (sourceClipId) body.continue_clip_id = sourceClipId;
    const continueAt = input.continueAt?.trim();
    // 「不传默认从结尾续」，所以只在实际填了数值时才带。
    if (continueAt && Number.isFinite(Number(continueAt))) body.continue_at = continueAt;
  }
  if (spec.clipSource === "cover_clip_id") {
    const coverClipId = input.coverClipId?.trim();
    if (coverClipId) body.cover_clip_id = coverClipId;
  }

  return body;
}

/**
 * 提交前的本地校验 —— 缺必填就**别发请求**。
 *
 * 平台的鉴权在参数校验之前（无 key 一律 401），拿不到字段级报错，
 * 所以这些检查只能放在客户端，否则用户只会看到一次扣费 + 一条看不懂的失败。
 */
export function validateSunoMusicInput(input: SunoMusicBodyInput): string | null {
  const spec = SUNO_OPERATION_SPECS[input.operation];
  const clipSource = spec.clipSource;
  if (clipSource === "clip_id" && !input.clipId?.trim()) {
    return "needClipId";
  }
  if (clipSource === "continue_clip_id" && !input.continueClipId?.trim()) {
    return "needContinueClipId";
  }
  if (clipSource === "cover_clip_id" && !input.coverClipId?.trim()) {
    return "needCoverClipId";
  }
  if (spec.needsPrompt && !input.prompt?.trim()) {
    return "needPrompt";
  }
  return null;
}

// ---------------------------------------------------------------------------
// 响应解析（形状未实跑确认，故写得尽量宽容）
// ---------------------------------------------------------------------------

const SUNO_IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#]|$)/i;
const SUNO_VIDEO_EXTENSION = /\.(?:mp4|mov|webm|mkv)(?:[?#]|$)/i;

interface SunoUrlCandidate {
  url: string;
  path: string;
}

/** 深度遍历，收集负载里所有 http(s) / data:audio 串，并记下它们所在的字段路径。 */
function collectSunoUrls(payload: unknown): SunoUrlCandidate[] {
  const found: SunoUrlCandidate[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      const direct = /^data:audio\/[a-z0-9.+-]+;base64,[^\s"']+$/i.test(trimmed) ? trimmed : "";
      const embedded = /https?:\/\/[^\s"'\\)\]},]+/i.exec(trimmed)?.[0] ?? "";
      const hit = direct || embedded;
      if (!hit || seen.has(hit)) return;
      seen.add(hit);
      found.push({ url: hit, path });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  };
  visit(payload, "");
  return found;
}

/**
 * 从任务响应里挑出产出文件 URL，**按可信度排序**。
 *
 * 为什么要排序：Suno 的结果里音频、封面图、甚至 12 条分轨可能同时出现，
 * 通用的「取第一个 http 串」会拿到封面图。这里按
 * 「扩展名 + 字段路径线索」打分，图片直接判负分并剔除。
 *
 * 分离类操作（`stems` / `stems_all`）返回多条 —— 当前上层只消费第一条，
 * 且优先人声轨（字段路径含 `vocal` 的加分）。
 */
export function extractSunoFileUrls(payload: unknown, options?: { wantsVideo?: boolean }): string[] {
  const wantsVideo = options?.wantsVideo ?? false;
  const score = (candidate: SunoUrlCandidate): number => {
    if (SUNO_IMAGE_EXTENSION.test(candidate.url)) return -100;
    const isVideo = SUNO_VIDEO_EXTENSION.test(candidate.url);
    let value = wantsVideo ? (isVideo ? 50 : -20) : isVideo ? -20 : 10;
    if (/vocal/i.test(candidate.path)) value += 6;
    if (/audio|song|music|mp3|track|output/i.test(candidate.path)) value += 5;
    if (/instrumental|karaoke|accompaniment/i.test(candidate.path)) value += 2;
    if (/image|cover|thumb|poster|artwork/i.test(candidate.path)) value -= 30;
    return value;
  };
  return collectSunoUrls(payload)
    .map((candidate) => ({ candidate, value: score(candidate) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.candidate.url);
}

/** 任务 ID：`task_id` / `id`。网关成功响应是 `{ task_id, status }` 这一族。 */
export function extractSunoTaskId(payload: unknown): string | null {
  if (typeof payload === "number" && Number.isFinite(payload)) return String(payload);
  if (typeof payload === "string" && payload.trim() && !/^https?:/i.test(payload.trim())) return payload.trim();
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractSunoTaskId(item);
      if (nested) return nested;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["task_id", "taskId", "id", "job_id", "jobId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  for (const key of ["data", "detail", "result", "task", "output"]) {
    const nested = extractSunoTaskId(record[key]);
    if (nested) return nested;
  }
  return null;
}

/** 任务终态。文档「轮询响应」一节：`state` 取 `success|failed`，`status` 取 `completed|failed`。 */
const SUNO_FAILURE_STATES = ["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"];

export function isSunoFailureState(status: string): boolean {
  return SUNO_FAILURE_STATES.includes(status.toUpperCase());
}

export function readSunoTaskStatus(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["state", "status", "task_status"]) {
    if (typeof record[key] === "string") return record[key].toUpperCase();
  }
  for (const key of ["data", "detail", "result", "task"]) {
    const nested = readSunoTaskStatus(record[key]);
    if (nested) return nested;
  }
  return "";
}

/** 从失败响应里捞出可读原因。 */
export function extractSunoErrorMessage(payload: unknown): string {
  if (typeof payload === "string") return payload.trim().slice(0, 300);
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const message = extractSunoErrorMessage(item);
      if (message) return message;
    }
    return "";
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error_message", "errorMessage", "message", "msg", "reason", "detail", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
    if (value && typeof value === "object") {
      const nested = extractSunoErrorMessage(value);
      if (nested) return nested;
    }
  }
  return "";
}

/**
 * 生成结果里的 **clip 标识**。
 *
 * 后处理操作（`extend` / `cover` / `stems` / `stems_all` / `mp4` / `concat`）都要拿
 * 上一次结果的 clip 当源，但 `generateAudio` 只返回媒体路径 —— 若不在这一层顺手把
 * clip 捞出来，用户就只能自己去平台复制，链路是断的。
 *
 * 字段名按 param_schema 的注释取（`continue_clip_id` 的说明是「原曲 clipId
 * (来自上次生成结果的 source_id)」），所以 `source_id` 优先。
 */
export function extractSunoClipId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractSunoClipId(item);
      if (nested) return nested;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["source_id", "sourceId", "clip_id", "clipId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  for (const key of ["data", "result", "task", "output", "clips"]) {
    const nested = extractSunoClipId(record[key]);
    if (nested) return nested;
  }
  return null;
}

/** 响应概况，失败时拼进错误信息便于排查（截断，避免刷屏）。 */
export function describeSunoResponse(payload: unknown): string {
  try {
    const text = JSON.stringify(payload);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return String(payload).slice(0, 600);
  }
}

/**
 * `operation=lyrics` 的产出是**歌词文本**，不是音频。
 *
 * 平台的 param_schema 把它的产出类型写成了 `enum` 之外的语义（「按主题生成歌词文本」），
 * 所以它不能走 `generateAudio` 那条「返回音频路径」的路 —— 由 UI 侧单独调用，
 * 把结果填回歌词框。
 */
export function extractSunoLyricsText(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed && !/^https?:/i.test(trimmed) ? trimmed : null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractSunoLyricsText(item);
      if (nested) return nested;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["lyrics", "lyric", "lyrics_text", "text", "content", "output_text", "result_text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of ["data", "result", "output", "task", "detail"]) {
    const nested = extractSunoLyricsText(record[key]);
    if (nested) return nested;
  }
  return null;
}

/**
 * `validateSunoMusicInput` 语义 key 的中文兜底文案。
 *
 * UI 必须走 `SUNO_VALIDATION_MESSAGE_KEYS` 里的 i18n key（英文界面才不会混出中文）；
 * 这个函数只服务非 React 层（链路抛错时给出人能看懂的一句）。
 */
export const SUNO_VALIDATION_MESSAGES: Record<string, string> = {
  needClipId: "该操作需要源 clip —— 请先选一条已生成的音乐，或直接填写 clipId",
  needContinueClipId: "续写需要源 clip —— 请先选一条已生成的音乐，或直接填写 clipId",
  needCoverClipId: "翻唱需要源 clip —— 请先选一条已生成的音乐，或直接填写 clipId",
  needPrompt: "请先填写主题或描述",
};

/** 校验失败的中文兜底文案。 */
export function describeSunoValidation(failure: string): string {
  return SUNO_VALIDATION_MESSAGES[failure] ?? failure;
}

/**
 * 中文兜底文案；UI 必须走 i18n 模板，英文界面才不会混出中文。
 *
 * 返回值是 `validateSunoMusicInput` 的语义 key，不是最终文案。
 */
export const SUNO_VALIDATION_MESSAGE_KEYS: Record<string, string> = {
  needClipId: "node.audioGen.suno.needClipId",
  needContinueClipId: "node.audioGen.suno.needContinueClipId",
  needCoverClipId: "node.audioGen.suno.needCoverClipId",
  needPrompt: "node.audioGen.suno.needPrompt",
};
