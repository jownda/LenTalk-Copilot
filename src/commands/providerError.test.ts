import { describe, expect, it } from 'vitest';

import { describeProviderFailure, isUpstreamPromptPolicyRejection } from './providerError';

/** OpenAI 推理模型输入内容预检的真实回包（2026-10 实机）。 */
const INVALID_PROMPT_BODY =
  '{"error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged as potentially '
  + 'violating our usage policy. Please try again with a different prompt: '
  + 'https://platform.openai.com/docs/guides/reasoning#advice-on-prompting","param":null,'
  + '"type":"invalid_request_error"}}';

describe('isUpstreamPromptPolicyRejection', () => {
  it('认出 invalid_prompt 回包', () => {
    expect(isUpstreamPromptPolicyRejection(INVALID_PROMPT_BODY)).toBe(true);
  });

  it('只带 message 不带 code 也算（中转站常把 code 抹掉）', () => {
    expect(isUpstreamPromptPolicyRejection(
      'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
    )).toBe(true);
  });

  it('不误判常规错误', () => {
    expect(isUpstreamPromptPolicyRejection('{"error":{"message":"invalid api key"}}')).toBe(false);
    expect(isUpstreamPromptPolicyRejection('{"error":{"code":"rate_limit_exceeded"}}')).toBe(false);
    expect(isUpstreamPromptPolicyRejection('')).toBe(false);
  });
});

describe('describeProviderFailure', () => {
  it('审核拒绝时给出可执行的中文指引，并点名模型', () => {
    const text = describeProviderFailure(400, { raw: INVALID_PROMPT_BODY, model: 'gpt-6-astra' });
    expect(text).toContain('gpt-6-astra');
    expect(text).toContain('invalid_prompt');
    // 用户必须看得到下一步做什么，而不是一串英文 JSON
    expect(text).toContain('重试');
    expect(text).toContain('gemini-3.8-flash');
    expect(text).not.toContain('"error"');
  });

  it('审核拒绝仍以 HTTP 状态码开头，保住 classifyError 的 http 归类', () => {
    const text = describeProviderFailure(400, { raw: INVALID_PROMPT_BODY, model: 'gpt-6-astra' });
    expect(/^HTTP \d+/.test(text)).toBe(true);
    expect(/^HTTP (?:504|524)(?:\D|$)/i.test(text)).toBe(false);
  });

  it('审核拒绝但不知道模型时用通用称呼', () => {
    const text = describeProviderFailure(400, { raw: INVALID_PROMPT_BODY });
    expect(text).toContain('当前 Chat 模型');
  });

  it('普通失败保持原始 HTTP 正文形状', () => {
    expect(describeProviderFailure(401, { raw: '{"error":{"message":"invalid api key"}}' }))
      .toBe('HTTP 401：{"error":{"message":"invalid api key"}}');
    expect(describeProviderFailure(500, {})).toBe('HTTP 500');
  });

  it('普通失败的长正文截到 300 字符', () => {
    const text = describeProviderFailure(502, { raw: 'x'.repeat(500) });
    expect(text).toBe(`HTTP 502：${'x'.repeat(300)}`);
  });
});
