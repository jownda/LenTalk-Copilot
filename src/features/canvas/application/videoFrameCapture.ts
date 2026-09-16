import { invoke, isTauri } from '@tauri-apps/api/core';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

/**
 * 视频抽帧。
 *
 * 直接把跨域视频喂给 <video> 再绘制到 canvas 会污染画布, `toDataURL` 抛 SecurityError,
 * 界面上的表现就是「视频源未授权跨域截图」。而生成的视频在节点里存的是远端 CDN 地址,
 * 这类地址基本不带 CORS 头, 所以直接抽帧必然失败。
 *
 * 这里按代价从低到高依次尝试:
 *   1. 用显示地址建离屏 video(本地 asset 协议与带 CORS 头的 CDN 一次成功, 不产生额外下载);
 *   2. 失败时交给 Rust 取字节(`load_media_data_url`), 前端转成 blob URL —— blob 与文档同源,
 *      画布不会被污染, 且完全绕开远端 CDN 的 CORS 配置。
 *
 * 注意: 每次抽帧都用新建的离屏 video, 不去改节点上播放中的那个元素 ——
 * 给播放元素加 crossOrigin 会在 CDN 不带 CORS 头时让视频直接加载失败。
 */

/** 离屏 video 解码超时: 远端大文件首帧偏慢, 但不能无限等待。 */
const VIDEO_LOAD_TIMEOUT_MS = 20000;
const VIDEO_SEEK_TIMEOUT_MS = 8000;

export interface CaptureVideoFrameRequest {
  /** 节点保存的原始来源(data.sourcePath), 远端地址需要它走 Rust 取字节。 */
  source: string;
  /** 截图时间点(秒), 默认 0 即首帧。 */
  timeSec?: number;
  /** 输出最大宽度, 传入正数时等比缩放; 默认不缩放, 保持与原始画面同尺寸。 */
  maxWidth?: number;
}

function decodeBase64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 解析 data URL 的 MIME 与原始字节, 供转 Blob 使用。 */
export function parseDataUrlPayload(dataUrl: string): { mimeType: string; bytes: Uint8Array } {
  const commaIndex = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || commaIndex < 0) {
    throw new Error('data URL 格式无效');
  }
  const metadata = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeType = metadata.split(';')[0].slice('data:'.length) || 'application/octet-stream';
  const bytes = metadata.toLowerCase().includes(';base64')
    ? decodeBase64ToBytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { mimeType, bytes };
}

/** 把 data URL 转成同源 blob URL, 调用方负责 revoke。 */
export function createObjectUrlFromDataUrl(dataUrl: string): string {
  const { mimeType, bytes } = parseDataUrlPayload(dataUrl);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频帧无法解码'));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('视频加载超时'));
    }, timeoutMs);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
    onReady();
  });
}

function seekVideo(video: HTMLVideoElement, timeSec: number, timeoutMs: number): Promise<void> {
  const target = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0;
  if (target === 0 || Math.abs(video.currentTime - target) < 0.01) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频定位失败'));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('视频定位超时'));
    }, timeoutMs);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = target;
  });
}

function drawVideoFrame(video: HTMLVideoElement, maxWidth: number): string {
  const naturalWidth = video.videoWidth;
  const naturalHeight = video.videoHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('视频尺寸无效');
  }
  const shouldScale = Number.isFinite(maxWidth) && maxWidth > 0 && naturalWidth > maxWidth;
  const width = shouldScale ? Math.max(1, Math.round(maxWidth)) : naturalWidth;
  const height = shouldScale ? Math.max(1, Math.round((width / naturalWidth) * naturalHeight)) : naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法初始化画布');
  }
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

interface FrameSourceRequest {
  /** 可直接喂给 <video> 的地址。 */
  src: string;
  crossOrigin: boolean;
  timeSec: number;
  maxWidth: number;
}

async function captureFromVideoSource({
  src,
  crossOrigin,
  timeSec,
  maxWidth,
}: FrameSourceRequest): Promise<string> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  if (crossOrigin) {
    video.crossOrigin = 'anonymous';
  }
  video.src = src;

  try {
    await waitForVideoReady(video, VIDEO_LOAD_TIMEOUT_MS);
    await seekVideo(video, timeSec, VIDEO_SEEK_TIMEOUT_MS);
    return drawVideoFrame(video, maxWidth);
  } finally {
    // 释放解码器与缓冲, 否则连点截图会持续占用内存。
    video.removeAttribute('src');
    video.load();
  }
}

async function captureViaRustBytes(source: string, timeSec: number, maxWidth: number): Promise<string> {
  const dataUrl = await invoke<string>('load_media_data_url', { source });
  const blobUrl = createObjectUrlFromDataUrl(dataUrl);
  try {
    return await captureFromVideoSource({
      src: blobUrl,
      crossOrigin: false,
      timeSec,
      maxWidth,
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * 抽取视频指定时间点的画面, 返回 PNG data URL。
 * 所有可行的取帧方式都失败时抛出最后一个错误, 由调用方决定提示文案。
 */
export async function captureVideoFrame(request: CaptureVideoFrameRequest): Promise<string> {
  const trimmed = request.source.trim();
  if (!trimmed) {
    throw new Error('视频来源为空');
  }
  const timeSec = request.timeSec ?? 0;
  const maxWidth = request.maxWidth ?? 0;

  // data URL 已经同源, 直接转 blob, 不必经过 Rust。
  if (trimmed.startsWith('data:')) {
    const blobUrl = createObjectUrlFromDataUrl(trimmed);
    try {
      return await captureFromVideoSource({ src: blobUrl, crossOrigin: false, timeSec, maxWidth });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  const attempts: Array<() => Promise<string>> = [
    () =>
      captureFromVideoSource({
        src: resolveImageDisplayUrl(trimmed),
        crossOrigin: true,
        timeSec,
        maxWidth,
      }),
  ];
  // 桌面端才具备 Rust 取字节的能力, 浏览器调试环境只保留直连尝试。
  if (isTauri()) {
    attempts.push(() => captureViaRustBytes(trimmed, timeSec, maxWidth));
  }

  let lastError: unknown = null;
  for (const [index, attempt] of attempts.entries()) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (index < attempts.length - 1) {
        console.warn('[videoFrameCapture] direct capture failed, retrying via local bytes', error);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('视频截图失败');
}
