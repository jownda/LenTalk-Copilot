import rawLibrary from "./mmxVoiceLibrary.json";

/**
 * MiniMax 官方系统音色 —— **327 条**，全部来自官方文档「系统音色列表」，平台确认支持。
 *
 * 数据来源（2026-09 抓取的快照，落盘为同目录下的 `mmxVoiceLibrary.json`）：
 * - `https://platform.minimaxi.com/docs/faq/system-voice-id`（官方文档「系统音色列表」327 条，
 *   **这是 API `voice` 取值域的权威清单**）
 * - `POST https://www.minimax.cn/v1/api/audio/voice/list`（官方音色库 603 条）—— 只用来给
 *   交集里的 283 条补**官方描述 + 试听 MP3**；它独有的 320 条**已裁掉**，实跑证明平台不认
 *   （`Voice not found`，音色库是海螺音频产品的表 ≠ API 取值域，见 docs §9.4）。
 *   44 条 v1 老音色只在文档里有 → 标 `legacy`（无描述无试听，保留为兼容存量节点）。
 *
 * **为什么要把整张表搬进来**：`speech-2.8` 的试听以前要么没有、要么得现场跑一次合成（按字符
 * 计费）。官方每个音色都自带一条 MP3 试听，直接播它即可 —— 零成本、零等待，也不用为「听一下」
 * 付钱。所以这里存的是 **URL**，不落盘音频。
 *
 * **id 就是 `speech-2.8` 的 `voice` 值**（官方叫 `uniq_id`，形如 `Chinese_wenrounvxing`）。
 */
export interface MmxSystemVoice {
  /** 官方音色 id（`uniq_id`）—— 直接作为 `speech-2.8` 的 `voice` 值。 */
  id: string;
  /** 短名，如「治愈博主」。 */
  name: string;
  /** 风格关键词，如「柔和,舒缓,治愈」（列表行的灰色副标题）。 */
  style: string;
  /** 官方描述。用来说明「这个声音是什么样」；仅 legacy 为空。 */
  desc: string;
  gender: "male" | "female";
  age: "儿童" | "青年" | "中年" | "老年";
  /** 语言，如「中文-普通话」「英语」。 */
  lang: string;
  /** 口音，如「标准口音」「英语-美音」。 */
  accent: string;
  /** 适用场景，如「播客与社媒」「有声书与小说」。 */
  scenes: string[];
  /** 官方试听 MP3（公开 CDN）。为空 = 该音色官网没有样本（只有 `legacy` 会为空）。 */
  sample: string;
  /** 仅文档收录、官方音色库里没有：无描述、无试听，保留只为兼容存量节点。 */
  legacy?: boolean;
}

export const MMX_SYSTEM_VOICES = rawLibrary as MmxSystemVoice[];

/** 按 id 查一条音色（音色 id 是主键，表内唯一）。 */
const BY_ID = new Map(MMX_SYSTEM_VOICES.map((voice) => [voice.id, voice]));

export function findMmxSystemVoice(id: string): MmxSystemVoice | undefined {
  return BY_ID.get(id);
}

export function isMmxSystemVoiceId(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * 分组：**女声 / 男声 / 童声**。
 *
 * 「童声」按年龄轴切（`age === "儿童"`）而不是性别轴 —— 童声里男女都有，但用户找音色时
 * 先想的是「要个小孩子的声音」，性别是次要的。
 */
export const MMX_VOICE_GROUPS = ["female", "male", "child"] as const;
export type MmxVoiceGroup = (typeof MMX_VOICE_GROUPS)[number];

export function mmxVoiceGroupOf(voice: MmxSystemVoice): MmxVoiceGroup {
  if (voice.age === "儿童") return "child";
  return voice.gender;
}

/** 默认语言 —— 打开就是中文，符合中文用户的第一诉求。 */
export const MMX_DEFAULT_LANGUAGE = "中文-普通话";

/**
 * 语言下拉的排序：常用语言按固定顺序排前面，其余按音色数量降序。
 * 固定的那几个是「中文用户真的会去挑」的，纯按数量排会把粤语、日语压到很后面。
 */
const LANGUAGE_PRIORITY = [
  "中文-普通话",
  "中文-粤语",
  "英语",
  "日语",
  "韩语",
  "西班牙语",
  "葡萄牙语",
  "法语",
  "德语",
  "俄语",
  "意大利语",
  "阿拉伯语",
  "泰语",
  "越南语",
  "印尼语",
  "印地语",
];

export const MMX_VOICE_LANGUAGES: string[] = (() => {
  const counts = new Map<string, number>();
  for (const voice of MMX_SYSTEM_VOICES) {
    counts.set(voice.lang, (counts.get(voice.lang) ?? 0) + 1);
  }
  const rest = [...counts.keys()]
    .filter((lang) => !LANGUAGE_PRIORITY.includes(lang))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  return [...LANGUAGE_PRIORITY.filter((lang) => counts.has(lang)), ...rest];
})();

/** 某个语言下的音色，顺序沿用数据文件里排好的（男 → 女 → 童，组内有试听的在前）。 */
export function mmxVoicesForLanguage(lang: string): MmxSystemVoice[] {
  if (!lang) return MMX_SYSTEM_VOICES;
  return MMX_SYSTEM_VOICES.filter((voice) => voice.lang === lang);
}

/**
 * 官方音色的试听源：**内置官方样本优先**，其次本地保存的「上次生成」音频。
 *
 * 44 条 legacy 音色没有官方试听 —— 但只要用它合成过一次，生成结果本来就落了盘
 * （`persistAudioBytes` → 应用素材目录），把那份路径记进 settingsStore 的
 * `systemVoicePreviews`，下次就能直接试听，不用再花一次合成的钱。
 * 两者都没有就返回空串 → UI 不渲染试听键（绝不退化成现场合成，那要按字符计费）。
 */
export function resolveMmxVoicePreview(voice: MmxSystemVoice, savedPreviews: Record<string, string>): string {
  return voice.sample || savedPreviews[voice.id] || "";
}

/** 该音色是否值得在合成成功后收编为本地试听（有官方样本的不用收）。 */
export function shouldCaptureMmxVoicePreview(voice: MmxSystemVoice | undefined): boolean {
  return Boolean(voice && !voice.sample);
}
