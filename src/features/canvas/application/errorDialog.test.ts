import { describe, expect, it } from 'vitest';

import {
  BALANCE_INSUFFICIENT_MESSAGE,
  IMAGE_EDITS_NETWORK_ERROR_MESSAGE,
  PROXY_REQUIRED_65535_MESSAGE,
  isBalanceInsufficientError,
  isImageEditsNetworkError,
  isProxyRequired65535NetworkError,
  resolveErrorContent,
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
});
