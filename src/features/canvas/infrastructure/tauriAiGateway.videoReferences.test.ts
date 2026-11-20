import { describe, expect, it } from 'vitest';

// `?raw` 由 vite 处理，配合 `vite/client` 的类型声明即可，不必引入 node 类型。
import source from './tauriAiGateway.ts?raw';

/**
 * 参考视频「换地址」守卫。
 *
 * 与本地 CLI 落盘那条守卫同一类问题：**漏一处不会立刻报错**。
 * 视频生成有两条入口（异步 job / 同步直调），只在一处把参考视频换成公网直链，
 * 另一条会把 `D:\...\a.mp4` 这种本地路径原样发给筷子 / likeai ——
 * 平台在**异步任务里**才失败，界面只看到「生成失败」，原因完全不可见。
 * 所以这里直接扫源码：两处都必须带 `videoSources`，并把结果回填 `reference_videos`。
 */
describe('参考视频托管守卫', () => {
  const callSites = [...source.matchAll(/resolveHostedVideoReferences\(\{/g)];

  it('两条视频入口都解析参考视频', () => {
    expect(callSites.length).toBe(2);
    for (const site of callSites) {
      const body = source.slice(site.index ?? 0, (site.index ?? 0) + 800);
      expect(body).toContain('videoSources:');
    }
  });

  it('解析结果回填 reference_videos（否则本地视频路径直接发给平台）', () => {
    expect([...source.matchAll(/hostedReferences\.videos/g)].length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('reference_videos: referenceVideos');
  });
});
