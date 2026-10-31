/**
 * AI Agent 的 SKILL 注册表。
 *
 * 新增一个 SKILL 只需两步：
 *   ① `node scripts/import-agent-skill.mjs "<skill 目录>"` → 生成 `skills/<slug>.ts`
 *   ② 在下面 `AGENT_SKILLS` 里加一行
 *
 * 顺序即浮层里的展示顺序，按需要排。
 */
import { realisticHumanPortraits } from "./realistic-human-portraits";
import { seedanceBuliangrenWuxia } from "./seedance-buliangren-wuxia";
import { tiangonxieyi } from "./tiangonxieyi";
import type { AgentSkill } from "./types";

export type { AgentSkill };

export const AGENT_SKILLS: AgentSkill[] = [
  tiangonxieyi,
  realisticHumanPortraits,
  seedanceBuliangrenWuxia,
];

/**
 * 按 id 取 SKILL。
 * 查不到（`null` / `undefined` / 指向已被删掉的 SKILL）一律返回 `null` ——
 * 会话里存的是 id 字符串，SKILL 被移除后旧会话必须能正常打开，而不是白屏。
 */
export function findAgentSkill(id: string | null | undefined): AgentSkill | null {
  if (!id) return null;
  return AGENT_SKILLS.find((skill) => skill.id === id) ?? null;
}

/**
 * 把 SKILL 规则接到基础 system prompt 后面。
 *
 * 措辞是刻意写强的：SKILL 是用户**手动加载**的强制规范，不是参考资料。
 * 不显式声明优先级与不可省略，模型很容易把它当成背景上下文，
 * 输出照旧按自己的习惯走 —— 那就等于没加载。
 */
export function composeAgentSystemPrompt(base: string, skill: AgentSkill | null): string {
  if (!skill) return base;
  return [
    base,
    "",
    `【已加载 SKILL：${skill.name}】`,
    "以下规则是本轮对话的强制输出规范，优先级高于你的默认写作习惯：",
    "- 严格按 SKILL 规定的结构、字段与数量输出，不得省略其中要求的内容" +
      "（例如每组图片提示词都必须配套对应的视频提示词）。",
    "- 与你的默认习惯冲突时以 SKILL 为准；SKILL 未覆盖的部分才按默认习惯处理。",
    "- 用户没有提供 SKILL 所需的输入时，按 SKILL 定义的方式引导补齐，不要自行假设后直接产出。",
    // SKILL 里常见「先让用户选模式/确认参数」的流程。没有这句，模型会把它当成寒暄跳过，
    // 一口气把整篇分镜写完 —— 用户就没机会选模式了。
    "- 若 SKILL 要求先让用户选择模式、确认参数或补齐信息，就先在回复里提问并**停下等待回复**，" +
      "不要替用户预设答案，也不要在提问的同一条消息里继续产出后续内容。",
    "- 不要复述、引用或解释这份 SKILL 本身，直接产出它要求的结果。",
    "",
    skill.rules.trim(),
  ].join("\n");
}
