import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ tauri: true }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => runtime.tauri }));
vi.mock('@/commands/mediaOutput', () => ({
  persistVideoSource: vi.fn(),
  persistMediaSourceAuto: vi.fn(),
}));

import { persistMediaSourceAuto, persistVideoSource } from '@/commands/mediaOutput';

import {
  isDetachedLocalMediaSource,
  isLocalAbsoluteMediaPath,
  isRemoteMediaSource,
  needsLocalPersistence,
  persistAudioLocally,
  persistVideoLocally,
} from './mediaPersistence';

const persistMock = vi.mocked(persistVideoSource);
const persistAutoMock = vi.mocked(persistMediaSourceAuto);

describe('isRemoteMediaSource', () => {
  it('远端的、内联的、blob 的都算"还在外面"，需要落盘', () => {
    expect(isRemoteMediaSource('https://x.oss-cn-shenzhen.aliyuncs.com/a.mp4')).toBe(true);
    expect(isRemoteMediaSource('http://x/a.mp4')).toBe(true);
    expect(isRemoteMediaSource('data:video/mp4;base64,AAAA')).toBe(true);
    expect(isRemoteMediaSource('blob:http://localhost/abc')).toBe(true);
  });

  it('本机路径不算"远端"', () => {
    expect(isRemoteMediaSource('C:/Users/me/AppData/LenTalk/videos/ab.mp4')).toBe(false);
    expect(isRemoteMediaSource('\\\\server\\share\\videos\\ab.mp4')).toBe(false);
    expect(isRemoteMediaSource('/Users/me/Movies/ab.mp4')).toBe(false);
  });
});

describe('isDetachedLocalMediaSource', () => {
  it('认得出即梦 CLI 那条 AppData 临时路径', () => {
    expect(
      isDetachedLocalMediaSource(
        'C:\\Users\\Administrator\\AppData\\Roaming\\com.storyboard.copilot\\jimeng-cli/videos\\7993fc3a\\canvas-7993fc3a.mp4',
      ),
    ).toBe(true);
    // 画布 CLI 的图片也下在同一个目录里。
    expect(
      isDetachedLocalMediaSource(
        'C:/Users/me/AppData/Roaming/com.storyboard.copilot/jimeng-cli/videos/8c71/canvas-8c71.png',
      ),
    ).toBe(true);
    // macOS 的 Application Support 同理。
    expect(
      isDetachedLocalMediaSource('/Users/me/Library/Application Support/com.storyboard.copilot/a.mp4'),
    ).toBe(true);
  });

  it('已经在媒体目录 / 用户自己的素材盘里的文件不动', () => {
    expect(isDetachedLocalMediaSource('D:\\lentalk缓存\\videos\\feb09787.mp4')).toBe(false);
    expect(isDetachedLocalMediaSource('C:/Users/me/Downloads/LenTalk/videos/ab12.mp4')).toBe(false);
    expect(isDetachedLocalMediaSource('/Users/me/Movies/ab.mp4')).toBe(false);
    // 网络共享路径不是本地文件。
    expect(isDetachedLocalMediaSource('\\\\server\\share\\AppData\\a.mp4')).toBe(false);
  });

  it('没有媒体扩展名的（目录、日志）不当素材处理', () => {
    expect(
      isDetachedLocalMediaSource('C:/Users/me/AppData/Roaming/com.storyboard.copilot/jimeng-cli/videos'),
    ).toBe(false);
    expect(
      isDetachedLocalMediaSource('C:/Users/me/AppData/Roaming/com.storyboard.copilot/jimeng-cli/a.txt'),
    ).toBe(false);
  });
});

