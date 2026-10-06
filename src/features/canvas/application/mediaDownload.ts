import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";

import { saveImageSourceToPath } from "@/commands/image";
import { isWindowsDesktopRuntime } from "@/platform/runtime";

export interface MediaDownloadRequest {
  source: string;
  nodeId: string;
  mediaType: "image" | "video" | "audio";
  fileName?: string;
}

/** 直接打开保存位置对话框并保存媒体，不经过额外的保存卡片。 */
export async function saveMediaSourceWithDialog({
  source,
  nodeId,
  mediaType,
  fileName,
}: MediaDownloadRequest): Promise<void> {
  const extension = mediaType === "video" ? "mp4" : mediaType === "audio" ? "mp3" : "png";
  const defaultPath = fileName?.trim() || `node-${nodeId}.${extension}`;

  if (!isTauri()) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`下载失败 (${response.status})`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = defaultPath;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
    return;
  }

  const isWindows = isWindowsDesktopRuntime();
  if (isWindows) {
    await getCurrentWindow().setFocus();
  }

  const mediaLabel = mediaType === "video" ? "视频" : mediaType === "audio" ? "音频" : "图片";
  const filterName = mediaType === "video" ? "MP4 视频" : mediaType === "audio" ? "音频文件" : "PNG 图片";
  const filterExtensions = mediaType === "audio" ? ["mp3", "wav", "m4a", "aac", "flac", "ogg"] : [extension];
  const selectedPath = await save(
    isWindows
      ? {
          title: `保存${mediaLabel}`,
          defaultPath,
          filters: [{ name: filterName, extensions: filterExtensions }],
        }
      : { defaultPath },
  );

  if (!selectedPath || Array.isArray(selectedPath)) {
    return;
  }

  await saveImageSourceToPath(source, selectedPath);
}
