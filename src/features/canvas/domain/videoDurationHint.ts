import type { VideoModelDefinition } from '@/features/canvas/models';

/**
 * 从文案里识别「明确写出的视频时长」，并落到目标模型允许的档位上。
 *
 * 背景：点「生成并创建视频」时，下游 AI 视频节点的时长默认沿用「上次使用」的
 * 值（`settings.lastVideoDuration`，在 nodeRegistry 的 `createDefaultData` 里赋值）。
 * 但文案里已经写明秒数时（例如故事梗概写「时长10秒」或「时间：00:00-00:10」），
 * 用户显然期望节点直接用这个秒数，而不是去翻「上次用了多少秒」。
 *
 * 两条硬约束（与需求一致）：
 * 1. 文案里**没有**明确秒数 → 返回 null，调用方保持节点默认值不动。
 * 2. 模型**只支持固定时长**（`durationOptions` 只有一个值，例如 veo 恒为 8 秒、
 *    知鸟 tj-sp2.5 恒为 30 秒）→ 同样返回 null，不去改一个改不出效果的值。
 *
 * 支持的两类写法（用户习惯）：
 * - 秒数式：`时长10秒` / `时长：10秒` / `视频时长 8 秒` / `duration: 8s`
 * - 时间码式：`时间：00:00-00:10` / `时间码 0:05–0:15` / `时间：00:10`
 *
 * 判定顺序是「先看明确性，再谈位置」：明确的声明（`时间：00:00-00:04` / `时长10秒`）
 * 全篇任何位置都认；只有信息不足时（裸秒数、或多处时长互相冲突）才收窄到文案
 * 开头区域去定位 —— 那里才是场记位置。
 */

/** 合法时长区间：小于 1 秒没有意义，大于 10 分钟通常是文案里的其它数字。 */
const MIN_SECONDS = 1;
const MAX_SECONDS = 600;

/** `MM:SS` 或 `H:MM:SS` 形式的时间码。 */
const TIMECODE = String.raw`\d{1,3}:\d{2}(?::\d{2})?`;

/**
 * 「这是在说这条片子的时间信息」的引导词。必须带引导词才认时间码，理由见
 * `DURATION_RULES` 第 2 条的注释。
 *
 * 长词写在前面：正则的 alternation 是「先匹配先赢」，`时间` 会抢走 `时间码`
 * 的开头，导致 `时间码：0:00-0:10` 整体匹配失败。
 */
const LEADING = [
  '总片长',
  '总时长',
  '视频时长',
  '成片时长',
  '片长',
  '时长',
  '时间码',
  '时间范围',
  '时间',
  'duration',
  'length',
  'timecode',
].join('|');

/** 区间连接符：连字符 / en dash / em dash / 数学与全角减号 / 波浪号 / 中文「到、至」/ 英文 to。 */
const RANGE_JOIN = String.raw`(?:[-–—−－~～]|至|到|to)`;

/**
 * 引导词与数值之间允许出现的连接成分，例如「时长为 10 秒」「时间：」。
 *
 * 刻意**不含**「约 / 大约」：那是模糊估计的措辞（正文里「时长约3秒后切到特写」），
 * 不构成明确声明，让这句话落到弱信号规则、按开头位置判定。
 */
const LEADING_SEP = String.raw`\s*(?:为|是|[:：=])?\s*`;

/** 秒数单位，长单位写在前面避免被 `s` 截断（`seconds` 不能被当成 `s` + `econds`）。 */
const SECONDS_UNIT = String.raw`(?:秒钟?|sec(?:ond)?s?|s\b)`;

/**
 * `MM:SS` / `H:MM:SS` 转秒数。非法输入返回 null。
 * 用「逐段乘 60 再相加」统一处理 2 段与 3 段，避免写两次公式。
 */
