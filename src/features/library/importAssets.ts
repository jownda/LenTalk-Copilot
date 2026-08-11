import { v4 as uuid } from 'uuid';
import { isTauri } from '@tauri-apps/api/core';

import { persistLibraryAssetBinary, extractVideoThumbnail } from '@/commands/assetLibrary';
import { prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import { ASSET_LIBRARY_MIME_PREFIX, type AssetMediaType, type LibraryAsset } from './types';

export function createAssetId(): string {
  return `asset-${uuid().slice(0, 12)}`;
}

/**
 * 从图片 URL 下载为本地素材(画布图片「添加到素材库」用)。
 * 返回 null 表示下载或处理失败。
 */
export async function importImageUrlToAsset(
  imageUrl: string,
  libraryId: string,
  categoryId: string | null
): Promise<LibraryAsset | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    const extension = blob.type.split('/')[1] ?? 'png';
    const fileName = `canvas-image-${Date.now()}.${extension}`;
    const file = new File([blob], fileName, { type: blob.type || 'image/png' });
    const prepared = await prepareNodeImageFromFile(file);
    return {
      id: createAssetId(),
      libraryId,
      categoryId,
      name: `画布图片 ${new Date().toLocaleTimeString()}`,
      mediaType: 'image',
      sourcePath: prepared.imageUrl,
      previewImageUrl: prepared.previewImageUrl,
      aspectRatio: prepared.aspectRatio || '1:1',
      sourceFileName: fileName,
      tags: [],
      createdAt: Date.now(),
    };
  } catch (error) {
    console.warn('[assetLibrary] import image url failed', imageUrl, error);
    return null;
  }
}

export function assetDragPayload(assetId: string): string {
  return JSON.stringify({ id: assetId });
}

export function parseAssetDragPayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

export const ASSET_DRAG_DATA_TYPE = ASSET_LIBRARY_MIME_PREFIX;

/** 提示词拖拽到画布的数据类型(用于创建 AI 图片节点) */
export const PROMPT_DRAG_DATA_TYPE = 'application/x-storyboard-prompt';

export function promptDragPayload(promptId: string): string {
  return JSON.stringify({ id: promptId });
}

export function parsePromptDragPayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

function mediaTypeForFile(file: File): AssetMediaType | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

function extensionForFile(file: File): string {
  const extension = file.name.split('.').pop()?.trim();
  if (extension && extension !== file.name) return extension;
  if (file.type === 'video/mp4') return 'mp4';
  if (file.type === 'audio/mpeg') return 'mp3';
  if (file.type === 'audio/wav') return 'wav';
  return 'bin';
}

function assetNameFromFile(file: File): string {
  return file.name.replace(/\.[^.]+$/, '').trim() || file.name || '未命名素材';
}

/**
 * 提取视频首帧作为缩略图: <video> 解码 + canvas 压缩, 返回小尺寸 JPEG data URL。
 * 关键: 视频元素必须挂载到 DOM 并静音自动播放(WKWebView 中离屏 video 不真正解码,
 * videoWidth 恒为 0 导致截图失败)。失败返回 null, 由调用方回退。
 */
function captureVideoThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('webkit-playsinline', 'true');
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:4px;height:4px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    let settled = false;
    const timeoutId = window.setTimeout(() => settle(null, 'timeout'), 10000);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(objectUrl);
    };
    const settle = (dataUrl: string | null, reason?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (dataUrl === null && reason) {
        console.warn('[videoThumb] capture failed:', reason);
      }
      resolve(dataUrl);
    };

    /** 尝试绘制首帧; 视频尺寸未就绪时静默等待后续事件 */
    const tryDraw = () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) {
          return;
        }
        const targetWidth = 320;
        const scale = targetWidth / vw;
        const width = targetWidth;
        const height = Math.max(1, Math.round(vh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          settle(null, 'no 2d context');
          return;
        }
        ctx.drawImage(video, 0, 0, width, height);
        settle(canvas.toDataURL('image/jpeg', 0.72));
      } catch (error) {
        settle(null, error instanceof Error ? error.message : String(error));
      }
    };

    const tryAutoplay = () => {
      if (video.paused) {
        void video.play().then(() => {
          video.pause();
          tryDraw();
        }).catch(() => tryDraw());
      }
    };

    video.onerror = () => settle(null, 'video element error');
    video.onloadeddata = () => tryDraw();
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
      } catch {
        // 忽略, 等 oncanplay/autoplay 兜底
      }
    };
    video.onseeked = () => tryDraw();
    video.oncanplay = tryAutoplay;

    video.src = objectUrl;
    video.load();
    // 立即尝试静音自动播放(部分环境 oncanplay 不触发)
    tryAutoplay();
  });
}

export async function importFilesToAssets(
  files: File[],
  libraryId: string,
  categoryId: string | null
): Promise<LibraryAsset[]> {
  const imported: LibraryAsset[] = [];
  for (const file of files) {
    const mediaType = mediaTypeForFile(file);
    if (!mediaType) continue;

    try {
      const createdAt = Date.now();
      if (mediaType === 'image') {
        const prepared = await prepareNodeImageFromFile(file);
        imported.push({
          id: createAssetId(),
          libraryId,
          categoryId,
          name: assetNameFromFile(file),
          mediaType,
          sourcePath: prepared.imageUrl,
          previewImageUrl: prepared.previewImageUrl,
          aspectRatio: prepared.aspectRatio || '1:1',
          sourceFileName: file.name,
          tags: [],
          createdAt,
        });
        continue;
      }

      const sourcePath = await persistLibraryAssetBinary(
        new Uint8Array(await file.arrayBuffer()),
        extensionForFile(file)
      );

      if (mediaType === 'video') {
        // 视频: Tauri 用系统 QuickLook 抽帧; 浏览器用前端 canvas 截首帧; 失败回退 null
        const previewImageUrl = isTauri()
          ? await extractVideoThumbnail(sourcePath)
          : await captureVideoThumbnail(file);
        imported.push({
          id: createAssetId(),
          libraryId,
          categoryId,
          name: assetNameFromFile(file),
          mediaType,
          sourcePath,
          previewImageUrl,
          aspectRatio: null,
          sourceFileName: file.name,
          tags: [],
          createdAt,
        });
        continue;
      }

      imported.push({
        id: createAssetId(),
        libraryId,
        categoryId,
        name: assetNameFromFile(file),
        mediaType,
        sourcePath,
        previewImageUrl: null,
        aspectRatio: null,
        sourceFileName: file.name,
        tags: [],
        createdAt,
      });
    } catch (error) {
      console.warn('[assetLibrary] import failed', file.name, error);
    }
  }
  return imported;
}
