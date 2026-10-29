import { invoke } from "@tauri-apps/api/core";

/**
 * 读文本文件（用户选中的本地 JSON）。
 *
 * 走 Rust 而不是 `@tauri-apps/plugin-fs`：capabilities 只放开了 `$HOME` / `$TEMP`，
 * 工作流文件常放在 D 盘或移动硬盘，用 fs 插件会被 `forbidden path` 拒掉。
 */
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** 写文本文件（覆盖）。路径来自系统保存对话框，父目录一定存在。 */
export async function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}