function timecodeToSeconds(value: string): number | null {
  const parts = value.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const numbers = parts.map((piece) => Number.parseInt(piece, 10));
  if (numbers.some((part) => !Number.isFinite(part))) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

/**
 * 「文案开头」的区域：从开头到**第一个句末标点**（可跨行），另加字符上限兜底。
 *
 * 这块区域只在**信息不足**时才用来定位时长（见 `extractDurationSeconds`）：
 * - 裸秒数这类弱信号（`停顿 3 秒`）—— 只在开头认，那里才是场记位置；
 * - 多处互相冲突的时长（逐镜时间轴）—— 用开头那一处来定。
 * 明确的声明（`时间：00:00-00:04` / `时长10秒`）不受它约束。
 *
 * 划分依据是句末标点而不是换行。用户的剧本表头本来就是多行的：
 *
 * ```
 * # 第1集
 * 1-1场 日 内 卧室
 * 时间：00:00-00:04     ← 在第 3 行，但仍在第一个句号之前
 * 人物：女子，老人
 * 场面调度：…；…          ← 第一个「；」在这里
 * ```
 *
 * 所以换行不能当边界，否则 `时间：` 会被判成「不在开头」。逗号同样不算边界：
 * `雨季街头，5秒的视频` 这种把时长跟在短句后面的写法仍属于开头。
 */
const HEAD_CHAR_LIMIT = 200;
const SENTENCE_STOPS = ['。', '；', ';', '！', '!', '？', '?'];

function headRegionEnd(text: string): number {
  let end = text.length;
  for (const stop of SENTENCE_STOPS) {
    const index = text.indexOf(stop);
    if (index >= 0 && index < end) end = index;
  }
  return Math.min(end, HEAD_CHAR_LIMIT);
}

/**
 * `explicit`（默认）：**明确声明** —— 带引导词（`时间：` / `时长`）或时间码形式。
 * 这种写法本身就说明「这是这条片子的时长」，全篇任何位置都认，不再被位置收窄。
 *
 * `weak`：**弱信号** —— 裸秒数（`5秒` / `12 seconds`）。这类数字太容易是别的东西
 * （正文里的「停顿 3 秒」、「镜头 01（0-15秒）」），只在文案开头区域内认。
 */
type DurationRuleStrength = 'explicit' | 'weak';

interface DurationRule {
  re: RegExp;
  /** 由匹配结果算出秒数；返回 null 表示这条匹配不算数。 */
  seconds: (match: RegExpMatchArray) => number | null;
  /** 省略即 `explicit`。 */
  strength?: DurationRuleStrength;
}

/**
 * 按优先级排列的识别规则，越靠前越「明确在说这条片子多长」。
 *
 * 顺序上的两个刻意安排：
 * - 带引导词的秒数（`时长10秒`）排第一，它最不容易误伤；
 * - 带引导词的时间码区间（`时间：00:00-00:10`）排在裸秒数之前。
 *
 * 除最后两条裸秒数外都是 `explicit`（明确声明），全篇任何位置都认；
 * 位置约束只在 `extractDurationSeconds` 里对弱信号与多处冲突生效。
 *
 * 不含后行断言 lookbehind：老版本 WKWebView（Safari < 16.4）不支持，正则是
 * 解析期报错，会让整个 bundle 白屏。挡前导字符一律用前置字符类 `(?:^|[^…])`。
 */
const DURATION_RULES: readonly DurationRule[] = [
  // 「时长10秒」「时长：15 秒」「视频时长 8 秒」「时长10s」「duration: 8s」
  {
    re: new RegExp(`(?:${LEADING})${LEADING_SEP}(\\d+(?:\\.\\d+)?)\\s*${SECONDS_UNIT}`, 'gi'),
    seconds: (match) => Math.round(Number(match[1])),
  },
  // 「时间：00:00-00:10」「时间码 0:05–0:15」「时长 00:00 至 00:10」
  //
  // 必须带引导词，这是本条规则唯一的安全边界：编译器的最终提示词里本来就逐镜
  // 写着时间轴（`0:00–0:06 — 镜头 1`、`0:00–0:03：角色：动作`），裸露的
  // `MM:SS–MM:SS` 一律认会把**第一个镜头的长度**错当成整片时长。
  // 编译器输出里不存在「时间/时长」这类引导词，所以加了引导词就能干净区分。
  {
    re: new RegExp(
      `(?:${LEADING})${LEADING_SEP}(${TIMECODE})\\s*${RANGE_JOIN}\\s*(${TIMECODE})`,
      'gi',
    ),
    seconds: (match) => {
      const start = timecodeToSeconds(match[1]);
      const end = timecodeToSeconds(match[2]);
      if (start === null || end === null) return null;
      // 「00:05–00:15」是第 5 秒到第 15 秒，这条片子长 10 秒（取区间长度）。
      // 起止写反时退回终点；终点也是 0 才算无效（`00:00-00:00`）。
      const span = end - start;
      return span > 0 ? span : end > 0 ? end : null;
    },
  },
  // 「时间：00:00-10」起点写全时间码、终点只写秒数的简写。
  // 放在上一条之后：上一条已经在区间场景下自锁，不会把 `00:00` 单独取走。
  {
    re: new RegExp(
      `(?:${LEADING})${LEADING_SEP}(${TIMECODE})\\s*${RANGE_JOIN}\\s*(\\d{1,3})(?![\\d:])`,
      'gi',
    ),
    seconds: (match) => {
      const start = timecodeToSeconds(match[1]);
      const end = Number.parseInt(match[2], 10);
      if (start === null || !Number.isFinite(end)) return null;
      const span = end - start;
      return span > 0 ? span : end > 0 ? end : null;
    },
  },
  // 「时间：00:10」单个时间码（必须带冒号/等号，否则 `时间 10` 这类歧义写法会被误认）
  //
  // 尾部的负向前瞻是关键：它让本规则在「后面还跟着一个区间」时整体失效，
  // 否则 `时间：00:06-00:15` 会被它从内部截出 `00:06`，把镜头长度当成整片时长。
  {
    re: new RegExp(
      `(?:${LEADING})\\s*[:：=]\\s*(${TIMECODE})(?!\\s*${RANGE_JOIN}\\s*${TIMECODE})`,
      'gi',
    ),
    seconds: (match) => timecodeToSeconds(match[1]),
  },
  // 「时长：10」省略单位的写法。只允许「片长/时长」类引导词 + 冒号，且后面不能
  // 紧跟其它量词（「时长：10分钟」里的 10 是分钟，不是秒）。
  //
  // 字符类里的 `\d` 不能省：`\d+` 匹配失败时会回溯成只吃一位数字（`10分钟` 退成
  // `1` + 前瞻看到 `0`），少了它就会把分钟数截成一位秒数。
  {
    re: /(?:总片长|总时长|视频时长|成片时长|片长|时长)\s*[:：=]\s*(\d+(?:\.\d+)?)\s*(?![秒分小百时个年月周天日次遍\d])/gi,
    seconds: (match) => Math.round(Number(match[1])),
  },
  // 「8秒的视频 / 8 秒长（短片 / 影片 / 成片 / 片子）」
  {
    re: /(\d+(?:\.\d+)?)\s*(?:秒钟?|sec(?:ond)?s?)\s*(?:的|长)?\s*(?:视频|短片|影片|成片|片子)/gi,
    seconds: (match) => Math.round(Number(match[1])),
  },
  // 裸「8秒」：只认整数（小数大多来自 beat 时间轴 `0.0–6.0 秒`），并用前置字符类
  // 挡掉紧凑数字与序数（`第 3 秒` 是时间点，不是成片长度）。属于弱信号，
  // 只在文案开头区域里认。
  {
    re: /(?:^|[^\d.第])(\d+)\s*秒钟?/g,
    seconds: (match) => Math.round(Number(match[1])),
    strength: 'weak',
  },
  // 裸 "8 seconds"
  {
    re: /(?:^|[^\d.])(\d+)\s*(?:seconds?|secs?)\b/gi,
    seconds: (match) => Math.round(Number(match[1])),
    strength: 'weak',
  },
];

/**
 * 取出文案里第一个「明确」的秒数（取整）。
 * 找不到、或落在合法区间外（含 0）时返回 null。
 *
 * 判定顺序（需求：明确的就用，不明确的不猜）：
 * 1. **明确声明**（`时间：00:00-00:04` / `时长10秒`）—— 全篇任何位置都认，
 *    值唯一就直接采用，不再被位置收窄；
 * 2. 同一段文案里出现**多处不同的**时长（逐镜时间轴）—— 这时才收窄，
 *    取开头区域里的第一处；
 * 3. **弱信号**（裸秒数 `5秒`）—— 只在开头区域里认。
 */
export function extractDurationSeconds(text: string | null | undefined): number | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const headEnd = headRegionEnd(text);
  for (const rule of DURATION_RULES) {
    const matches: { seconds: number; start: number }[] = [];
    for (const match of text.matchAll(rule.re)) {
      const seconds = rule.seconds(match);
      if (seconds === null || !Number.isFinite(seconds)) continue;
      if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) continue;
      matches.push({ seconds, start: match.index ?? 0 });
    }
    if (matches.length === 0) continue;

    // 弱信号：裸数字太容易是别的意思（「停顿 3 秒」「镜头 01（0-15秒）」），
    // 只在开头区域里认，别处一律不算。
    if (rule.strength === 'weak') {
      const head = matches.find((item) => item.start < headEnd);
      if (!head) continue;
      return head.seconds;
    }

    // 明确声明：值唯一就直接采用，不受位置限制 —— 场记式的表头本来就可以跨好几行。
    if (new Set(matches.map((item) => item.seconds)).size === 1) {
      return matches[0].seconds;
    }

    // 多处不同的时长（逐镜写的时间轴）：判断不出哪一处是整片长度，这才收窄到
    // 开头区域取第一处；开头也没有就换下一条规则。
    const head = matches.find((item) => item.start < headEnd);
    if (head) return head.seconds;
  }
  return null;
}

