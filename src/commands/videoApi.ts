/**
 * RJM 的视频接口独立于常见 OpenAI 兼容视频接口。这里集中处理域名识别，
 * 让推荐平台和用户手动添加相同 URL 时始终走同一条协议链路。
 */
export function resolveRjmVideoApiBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'video.rjm.us.ci' && hostname !== 'sub2api.rjm.us.ci') {
      return null;
    }
    return `${url.protocol}//video.rjm.us.ci`;
  } catch {
    return null;
  }
}

export function isRjmVideoApiBaseUrl(baseUrl: string): boolean {
  return resolveRjmVideoApiBaseUrl(baseUrl) !== null;
}

/** 每次点击生成都创建新的幂等键，重试同一请求时可复用调用方传入的 job id。 */
export function createVideoIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  const suffix = randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `lentalk-video-${suffix}`;
}

/** 从异步任务的嵌套返回中提取平台给出的实际失败原因。 */
export function getVideoTaskFailureReason(payload: unknown): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 6 || value == null) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const reason = visit(item, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['error', 'error_message', 'failure_reason', 'fail_reason', 'message', 'reason', 'detail']) {
      const reason = visit(record[key], depth + 1);
      if (reason) return reason;
    }
    for (const key of ['data', 'result', 'task', 'job', 'response']) {
      const reason = visit(record[key], depth + 1);
      if (reason) return reason;
    }
    return null;
  };

  const reason = visit(payload, 0);
  return reason ? reason.slice(0, 800) : null;
}
