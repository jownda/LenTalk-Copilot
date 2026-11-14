import { describe, expect, it } from 'vitest';

// `?raw` 由 vite 处理，配合 `vite/client` 的类型声明即可，不必引入 node 类型。
import source from './tauriAiGateway.ts?raw';

/**
 * 本地 CLI 产物的落盘守卫。
 *
 * 这条约束没法用行为测试覆盖：`tauriAiGateway` 的 CLI 分支会真的拉起本地进程。
 * 但漏写的**后果**很隐蔽 —— 即梦两条 CLI 把产物下在
 * `%APPDATA%\...\jimeng-cli\videos\<run_id>\` 就直接返回路径，节点从此寄居在 AppData 里：
 * 画布上照常播放，用户完全看不出来，直到清缓存 / 重装 / 换机才「所有视频一起坏掉」。
 *
 * 所以这里直接扫源码：`generateVideo` 里每个 `await generateXxx(` 都必须被
 * `persistVideoLocally(...)` 包住，音频分支必须被 `persistAudioLocally(...)` 包住。
 */

/** 取对象字面量里某个成员的方法体（成员之间以 `\n  },\n` 收尾）。 */
function memberBody(marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到成员 ${marker}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  },\n', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** 找出调用点前面最近的包裹函数名（没有则返回 null）。 */
function wrappingCallBefore(body: string, index: number): string | null {
  // 窗口只留 80 字符：包裹调用与 `await generate...` 之间只有换行 + 缩进，
  // 窗口开太大反而会把**上一个**分支的 persist 认成本次调用的包裹。
  const before = body.slice(Math.max(0, index - 80), index);
  const wrappers = [...before.matchAll(/(persistVideoLocally|persistAudioLocally|persistImageLocally)\(\s*$/gm)];
  const last = wrappers.length > 0 ? wrappers[wrappers.length - 1] : null;
  if (!last) return null;
  // 允许包裹函数和 await 之间换行 + 缩进。
  const tail = before.slice((last.index ?? 0) + last[0].length);
  return tail.trim() === '' ? last[1] : null;
}

describe('CLI 产物落盘守卫', () => {
  it('generateVideo 的每个本地 CLI 分支都经过 persistVideoLocally', () => {
    const body = memberBody('generateVideo: async (payload: GenerateVideoPayload)');
    const calls = [...body.matchAll(/await (generate[A-Za-z]+)\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(4);

    const offenders = calls
      .filter((call) => call[1] !== 'generateVideo') // runninghub 直连会递归回本函数，由内层落盘
      .filter((call) => wrappingCallBefore(body, call.index ?? 0) !== 'persistVideoLocally')
      .map((call) => call[1]);

    expect(offenders).toEqual([]);
  });

  it('generateVideo 至少覆盖 4 条 CLI 链路（wan / 即梦 CLI / 即梦画布 / RunningHub）', () => {
    const body = memberBody('generateVideo: async (payload: GenerateVideoPayload)');
    const wrapped = [...body.matchAll(/persistVideoLocally\(/g)].length;
    expect(wrapped).toBeGreaterThanOrEqual(4);
  });

  it('generateAudio 的本地 CLI 分支都经过 persistAudioLocally', () => {
    const body = memberBody('generateAudio: async (payload: GenerateAudioPayload)');
    const calls = [...body.matchAll(/await (generate[A-Za-z]+)\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const offenders = calls
      .filter(
        (call) =>
          call[1] === 'generateJimengCanvasAudio' || call[1] === 'generateRunningHubCliModel',
      )
      .filter((call) => wrappingCallBefore(body, call.index ?? 0) !== 'persistAudioLocally')
      .map((call) => call[1]);

    expect(offenders).toEqual([]);
  });
});
