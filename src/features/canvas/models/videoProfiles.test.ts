import { describe, expect, it } from 'vitest';

import { resolveVideoModelProfile } from './videoProfiles';

describe('resolveVideoModelProfile', () => {
  it('uses the generic profile for custom video models', () => {
    const profile = resolveVideoModelProfile('custom:provider/minimax-h3');
    expect(profile.id).toBe('openai-video');
    expect(profile.status).toBe('verified');
  });

  it('maps Seedance 2 to the generic verified profile (no local block)', () => {
    const profile = resolveVideoModelProfile('custom:provider/seedance-v2-1080p');
    expect(profile.id).toBe('seedance-v2');
    expect(profile.status).toBe('verified');
    expect(profile.unavailableReason).toBeUndefined();
    expect(profile.supportsReferenceImages).toBe(false);
  });

  it('maps 即梦 CLI Seedance models to the local CLI profile (no local block)', () => {
    const profile = resolveVideoModelProfile('jimeng-cli/seedance2.0');
    expect(profile.id).toBe('jimeng-cli');
    expect(profile.status).toBe('verified');
    expect(profile.supportsFirstLast).toBe(true);
    expect(profile.supportsReferenceAudio).toBe(true);
  });

  it('uses the standard profile for explicitly compatible custom models', () => {
    expect(resolveVideoModelProfile('custom:provider/model').id).toBe('openai-video');
  });

  it('routes 字子动画 models through the verified v8 profile', () => {
    const profile = resolveVideoModelProfile('custom:zizidonghua/Kling-3.0');
    expect(profile.id).toBe('zzdh-v8-video');
    expect(profile.submitPath).toBe('/v8/videos/generations');
    expect(profile.supportsFirstLast).toBe(true);
  });

  it('routes Sub2API video models through the files and videos profile', () => {
    const profile = resolveVideoModelProfile('custom:sub2api-video/seedance2.5');
    expect(profile.id).toBe('sub2api-video');
    expect(profile.submitPath).toBe('/v1/videos');
    expect(profile.queryPath).toBe('/v1/videos/{taskId}');
    expect(profile.referenceImageTarget).toBe('platform-file');
    expect(profile.supportsReferenceImages).toBe(true);
  });

  it('recognizes an RJM URL even when the custom platform has a different id', () => {
    expect(resolveVideoModelProfile('custom:my-platform/seedance2.5', 'https://sub2api.rjm.us.ci/v1').id)
      .toBe('sub2api-video');
  });

  it('routes WGSPAI custom provider through the dedicated wgspai video profile', () => {
    const profile = resolveVideoModelProfile('custom:wgspai/seedance2.5');
    expect(profile.id).toBe('wgspai-video');
    expect(profile.status).toBe('verified');
    // 文档三处「推荐统一用 /v1/videos」, 兼容路径 /v1/video/generations 不再作为正典。
    expect(profile.submitPath).toBe('/v1/videos');
    expect(profile.queryPath).toBe('/v1/videos/{taskId}');
    // 本地素材先传官方图床换公网 URL, 不再内联 data URL。
    expect(profile.referenceImageTarget).toBe('platform-file');
    expect(profile.supportsReferenceImages).toBe(true);
    expect(profile.supportsFirstLast).toBe(true);
    expect(profile.supportsReferenceAudio).toBe(true);
  });

  it('routes 知鸟 AI through the flat videos endpoint with the gateway task poll', () => {
    const profile = resolveVideoModelProfile('custom:zhiniao/seedance-2-5');
    expect(profile.id).toBe('zhiniao-video');
    expect(profile.status).toBe('verified');
    expect(profile.submitPath).toBe('/v1/videos/generations');
    // 知鸟的轮询不是「提交路径 + /{taskId}」, 而是网关统一的 /v1/tasks/{task_id}
    expect(profile.queryPath).toBe('/v1/tasks/{taskId}');
    expect(profile.referenceImageTarget).toBe('platform-file');
    expect(profile.supportsReferenceImages).toBe(true);
    expect(profile.supportsReferenceAudio).toBe(true);
  });

  it('recognizes the 知鸟 base URL even when the custom platform id differs', () => {
    expect(resolveVideoModelProfile('custom:my-relay/veo-3.1', 'https://cuai.token6688.com').id)
      .toBe('zhiniao-video');
    expect(resolveVideoModelProfile('custom:my-relay/veo-3.1', 'https://api.tokengo.love/v1').id)
      .toBe('zhiniao-video');
  });

  it('routes 炳火 through the async video profile', () => {
    const profile = resolveVideoModelProfile('custom:binghuo/bh2.0-720p');
    expect(profile.id).toBe('binghuo-video');
    expect(profile.status).toBe('verified');
    // 提交与轮询都不是「通用路径 + /{taskId}」之外的东西, 但字段与通用档案不同。
    expect(profile.submitPath).toBe('/v1/video/generations');
    expect(profile.queryPath).toBe('/v1/video/generations/{taskId}');
    expect(profile.referenceImageTarget).toBe('public-url');
    expect(profile.supportsReferenceAudio).toBe(true);
  });

  it('recognizes the 炳火 base URL even when the custom platform id differs', () => {
    // 推荐卡片连上后 id 由平台名生成(「炳火 API」→ `custom:炳火-api`), 只认
    // 字面量 binghuo 会让节点页签显示成「OpenAI Video / 已验证」。
    expect(resolveVideoModelProfile('custom:炳火-api/bh2.0-720p', 'https://api.7tai.cc/v1').id)
      .toBe('binghuo-video');
    expect(resolveVideoModelProfile('custom:my-relay/bh2.0-720p', 'https://api.7tai.cc').id)
      .toBe('binghuo-video');
  });

  it('炳火自售的 seedance 系模型不会被通用 Seedance 档案抢走', () => {
    // 炳火的 'seedance-2.0-480p' 命中下面的 /^seedance.../ 正则, 必须由前面的
    // Base URL 判据拦下来 —— 两个档案的参考素材目标与音频支持都不同。
    expect(
      resolveVideoModelProfile('custom:炳火-api/seedance-2.0-480p', 'https://api.7tai.cc/v1').id,
    ).toBe('binghuo-video');
  });
});
