/**
 * 平台参考素材来源解析。
 *
 * 中转平台的生成类参考字段只认两种东西：公网 URL 或平台能读到的文件。
 * 而画布上的参考素材可能是：生成结果(data URL / 本机路径)、素材库条目(绝对路径)、
 * 上传的本地文件(绝对路径 / file://)、Tauri 预览用的 asset:// URL，
 * 平台要求 raw_base64 时还会出现不带 data: 前缀的裸 base64。
 *
 * 这里把"可读取的本地素材"的各种书写形态统一还原，供上传前使用。
 * 纯函数部分不依赖 Tauri，便于单测。
 */
import { isTauri } from '@tauri-apps/api/core';

import { loadImage } from '@/commands/image';

export interface ReferenceAssetPayload {
  mimeType: string;
  extension: string;
  base64: string;
}

/** 参考素材解析结果：公网 URL 直接透传，其余读成可上传的 base64 载荷。 */
export type ResolvedReferenceAsset =
  | { kind: 'url'; url: string }
  | ({ kind: 'file' } & ReferenceAssetPayload);

/** MIME → 文件扩展名。上传的 multipart 文件名要带正确后缀，平台才会正确识别。 */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase().split(';')[0];
  const mapped = EXTENSION_BY_MIME_TYPE[normalized];
  if (mapped) return mapped;
  const subtype = normalized.split('/')[1] ?? '';
  return subtype.replace(/[^a-z0-9]/g, '') || 'bin';
}

const DATA_URL_ASSET_PATTERN = /^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i;

