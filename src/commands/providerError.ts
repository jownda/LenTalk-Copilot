/**
 * 上游（OpenAI 兼容中转 / 官方）失败响应的「人话化」。
 *
 * 背景：OpenAI 系推理模型（o 系、gpt-5 及更新的型号）会在**模型执行前**先跑一遍
 * 输入内容预检，命中即返回 `invalid_prompt`：
 *
 *   {"error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged
 *     as potentially violating our usage policy...","param":null,
 *     "type":"invalid_request_error"}}
 *
 * 它长得像参数 / 格式错误，本质却是**审核判定**。官方社区的一致反馈是：它和提示词
 * **长度**的相关性高于内容本身，并且**随模型 / 账号 / 时段波动** —— 同一段提示词换个
 * 模型、或者单纯再点一次，往往就能过。
 *
 * 所以直接把这串英文 JSON 丢给用户没有意义：既不说人话，也没告诉用户下一步该做什么。
 * 这里统一换成可执行的指引；真正的格式 / 鉴权 / 限流错误仍保持原始正文，方便排查。
 */

/** 上游输入内容预检拒绝的特征串（覆盖 code 与 message 两种写法）。 */
const UPSTREAM_PROMPT_POLICY_RE =
  /invalid_prompt|invalid prompt:|flagged as potentially violating|violating our usage policy|content[_ ]policy[_ ]violation/i;

/** 这段响应体是不是「上游输入内容预检拒绝」（可安全原样重试）。 */
export function isUpstreamPromptPolicyRejection(body: string): boolean {
  return UPSTREAM_PROMPT_POLICY_RE.test(body);
}

export interface ProviderFailureDescription {
  /** 原始响应体。 */
  raw?: string;
  /** 出错时正在调用的模型名，用于在提示里点名。 */
  model?: string;
}

/**
 * 把上游失败响应压成一句用户能照着做的中文。
 *
 * 非审核类失败保持既有的 `HTTP {status}：{原始正文}` 形状（正文截 300 字符），
 * 与各调用点原来的报错格式一致，不改变其它排错习惯。
 *
 * 审核类失败也**以 `HTTP {status}` 开头**：`classifyError` 靠这个前缀把错误归到
 * `http`，前缀一旦丢掉，同一个失败就会被归到 `other` 而触发本地模板回退 ——
 * 那是「上游审核拒绝」最不该走的分支（用户要的是 AI 提示词，不是模板）。
 */
export function describeProviderFailure(status: number, options: ProviderFailureDescription = {}): string {
  const raw = (options.raw ?? "").trim();
  if (!isUpstreamPromptPolicyRejection(raw)) {
    return `HTTP ${status}${raw ? `：${raw.slice(0, 300)}` : ""}`;
  }
  const who = options.model ? `「${options.model}」` : "当前 Chat 模型";
  return `HTTP ${status} · 上游内容安全预检拦截（invalid_prompt）：${who} 在执行前判定提示词可能违反其使用政策，本次请求未被处理、不会计费。`
    + "这是上游的审核判定（与提示词长度相关性较高，且随模型 / 时段偶发），不是 LenTalk 的格式问题。可以这样处理："
    + "① 直接重试一次，偶发命中常常就能过；"
    + "② 把该节点的 Chat 模型换成非 OpenAI 推理模型（例如知鸟AI 的 gemini-3.8-flash / deepseek-v4.1-flash）；"
    + "③ 精简「风格 / 故事梗概」后重试。";
}