describe('isLocalAbsoluteMediaPath', () => {
  it('认盘符路径与 POSIX 绝对路径，不认相对路径和网络路径', () => {
    expect(isLocalAbsoluteMediaPath('C:\\a.mp4')).toBe(true);
    expect(isLocalAbsoluteMediaPath('c:/a.mp4')).toBe(true);
    expect(isLocalAbsoluteMediaPath('/Users/me/a.mp4')).toBe(true);
    expect(isLocalAbsoluteMediaPath('videos/a.mp4')).toBe(false);
    expect(isLocalAbsoluteMediaPath('\\\\server\\a.mp4')).toBe(false);
  });
});

describe('needsLocalPersistence', () => {
  it('远端链接与 AppData 临时文件都要落盘', () => {
    expect(needsLocalPersistence('https://cdn.example.com/a.mp4')).toBe(true);
    expect(
      needsLocalPersistence('C:/Users/me/AppData/Roaming/com.storyboard.copilot/jimeng-cli/videos/a.mp4'),
    ).toBe(true);
  });

  it('已在媒体目录里的本地文件不重复落盘', () => {
    expect(needsLocalPersistence('D:\\lentalk缓存\\videos\\ab.mp4')).toBe(false);
  });
});

describe('persistVideoLocally', () => {
  beforeEach(() => {
    runtime.tauri = true;
    persistMock.mockReset();
    persistAutoMock.mockReset();
  });

  it('远端 URL 会落盘并返回本地路径', async () => {
    persistMock.mockResolvedValue('C:/Users/me/Downloads/LenTalk/videos/ab12.mp4');

    await expect(persistVideoLocally('https://cdn.example.com/a.mp4')).resolves.toBe(
      'C:/Users/me/Downloads/LenTalk/videos/ab12.mp4',
    );
    expect(persistMock).toHaveBeenCalledWith('https://cdn.example.com/a.mp4');
  });

  it('即梦 CLI 下在 AppData 里的产物也要搬进落盘目录', async () => {
    const detached =
      'C:\\Users\\Administrator\\AppData\\Roaming\\com.storyboard.copilot\\jimeng-cli\\videos\\7993\\canvas-7993.mp4';
    persistMock.mockResolvedValue('D:\\lentalk缓存\\videos\\5f2c.mp4');

    await expect(persistVideoLocally(detached)).resolves.toBe('D:\\lentalk缓存\\videos\\5f2c.mp4');
    expect(persistMock).toHaveBeenCalledWith(detached);
  });

  it('已经在媒体目录里的本地路径直接返回，不再多下一次', async () => {
    const local = 'D:\\lentalk缓存\\videos\\feb09787b9d3eeafe1a1f2e5ddd939bc.mp4';

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

  it('落盘失败时回退原地址 —— 绝不把已生成好的视频丢掉', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    persistMock.mockRejectedValue(new Error('404 NoSuchKey'));

    await expect(persistVideoLocally('https://cdn.example.com/gone.mp4')).resolves.toBe(
      'https://cdn.example.com/gone.mp4',
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('落盘返回空串时也回退原地址', async () => {
    persistMock.mockResolvedValue('');

    await expect(persistVideoLocally('https://cdn.example.com/a.mp4')).resolves.toBe(
      'https://cdn.example.com/a.mp4',
    );
  });
});

describe('persistAudioLocally', () => {
  beforeEach(() => {
    runtime.tauri = true;
    persistAutoMock.mockReset();
  });

  it('CLI 下在 AppData 里的音频搬进 audio 子目录', async () => {
    const detached =
      'C:/Users/me/AppData/Roaming/com.storyboard.copilot/jimeng-cli/videos/run-2/canvas-run-2.mp3';
    persistAutoMock.mockResolvedValue('D:/lentalk缓存/audio/9ab3.mp3');

    await expect(persistAudioLocally(detached)).resolves.toBe('D:/lentalk缓存/audio/9ab3.mp3');
    expect(persistAutoMock).toHaveBeenCalledWith(detached);
  });

  it('失败时回退原地址', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    persistAutoMock.mockRejectedValue(new Error('boom'));

    await expect(persistAudioLocally('https://cdn.example.com/a.mp3')).resolves.toBe(
      'https://cdn.example.com/a.mp3',
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
