import { isTauri } from '@tauri-apps/api/core';

import { persistVideoSource } from '@/commands/mediaOutput';

/**
 * 生成媒体的本地化。
 *
 * 图片一直有这一步（`imageData.ts` 的 `persistImageLocally`），视频以前没有 —— 平台回什么
 * 链接就直接存什么，于是节点、模板、共享盘 template.json 里全是第三方 CDN 的**临时**地址。
 * CDN 一清理（阿里云 OSS 上 `reference-assets/` 这类目录会被定期清），那些节点就永久坏了，
 * 换任何网络都救不回来。
 *
 * 这里跟图片对齐：生成完成后**同步**落盘，节点里存本地路径。
 */

/** 是不是"还在外面"的来源（远端/内联/blob），即需要落盘的那些。 */
export function isRemoteMediaSource(source: string): boolean {
  return /^(https?:|data:|blob:|asset:|\/\/)/i.test(source.trim());
}

/**
 * 把生成出来的视频抓成本地文件，返回本地路径。
 *
 * 落盘失败**不能**毁掉已经生成好的结果：退回远端 URL，用户至少还能看到视频，只是它
 * 仍然依赖那条随时会失效的外部链接。所以这里吞掉异常并 warn，绝不向上抛 ——
 * 调用方拿到的一定是一个可以用的地址。
 */
export async function persistVideoLocally(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) return source;
  if (!isRemoteMediaSource(trimmed)) return source;
  if (!isTauri()) return source;

  try {
    const localPath = await persistVideoSource(trimmed);
    return localPath.trim() || source;
  } catch (error) {
    console.warn('[mediaPersistence] 视频落盘失败，回退远端 URL', { source: trimmed, error });
    return source;
  }
}
