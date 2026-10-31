import { describe, expect, it } from 'vitest';

import {
  BALANCE_INSUFFICIENT_MESSAGE,
  IMAGE_EDITS_NETWORK_ERROR_MESSAGE,
  JIMENG_CREDIT_INSUFFICIENT_MESSAGE,
  PROXY_REQUIRED_65535_MESSAGE,
  isBalanceInsufficientError,
  isImageEditsNetworkError,
  isProxyRequired65535NetworkError,
  resolveErrorContent,
  splitErrorHeadline,
} from './errorDialog';

describe('isBalanceInsufficientError', () => {
  it('recognizes OpenAI-compatible standard error codes', () => {
    expect(isBalanceInsufficientError('{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}')).toBe(true);
    expect(isBalanceInsufficientError('HTTP 403: INSUFFICIENT_BALANCE')).toBe(true);
    expect(isBalanceInsufficientError('insufficient balance')).toBe(true);
    expect(isBalanceInsufficientError('insufficient_credits')).toBe(true);
  });

  it('recognizes Chinese variants', () => {
    expect(isBalanceInsufficientError('余额不足，请充值')).toBe(true);
    expect(isBalanceInsufficientError('账户积分不足')).toBe(true);
    expect(isBalanceInsufficientError('余额不够支付本次请求')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isBalanceInsufficientError('HTTP 404 Not Found')).toBe(false);
    expect(isBalanceInsufficientError('Task failed: connection refused')).toBe(false);
    expect(isBalanceInsufficientError('')).toBe(false);
  });
});

describe('isImageEditsNetworkError', () => {
  it('recognizes network failures sent to the multipart image edits endpoint', () => {
    expect(isImageEditsNetworkError(
      'Network error: error sending request for url (https://sub-proxy-us.65535.space/v1/images/edits)'
    )).toBe(true);
  });

  it('replaces the raw endpoint failure with a protocol configuration hint', () => {
    const rawError = 'Network error: error sending request for url (https://sub-proxy-us.65535.space/v1/images/edits)';
    const result = resolveErrorContent(rawError, '生成失败');

    expect(result.message).toBe(IMAGE_EDITS_NETWORK_ERROR_MESSAGE);
    expect(result.details).toContain('/v1/images/edits');
  });

  it('does not suggest a protocol change for other network failures', () => {
    expect(isImageEditsNetworkError('Network error: connection refused')).toBe(false);
    expect(isImageEditsNetworkError('HTTP 400 from /v1/images/edits')).toBe(false);
  });
});

describe('isProxyRequired65535NetworkError', () => {
  const networkError =
    'Network error: error sending request for url (https://sub-proxy-us.65535.space/v1/images/generations)';

  it('recognizes a transport error for the 65535 overseas endpoint', () => {
    expect(isProxyRequired65535NetworkError(networkError)).toBe(true);
  });

  it('replaces the raw transport error with a system-proxy hint', () => {
    const result = resolveErrorContent(networkError, '生成失败');

    expect(result.message).toBe(PROXY_REQUIRED_65535_MESSAGE);
    expect(result.details).toContain('sub-proxy-us.65535.space');
  });

  it('does not suggest a proxy for HTTP responses or unrelated providers', () => {
    expect(isProxyRequired65535NetworkError(
      'HTTP 401 Unauthorized from https://sub-proxy-us.65535.space/v1/images/generations'
    )).toBe(false);
    expect(isProxyRequired65535NetworkError(
      'Network error: error sending request for url (https://example.com/v1/images/generations)'
    )).toBe(false);
  });
});

describe('resolveErrorContent with balance errors', () => {
  it('replaces message with a clear top-up hint and keeps raw error in details', () => {
    const result = resolveErrorContent(
      '连接失败: Task failed: HTTP 403 Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}',
      '生成失败'
    );
    expect(result.message).toBe(BALANCE_INSUFFICIENT_MESSAGE);
    expect(result.details).toContain('INSUFFICIENT_BALANCE');
    expect(result.details).toContain('Insufficient account balance');
  });

  it('passes through non-balance errors unchanged', () => {
    const result = resolveErrorContent('HTTP 404 Not Found', '生成失败');
    expect(result.message).toBe('HTTP 404 Not Found');
  });

  it('handles Error instances wrapping the code', () => {
    const error = new Error('Task failed: HTTP 403 Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}');
    const result = resolveErrorContent(error, '生成失败');
    expect(result.message).toBe(BALANCE_INSUFFICIENT_MESSAGE);
    expect(result.details).toContain('INSUFFICIENT_BALANCE');
  });

  it('handles plain Chinese balance error string', () => {
    const result = resolveErrorContent('余额不足，请充值后重试', '生成失败');
    expect(result.message).toBe(BALANCE_INSUFFICIENT_MESSAGE);
    expect(result.details).toContain('余额不足');
  });

  it('maps Jimeng pre-deduction credit failures to a top-up hint', () => {
    const rawError =
      '即梦 CLI 视频生成失败: gen_status="fail", fail_reason="api error: ret=1006, message=CreditPreDeductNotEnough"';
    const result = resolveErrorContent(rawError, '视频生成失败');

    expect(result.message).toBe(JIMENG_CREDIT_INSUFFICIENT_MESSAGE);
    expect(result.message).toContain('积分不足');
    expect(result.message).toContain('充值');
    expect(result.details).toContain('CreditPreDeductNotEnough');
  });
});

describe('splitErrorHeadline', () => {
  it('第一行当标题、其余进详情', () => {
    const raw =
      '参考音频只有 1.46 秒，服务端要求每段参考音频至少 1.8 秒。请换一条更长的音频（或把这条补长到 1.8 秒以上）再生成\n' +
      '（The node run was rejected…（cli.node_run_rejected） serviceCode=2）\n' +
      '服务端原文：An audio content is 1.463 seconds long…（字段 materials.types.audio.duration_seconds）';
    const result = resolveErrorContent(raw, '生成失败');

    expect(result.message).toBe(
      '参考音频只有 1.46 秒，服务端要求每段参考音频至少 1.8 秒。请换一条更长的音频（或把这条补长到 1.8 秒以上）再生成'
    );
    expect(result.message).not.toContain('\n');
    // 详情保留完整原文，折叠区里能看到 serviceCode 与字段路径。
    expect(result.details).toContain('serviceCode=2');
    expect(result.details).toContain('materials.types.audio.duration_seconds');
  });

  it('单行错误原样不动', () => {
    expect(splitErrorHeadline('HTTP 500 Internal Server Error')).toEqual({
      message: 'HTTP 500 Internal Server Error',
    });
  });

  it('只有换行没有内容时不拆', () => {
    expect(splitErrorHeadline('\n')).toEqual({ message: '' });
  });
});
