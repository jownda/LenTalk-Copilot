/**
 * 音频反推提示词 —— 提示词文本与小节解析。
 *
 * 与图片反推（`reversePrompt.ts`）的分工一致：domain 只负责「对模型说什么」与
 * 「模型说的话怎么切块」，读文件、挑模型、发请求都在 application 层。
 *
 * 为什么输出是固定小节而不是纯一段提示词：
 *   音频里能拿到三类完全不同的东西 —— 音乐风格、歌词、台词。用户按「反推提示词」
 *   想要的往往只是其中一类（给 Suno 填风格、给配音节点填情绪、给字幕找台词）。
 *   固定小节让同一份结果既能整段塞进文本节点，也能被单独取用（`pickAudioReverseSection`）。
 */

export type AudioReverseLang = "zh" | "en";

/** 反推结果的小节名（中文原文是模型的输出锚点，不随界面语言变化）。 */
export const AUDIO_REVERSE_SECTIONS = [
  "类型",
  "风格标签",
  "情绪与速度",
  "乐器与编曲",
  "人声",
  "歌词",
  "台词",
  "音效与环境",
  "生成提示词",
] as const;

export type AudioReverseSection = (typeof AUDIO_REVERSE_SECTIONS)[number];

export function audioReverseSystemPrompt(lang: AudioReverseLang): string {
  if (lang === "en") {
    return [
      "You are LenTalk's audio reverse-engineer. You receive one audio clip — it may be a song, a voice-over, sound effects, or ambience — and you turn it into reusable creative material.",
      "",
      "Work through these in order:",
      "- Decide what it is: music (song/score) / speech (dialogue or narration) / sfx (effects, ambience) / mixed.",
      "- If music: give style tags in the vocabulary music platforms actually use (city pop, lo-fi hip hop, cinematic orchestral…), mood, tempo (estimated BPM), key and harmonic colour, lead instruments and arrangement layers, vocal gender and language, and structure (intro / verse / chorus…).",
      "- If there are lyrics: transcribe them line by line in the original language. Never translate, never invent. Mark unclear words with `?` instead of guessing.",
      "- If there is spoken dialogue: list each line as `[MM:SS] Speaker: line`, noting delivery and level (whisper / shouted / off-screen).",
      "- If there are effects: list the identifiable sound events in time order.",
      "",
      "Reply using exactly these section headings, each on its own line. Write `none` when a section does not apply — never drop a heading:",
      "",
      "【类型】",
      "【风格标签】",
      "【情绪与速度】",
      "【乐器与编曲】",
      "【人声】",
      "【歌词】",
      "【台词】",
      "【音效与环境】",
      "【生成提示词】",
    ].join("\n");
  }
  return [
    "你是 LenTalk 的音频反推器。你会收到一段音频（可能是歌曲、配乐、人声台词、音效或环境声），任务是把它反推成可以直接复用的创作素材。",
    "",
    "按顺序判断：",
    "- 先判断它是什么：music（歌曲/配乐）/ speech（人声台词或旁白）/ sfx（音效与环境）/ mixed（混合）。",
    "- 是音乐：给出风格标签（用音乐平台惯用的写法：city pop、lo-fi hip hop、cinematic orchestral…）、情绪、速度（BPM 估值）、调性与和声色彩、主奏乐器与编曲层次、人声性别与语言、结构（前奏/主歌/副歌…）。",
    "- 有歌词：逐句转写原文，保留原语言，不翻译、不编造。听不清的字用「?」占位，不要用推测填空。",
    "- 有人声台词：按 `[MM:SS] 说话人：台词` 逐句列出，并标出语气与音量（低语/喊叫/画外音）。",
    "- 有音效：按时间顺序列出可辨识的声音事件。",
    "",
    "严格按下面的小节输出，每行一个小节标题。某个小节不适用时写「无」，但不要省略小节标题：",
    "",
    "【类型】",
    "【风格标签】",
    "【情绪与速度】",
    "【乐器与编曲】",
    "【人声】",
    "【歌词】",
    "【台词】",
    "【音效与环境】",
    "【生成提示词】",
  ].join("\n");
}

