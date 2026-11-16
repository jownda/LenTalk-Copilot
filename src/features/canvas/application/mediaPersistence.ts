import { isTauri } from '@tauri-apps/api/core';

import { persistMediaSourceAuto, persistVideoSource } from '@/commands/mediaOutput';

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

const MEDIA_FILE_EXTENSION =
  /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|mpg|mpeg|ts|mp3|wav|m4a|aac|flac|ogg|opus|amr|png|jpe?g|webp|gif|bmp)$/i;

/** 盘符开头的绝对路径（Windows）或 `/` 开头（macOS / Linux）。 */
export function isLocalAbsoluteMediaPath(source: string): boolean {
  const value = source.trim();
  if (!value) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
}

/**
 * 「本地文件，但不在落盘目录里」。
 *
 * 真实来源：即梦 CLI / 画布 CLI 把产物下到
 * `%APPDATA%\com.storyboard.copilot\jimeng-cli\videos\<run_id>\canvas-<run_id>.mp4`
 * 就把这个绝对路径返回给前端，节点于是存着一条**寄居在 AppData** 的路径。
 * 它不会像 CDN 链接那样过期，但清缓存 / 重装 / 换机就整批丢，而且完全不归
 * 「设置 → 默认落盘位置」管 —— 对用户来说风险和远端链接是同一类。
 *
 * 应用自己的**资产库**目录。
 *
 * 老布局是 `%APPDATA%\com.storyboard.copilot\library-assets`
 * （`storage_paths.rs: default_library_dir`），正好落在 AppData 里面 ——
 * 于是资产库里的每一张图都会被下面这个「AppData 里的文件要搬走」的判据命中。
 *
 * 搬它是有害的：素材地址记在资产库状态表里，画布引用记在节点里，我们只改写后者
 * ⇒ 两边对不上；而且每从资产库拖一次同一条素材就会再搬一次、再改写一次节点里的
 * 地址，下游提示词里的 `[imageN]` 就跟着反复失效。资产库要换位置请走
 * 「设置 → 素材库目录」的成套迁移。
 */
const LIBRARY_ASSET_DIR = /[\\/]library-assets[\\/]/i;

/**
 * 只认 AppData / Application Support 这一类应用私有目录：用户自己放在「桌面」「素材盘」
 * 的文件不该被我们搬走（那是他的资产，不是我们的缓存）。
 */
export function isDetachedLocalMediaSource(source: string): boolean {
  const value = source.trim();
  if (!isLocalAbsoluteMediaPath(value)) return false;
  if (!MEDIA_FILE_EXTENSION.test(value)) return false;
  if (LIBRARY_ASSET_DIR.test(value)) return false;
  return /[\\/]AppData[\\/]/i.test(value) || /[\\/]Application Support[\\/]/i.test(value);
}

/** 需要落盘才能长期留住的来源：远端临时链接，以及寄居在应用目录里的本地文件。 */
export function needsLocalPersistence(source: string): boolean {
  const value = source.trim();
  if (!value) return false;
  return isRemoteMediaSource(value) || isDetachedLocalMediaSource(value);
}

/**
 * 把生成出来的视频抓成本地文件，返回本地路径。
 *
 * 落盘失败**不能**毁掉已经生成好的结果：退回原地址，用户至少还能看到视频，只是它
 * 仍然依赖那条随时会失效的外部链接。所以这里吞掉异常并 warn，绝不向上抛 ——
 * 调用方拿到的一定是一个可以用的地址。
 */
export async function persistVideoLocally(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) return source;
  if (!needsLocalPersistence(trimmed)) return source;
  if (!isTauri()) return source;

  try {
    const localPath = await persistVideoSource(trimmed);
    return localPath.trim() || source;
  } catch (error) {
    console.warn('[mediaPersistence] 视频落盘失败，回退原地址', { source: trimmed, error });
    return source;
  }
}

/**
 * 音频同理。类型由 Rust 侧按真实扩展名决定（`audio/` 子目录），
 * 所以不需要在这里再判一次是语音还是音乐。
 */
export async function persistAudioLocally(source: string): Promise<string> {
  const trimmed = source.trim();
  if (!trimmed) return source;
  if (!needsLocalPersistence(trimmed)) return source;
  if (!isTauri()) return source;

  try {
    const localPath = await persistMediaSourceAuto(trimmed);
    return localPath.trim() || source;
  } catch (error) {
    console.warn('[mediaPersistence] 音频落盘失败，回退原地址', { source: trimmed, error });
    return source;
  }
}
