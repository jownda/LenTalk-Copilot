import { chatCompletion } from "@/commands/ai";

/**
 * 文本节点「AI 修改」的核心逻辑。
 *
 * 抽出来是因为这段要能在**弹窗关闭后继续跑**：任务状态由 `textAiEditStore` 持有，
 * 弹窗只是它的一个视图。放在这里，store 与弹窗都不必各自维护一份提示词。
 */

export interface AiEditResult {
  text: string;
  assessment: string;
  issues: string[];
  changes: string[];
}

export const AI_EDIT_SYSTEM_PROMPT = `你是影视编剧和分镜连续性审校助手。你需要根据用户的自然语言要求修改一段文本，并对修改后的整段文本做逻辑审校。

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
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseAiEditResult(raw: string): AiEditResult {
  const cleaned = stripJsonFence(raw);
  try {
    const parsed = JSON.parse(cleaned) as Partial<AiEditResult>;
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return {
        text: parsed.text,
        assessment: typeof parsed.assessment === "string" ? parsed.assessment : "",
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.filter((item): item is string => typeof item === "string")
          : [],
        changes: Array.isArray(parsed.changes)
          ? parsed.changes.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
  } catch {
    // Some compatible endpoints ignore the JSON instruction. Keep their plain-text result usable.
  }
  return { text: cleaned, assessment: "", issues: [], changes: [] };
}

export function buildAiUserPrompt(
  text: string,
  instruction: string,
  preserveMarkdown: boolean
): string {
  return [
    "请修改下面的文本。",
    `用户修改要求：${instruction.trim()}`,
    preserveMarkdown
      ? "请保留原有 Markdown 标记和段落结构。"
      : "可以根据语义调整段落结构，但不要添加无关内容。",
    "",
    "原文：",
    text,
  ].join("\n");
}

export interface RunTextAiEditParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  text: string;
  instruction: string;
  preserveMarkdown: boolean;
  emptyResultMessage: string;
}

/**
 * 跑一次 AI 修改。不碰任何 React 状态 —— 调用方（store）自己决定怎么存结果，
 * 这样弹窗卸载也不会打断请求。
 */
export async function runTextAiEdit(params: RunTextAiEditParams): Promise<AiEditResult> {
  const raw = await chatCompletion(params.baseUrl, params.apiKey, params.model, [
    { role: "system", content: AI_EDIT_SYSTEM_PROMPT },
    { role: "user", content: buildAiUserPrompt(params.text, params.instruction, params.preserveMarkdown) },
  ]);
  const result = parseAiEditResult(raw);
  if (!result.text.trim()) {
    throw new Error(params.emptyResultMessage);
  }
  return result;
}
