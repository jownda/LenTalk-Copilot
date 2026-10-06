import { invoke, isTauri } from "@tauri-apps/api/core";

/** 系统剪贴板里的媒体快照，字段与 Rust 侧 `ClipboardMediaSnapshot` 一一对应。 */
export interface ClipboardMediaSnapshot {
  /** 在访达 / 资源管理器里复制的本地文件绝对路径。 */
  filePaths: string[];
  /** 剪贴板里是否有位图数据(截图、复制图片等)。 */
  hasImage: boolean;
  /** 位图的 PNG base64；`includeImage` 为 false 时始终为 null。 */
  imageBase64: string | null;
  /** 剪贴板里的纯文本(少数平台复制文件时只留 file:// 文本)。 */
  text: string | null;
}

/**
 * 读取系统剪贴板里的媒体内容。
 *
 * 只有 Rust 侧能拿到访达 / 资源管理器里复制的文件路径与截图位图；读取失败或不在桌面端时
 * 返回 null，调用方自行回退到 Async Clipboard API。
 *
 * `includeImage` 为 false 时只做轻量探测(不解码位图)，用于比对剪贴板指纹。
 */
export async function readClipboardMediaSnapshot(
  includeImage = true,
): Promise<ClipboardMediaSnapshot | null> {
  if (!isTauri()) {
    return null;
  }

  try {
    return await invoke<ClipboardMediaSnapshot>("read_clipboard_media", { includeImage });
  } catch (error) {
    console.warn("[clipboard] 无法读取系统剪贴板媒体", error);
    return null;
  }
}