/**
 * 把显式秒数落到模型允许的档位上。
 *
 * 模型的 `durationOptions` 是平台按模型校验的**真实枚举**（见 registry.ts 的
 * `resolveZhiniaoVideoOptions` / `resolveBinghuoVideoOptions`），传枚举外的值会被
 * 平台拒掉，所以这里不能简单地只做 min/max 夹取：
 * - 连续档位（例如 4,5,6,…,15）→ 夹到区间内即可；
 * - 离散档位（例如 seedance 的 4,5,6,8,10,12,15,20,25,30）→ 取最接近的合法档；
 * - 只有一个档位 → 固定时长模型，返回 null 表示「不改」。
 */
export function snapDurationToModelOptions(
  model: VideoModelDefinition | undefined,
  seconds: number
): number | null {
  const options = model?.durationOptions ?? [];
  if (options.length === 0) return null;
  const minimum = options[0];
  const maximum = options[options.length - 1];
  if (minimum === maximum) return null;
  const clamped = Math.max(minimum, Math.min(maximum, Math.round(seconds)));
  const contiguous = options.every((value, index) => index === 0 || value === options[index - 1] + 1);
  if (contiguous) return clamped;
  return options.reduce((best, value) =>
    Math.abs(value - clamped) < Math.abs(best - clamped) ? value : best,
  );
}

/**
 * 文案 → 目标模型可用的时长。
 * 返回 null 表示「不要改节点默认值」（没写秒数 / 模型固定时长 / 模型无时长能力）。
 */
export function resolveVideoDurationHint(
  model: VideoModelDefinition | undefined,
  text: string | null | undefined
): number | null {
  const seconds = extractDurationSeconds(text);
  if (seconds === null) return null;
  return snapDurationToModelOptions(model, seconds);
}

/**
 * 多段文案按顺序找：生成出来的提示词优先，其次是用户自己写的故事梗概 / 风格。
 * Agent 的输出语言未必带上用户原话里的秒数，所以两处都看一遍。
 */
export function resolveVideoDurationHintFromTexts(
  model: VideoModelDefinition | undefined,
  texts: readonly (string | null | undefined)[]
): number | null {
  for (const text of texts) {
    const resolved = resolveVideoDurationHint(model, text);
    if (resolved !== null) return resolved;
  }
  return null;
}
