/**
 * AI Agent 可加载的 SKILL。
 *
 * 一个 SKILL 就是一份**强制输出规范**：`rules` 是 SKILL.md 正文全文，
 * 加载后整段进 system prompt，优先级高于 agent 的默认写作习惯。
 *
 * 数据来源不在这里 —— 每个 SKILL 一个同目录模块（由
 * `scripts/import-agent-skill.mjs` 从 SKILL.md 编译生成），
 * 再在 `index.ts` 的 `AGENT_SKILLS` 里登记。
 */
export interface AgentSkill {
  /** 稳定标识；持久化在会话上（`AgentSession.skillId`），改名不影响已加载的会话 */
  id: string;
  /** 面板与浮层上显示的短名 */
  name: string;
  /** 一句话简介，浮层里做副标题 */
  intro: string;
  /**
   * 缩略图 URL（可选）。
   *
   * 由导入脚本把 skill 目录里的图片复制到 `public/local-assets/agent-skills/`，
   * 在生成的数据里写成 `` `${import.meta.env.BASE_URL}local-assets/agent-skills/<slug>.<ext>` ``。
   * 目录里没有图片时为 `undefined` —— 面板会回退到「名字首字」的色块占位。
   */
  thumbnail?: string;
  /**
   * SKILL.md 正文全文。
   * ⚠️ 原样进 system prompt，**不要在这里做精简** —— 精简即等于替用户改了 skill 的规则。
   */
  rules: string;
}
