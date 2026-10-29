import { isTauri } from "@tauri-apps/api/core";

import { persistLibraryAssetFile, persistLibraryAssetFromFile } from "@/commands/assetLibrary";

/**
 * 节点内的素材上传：把一个 `File` 变成可长期引用的来源。
 *
 * 桌面端走「落盘 + 素材库」，浏览器调试环境退回 data URL。这段逻辑原先只写在
 * 「动作控制」节点里，RunningHub 工作流节点也需要 —— 照抄一份的话，两边的文件
 * 扩展名兜底规则迟早会分叉（一个 `bin` 一个 `dat`，平台侧就再也认不出类型）。
 */

/** 取文件扩展名；拿不到合法值时退回 `bin`（平台按扩展名判类型，空值必挂）。 */
export function fileExtension(file: File): string {
  const extension = file.name.split(".").pop()?.trim().toLowerCase();
  return extension && /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

/**
 * 落盘并返回可引用的来源。
 *
 * Tauri 环境下优先用文件真实路径（`persistLibraryAssetFile` 不需要把整份内容读进
 * JS 内存），拿不到路径时再用 `File` 本身落盘；浏览器环境退回 data URL。
 */
export async function persistNodeMediaFile(file: File): Promise<string> {
  const path = (file as File & { path?: string }).path?.trim();
  if (isTauri()) {
    if (path) {
      return await persistLibraryAssetFile(path, fileExtension(file));
    }
    return await persistLibraryAssetFromFile(file, fileExtension(file));
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  return dataUrl;
}

/** 展示用文件名：data URL / 本地路径都收敛成一个人能认的名字。 */
export function mediaSourceLabel(source: string | null | undefined, fallback: string): string {
  if (!source) return fallback;
  if (/^data:/i.test(source)) return fallback;
  const clean = source.split(/[\\/]/).pop()?.trim();
  return clean || fallback;
}