export interface AudioReverseContext {
  /** 展示用的名字（节点标题或文件名），仅作上下文，不要写进结论。 */
  label: string;
  /** 时长（秒）；拿不到就传 0，由模型自己判断。 */
  durationSec?: number;
  lang: AudioReverseLang;
}

export function audioReverseUserMessage(context: AudioReverseContext): string {
  const duration =
    context.durationSec && context.durationSec > 0
      ? context.durationSec >= 60
        ? `${Math.round(context.durationSec)}s`
        : `${Math.round(context.durationSec * 10) / 10}s`
      : "";

  if (context.lang === "en") {
    return [
      `Analyse this audio clip${context.label ? ` (name: ${context.label})` : ""}${duration ? `, about ${duration} long` : ""}.`,
      "",
      "Make 【生成提示词】 a finished, paste-ready piece:",
      "- music → one descriptive sentence plus a comma-separated tag list (give both);",
      "- speech → a voice/style description usable for a TTS or voice-clone prompt.",
      "No preamble, no restating the task, no commentary outside the sections.",
    ].join("\n");
  }
  return [
    `请分析这段音频${context.label ? `（名称：${context.label}）` : ""}${duration ? `，时长约 ${duration}` : ""}。`,
    "",
    "【生成提示词】一节要写成可以直接粘贴使用的成品：",
    "- 音乐 → 一句描述性的话 + 逗号分隔的风格标签（两者都给）；",
    "- 台词 → 可直接用于配音/音色克隆的声线与情绪描述。",
    "不要开场白、不要复述任务、不要在小节之外加任何解释。",
  ].join("\n");
}

/**
 * 把模型输出切成小节。
 *
 * 模型偶尔会把标题写成 `[类型]`、`**类型**`、`类型：`，所以小节名后面允许再接
 * 右括号、冒号或星号；同一行里跟着的内容（`【风格标签】city pop`）归入该小节。
 * 认不出标题的内容归到上一节（宁可多一句，也不要丢词）。
 */
export function parseAudioReverseSections(text: string): Partial<Record<AudioReverseSection, string>> {
  const result: Partial<Record<AudioReverseSection, string>> = {};
  const names = AUDIO_REVERSE_SECTIONS.map((section) => section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // 只认固定的小节名，普通句子里的中文不会被误当标题（`match[1]` 一定是那 9 个之一）。
  const headingPattern = new RegExp(
    `^[\\s>*#-]*(?:【|\\[)?\\s*(${names.join("|")})\\s*(?:】|\\]|\\*\\*)?\\s*[:：]?\\s*(.*)$`,
  );
  let current: AudioReverseSection | null = null;
  const buffer: string[] = [];

  const flush = () => {
    if (!current) return;
    const body = buffer.join("\n").trim();
    // 同一小节出现两次时保留先出现的（模型有时会在结尾再复述一次标签）。
    if (!(current in result)) result[current] = body;
    buffer.length = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(headingPattern);
    const heading = match
      ? (AUDIO_REVERSE_SECTIONS.find((section) => section === match[1]) ?? null)
      : null;
    if (heading) {
      flush();
      current = heading;
      const inline = (match?.[2] ?? "").trim();
      if (inline) buffer.push(inline);
      continue;
    }
    if (current) buffer.push(rawLine);
  }
  flush();
  return result;
}

/** 取某一节；空 / 缺失 / 「无」都返回空串，调用方据此决定是否回填。 */
export function pickAudioReverseSection(
  text: string,
  section: AudioReverseSection,
): string {
  const body = parseAudioReverseSections(text)[section] ?? "";
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (/^(?:无|none|n\/a|不适用|—|-)$/i.test(trimmed)) return "";
  return trimmed;
}
