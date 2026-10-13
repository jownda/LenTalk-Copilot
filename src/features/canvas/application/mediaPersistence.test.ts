import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ tauri: true }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => runtime.tauri }));
vi.mock('@/commands/mediaOutput', () => ({ persistVideoSource: vi.fn() }));

import { persistVideoSource } from '@/commands/mediaOutput';

import { isRemoteMediaSource, persistVideoLocally } from './mediaPersistence';

const persistMock = vi.mocked(persistVideoSource);

describe('isRemoteMediaSource', () => {
  it('远端的、内联的、blob 的都算"还在外面"，需要落盘', () => {
    expect(isRemoteMediaSource('https://x.oss-cn-shenzhen.aliyuncs.com/a.mp4')).toBe(true);
    expect(isRemoteMediaSource('http://x/a.mp4')).toBe(true);
    expect(isRemoteMediaSource('data:video/mp4;base64,AAAA')).toBe(true);
    expect(isRemoteMediaSource('blob:http://localhost/abc')).toBe(true);
  });

  it('本机路径不需要落盘', () => {
    expect(isRemoteMediaSource('C:/Users/me/AppData/LenTalk/videos/ab.mp4')).toBe(false);
    expect(isRemoteMediaSource('\\\\server\\share\\videos\\ab.mp4')).toBe(false);
    expect(isRemoteMediaSource('/Users/me/Movies/ab.mp4')).toBe(false);
  });
});

describe('persistVideoLocally', () => {
  beforeEach(() => {
    runtime.tauri = true;
    persistMock.mockReset();
  });

  it('远端 URL 会落盘并返回本地路径', async () => {
    persistMock.mockResolvedValue('C:/Users/me/Downloads/LenTalk/videos/ab12.mp4');

    await expect(persistVideoLocally('https://cdn.example.com/a.mp4')).resolves.toBe(
      'C:/Users/me/Downloads/LenTalk/videos/ab12.mp4',
    );
    expect(persistMock).toHaveBeenCalledWith('https://cdn.example.com/a.mp4');
  });

  it('已经是本地路径就直接返回，不再多下一次', async () => {
    const local = 'C:/Users/me/AppData/LenTalk/jimeng-cli/videos/run-1.mp4';

    await expect(persistVideoLocally(local)).resolves.toBe(local);
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('空值不发起落盘', async () => {
    await expect(persistVideoLocally('   ')).resolves.toBe('   ');
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('浏览器环境下原样返回（没有本地文件系统可用）', async () => {
    runtime.tauri = false;

    await expect(persistVideoLocally('https://cdn.example.com/a.mp4')).resolves.toBe(
      'https://cdn.example.com/a.mp4',
    );
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('落盘失败时回退远端 URL —— 绝不把已生成好的视频丢掉', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    persistMock.mockRejectedValue(new Error('404 NoSuchKey'));

    await expect(persistVideoLocally('https://cdn.example.com/gone.mp4')).resolves.toBe(
      'https://cdn.example.com/gone.mp4',
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('落盘返回空串时也回退远端 URL', async () => {
    persistMock.mockResolvedValue('');

    await expect(persistVideoLocally('https://cdn.example.com/a.mp4')).resolves.toBe(
      'https://cdn.example.com/a.mp4',
    );
  });
});