/** 解析 `data:<mime>;base64,<payload>`，顺带把扩展名按 MIME 归一（audio/mpeg → mp3）。 */
export function parseDataUrlAsset(source: string): ReferenceAssetPayload | null {
  const match = source.trim().match(DATA_URL_ASSET_PATTERN);
  if (!match) return null;
  const mimeType = match[1].trim().toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64 || !mimeType) return null;
  return { mimeType, extension: extensionFromMimeType(mimeType), base64 };
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (head[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

interface MediaSignature {
  mimeType: string;
  test: (head: Uint8Array) => boolean;
}

/**
 * 文件头签名。**强签名在前**：弱签名(BM / MP3 帧同步位)容易与随机字节撞车，
 * 排后面并额外加长度约束。
 */
const MEDIA_SIGNATURES: MediaSignature[] = [
  { mimeType: 'image/png', test: (head) => head[0] === 0x89 && asciiAt(head, 1, 'PNG') },
  { mimeType: 'image/jpeg', test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  { mimeType: 'image/gif', test: (head) => asciiAt(head, 0, 'GIF8') },
  { mimeType: 'image/webp', test: (head) => asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP') },
  { mimeType: 'audio/wav', test: (head) => asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WAVE') },
  { mimeType: 'audio/ogg', test: (head) => asciiAt(head, 0, 'OggS') },
  { mimeType: 'audio/flac', test: (head) => asciiAt(head, 0, 'fLaC') },
  { mimeType: 'video/webm', test: (head) => head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 },
  { mimeType: 'video/mp4', test: (head) => asciiAt(head, 4, 'ftyp') },
  { mimeType: 'audio/mpeg', test: (head) => asciiAt(head, 0, 'ID3') },
  { mimeType: 'image/bmp', test: (head) => head.length >= 16 && asciiAt(head, 0, 'BM') },
  {
    mimeType: 'audio/mpeg',
    test: (head) => head.length >= 4 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0,
  },
];

const RAW_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64Prefix(base64: string, byteLength: number): Uint8Array | null {
  try {
    const chunk = base64.slice(0, Math.ceil(byteLength / 3) * 4);
    const binary = atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 平台要求 raw_base64 编码时，上游给的是不带 `data:` 前缀的裸 base64
 * （例如 `/9j/4AAQ…`）。这里只在**解出的文件头命中已知媒体签名**时才认，
 * 否则本地路径或普通文本会被误判成素材。
 */
export function detectBase64Asset(source: string): ReferenceAssetPayload | null {
  const compact = source.trim().replace(/\s+/g, '');
  if (compact.length < 32 || compact.length % 4 !== 0 || !RAW_BASE64_PATTERN.test(compact)) {
    return null;
  }
  const head = decodeBase64Prefix(compact, 32);
  if (!head) return null;
  const signature = MEDIA_SIGNATURES.find((item) => item.test(head));
  if (!signature) return null;
  return {
    mimeType: signature.mimeType,
    extension: extensionFromMimeType(signature.mimeType),
    base64: compact,
  };
}

/** 至少两个字符才算协议前缀，避免把 Windows 盘符 `C:` 当成 scheme。 */
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]+:/;
const LOCAL_PATH_PREFIX_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function normalizeWindowsDrive(path: string): string | null {
  const normalized = path.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  return normalized || null;
}

function isAssetProtocolUrl(lower: string): boolean {
  return lower.startsWith('asset://')
    || lower.startsWith('http://asset.localhost')
    || lower.startsWith('https://asset.localhost');
}

/**
 * 还原本地素材路径的三种书写形态：
 * - `file:///Users/a/b.mp3`、`file://C:/a/b.png`
 * - `asset://localhost/%2FUsers%2F…`（macOS/Linux 版 convertFileSrc）
 * - `http://asset.localhost/C%3A%2F…`（Windows 版 convertFileSrc）
 * 普通绝对路径原样返回；其余协议（blob: / tauri: / http 等）返回 null。
 */
export function localPathFromReferenceSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const isFileUrl = lower.startsWith('file://');
  const isAssetUrl = isAssetProtocolUrl(lower);
  if (!isFileUrl && !isAssetUrl) {
    if (SCHEME_PATTERN.test(trimmed)) return null;
    return LOCAL_PATH_PREFIX_PATTERN.test(trimmed) ? trimmed : null;
  }
  if (isAssetUrl) {
    try {
      const parsed = new URL(trimmed);
      // convertFileSrc 产出 `asset://localhost/<percent-encoded 绝对路径>` —— URL 自身
      // 那层前导斜杠要先去掉, 否则会解出 `//Users/…` 这种不存在的路径。
      return normalizeWindowsDrive(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
    } catch {
      return normalizeWindowsDrive(
        decodeURIComponent(trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:localhost)?\/?/i, '')),
      );
    }
  }
  try {
    const parsed = new URL(trimmed);
    return normalizeWindowsDrive(decodeURIComponent(parsed.pathname));
  } catch {
    return normalizeWindowsDrive(decodeURIComponent(trimmed.replace(/^file:\/\/\/?/i, '')));
  }
}

/** 把读不出来的素材描述成一句可定位的诊断原因（写进错误信息，别让用户猜）。 */
export function describeReferenceSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '素材地址为空';
  const preview = trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed;
  if (!LOCAL_PATH_PREFIX_PATTERN.test(trimmed)) {
    const scheme = trimmed.match(/^([A-Za-z][A-Za-z0-9+.-]+):/)?.[1];
    if (scheme) return `${scheme}: 协议无法作为参考素材(${preview})`;
  }
  return `本地文件读取失败(${preview})`;
}

/**
 * 读本地素材为 data URL。
 * 桌面端走 Rust `load_image`——它会按扩展名给出 MIME，并且显式覆盖
 * mp3/wav/m4a/aac/ogg/flac/webm，所以图片与音频都能读（不只是图片）。
 * 浏览器端读不到本机文件，返回 null 让调用方给出可诊断的报错。
 */
export async function readLocalAssetAsDataUrl(path: string): Promise<string | null> {
  const trimmed = path.trim();
  if (!trimmed || !isTauri()) return null;
  try {
    return await loadImage(trimmed);
  } catch {
    return null;
  }
}

/**
 * 统一入口：公网 URL 透传，其余（data URL / 裸 base64 / 本地路径 / asset 协议 URL）
 * 一律读成 base64 载荷交给调用方上传。
 */
export async function resolveReferenceAssetSource(
  source: string,
  platformLabel: string,
): Promise<ResolvedReferenceAsset> {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error(`${platformLabel} 参考素材地址为空`);
  }
  // `http://asset.localhost/...` 是 Windows Tauri 的本地预览协议，不是公网 URL；
  // 必须先还原本地路径，不能把它透传给要求公网 URL 的视频服务。
  if (!isAssetProtocolUrl(trimmed.toLowerCase()) && /^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', url: trimmed };
  }
  const inlineAsset = parseDataUrlAsset(trimmed) ?? detectBase64Asset(trimmed);
  if (inlineAsset) {
    return { kind: 'file', ...inlineAsset };
  }
  const localPath = localPathFromReferenceSource(trimmed);
  if (localPath) {
    const dataUrl = await readLocalAssetAsDataUrl(localPath);
    const asset = dataUrl ? parseDataUrlAsset(dataUrl) : null;
    if (asset) {
      return { kind: 'file', ...asset };
    }
  }
  throw new Error(
    `${platformLabel} 参考素材必须是公网 URL 或可读取的本地素材(${describeReferenceSource(trimmed)})`,
  );
}
