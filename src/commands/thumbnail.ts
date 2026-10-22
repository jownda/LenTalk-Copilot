import { invoke } from "@tauri-apps/api/core";

/**
 * 让 Rust 侧生成（或命中缓存）一张小缩略图，返回可直接交给 `convertFileSrc` 的本地路径。
 *
 * 源地址必须是本地文件；远端 URL / data URL 会直接抛错，调用方应回落原图。
 */
export async function ensureImageThumbnail(path: string, maxEdge?: number): Promise<string> {
  return await invoke<string>("ensure_image_thumbnail", { path, maxEdge });
}
