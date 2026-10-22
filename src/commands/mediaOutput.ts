import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * 生成媒体的落盘位置。
 *
 * 生成结果以前一律埋在 `AppData/LenTalk/images` 里，用户既找不到自己刚生成的文件，
 * 也没法整包备份。默认改到「系统下载文件夹 / LenTalk」，并允许在「设置 → 通用 →
 * 默认落盘位置」里改。
 */

/**
 * 设置键名。
 *
 * **必须**与 Rust `commands::media_output::MEDIA_OUTPUT_DIR_SETTING_KEY` 一致。
 * 值直接存在 `app_settings` 表里，Rust 侧落盘时每次读它，所以改完立即生效，
 * 不需要重启应用，也不需要把路径一路当参数传进每个落盘调用。
 */
export const MEDIA_OUTPUT_DIR_SETTING_KEY = 'media.output-dir';

/** 把远端视频抓成本地文件，返回本地绝对路径。 */
export async function persistVideoSource(source: string): Promise<string> {
  if (!isTauri()) return source;
  return invoke<string>('persist_video_source', { source });
}

/**
 * 把**类型未知**的远端媒体（图片/视频/音频）抓成本地文件，返回本地绝对路径。
 *
 * 生成链路知道自己拿的是图片还是视频，用上面两个命令即可；但存量节点/模板里的来源
 * 是混在一起的，只能交给 Rust 按 URL 后缀猜预算、按下载后的真实扩展名落地。
 */
export async function persistMediaSourceAuto(source: string): Promise<string> {
  if (!isTauri()) return source;
  return invoke<string>('persist_media_source_auto', { source });
}

/** 未配置时实际会用的默认落盘位置（`<系统下载文件夹>/LenTalk`）。 */
export async function resolveDefaultMediaOutputDir(): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('resolve_default_media_output_dir');
}

/** 当前生效的落盘位置（未配置时即默认位置）。 */
export async function resolveMediaOutputDir(): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('resolve_media_output_dir');
}

/** 读取用户自己配的落盘位置；没配过返回空串。 */
export async function loadMediaOutputDirSetting(): Promise<string> {
  if (!isTauri()) return '';
  const stored = await invoke<string | null>('load_app_setting', { key: MEDIA_OUTPUT_DIR_SETTING_KEY });
  return stored?.trim() ?? '';
}

/**
 * 保存落盘位置；传空串表示恢复默认。
 *
 * 返回最终生效的路径（Rust 侧会建目录并试写一次，路径不合法/不可写会直接报错，
 * 而不是等下一次生成才失败）。
 */
export async function saveMediaOutputDir(value: string): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('save_media_output_dir', { value });
}

/** 用系统目录选择器挑一个落盘位置；用户取消返回 null。 */
export async function chooseMediaOutputDir(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, title: '选择默认落盘位置' });
  if (typeof selected !== 'string') return null;
  return selected.trim() || null;
}

/** 单个落盘目录（images / videos / audio）的清理结果。 */
export interface MediaCleanupKindReport {
  kind: string;
  dir: string;
  /** 目录里当前实际存在的文件数与总字节（含仍被引用的）。 */
  totalFileCount: number;
  totalBytes: number;
  /** 本轮被移进 `.quarantine` 的未引用文件（还在磁盘上，可恢复）。 */
  quarantinedFileCount: number;
  quarantinedBytes: number;
  /** 暂存区里超过保留期、被真正删除的文件。 */
  purgedFileCount: number;
  purgedBytes: number;
}

/** 一次媒体清理的结果。 */
export interface MediaCleanupReport {
  kinds: MediaCleanupKindReport[];
  quarantinedFileCount: number;
  quarantinedBytes: number;
  purgedFileCount: number;
  purgedBytes: number;
}

/**
 * 回收落盘目录里已经没人引用的媒体文件。
 *
 * 未被引用的文件不会当场删除，而是先移进各目录下的 `.quarantine`，放满保留期才清掉
 * —— 工程保存和引用落库之间有空隙，直接删会把还在用的文件删掉。
 *
 * 自动清理在每次保存/删除工程时顺带跑（有节流）；这个命令供「设置 → 通用 → 清理未引用文件」
 * 立即回收一次并拿到明细。
 */
export async function cleanupUnreferencedMedia(): Promise<MediaCleanupReport> {
  if (!isTauri()) {
    return {
      kinds: [],
      quarantinedFileCount: 0,
      quarantinedBytes: 0,
      purgedFileCount: 0,
      purgedBytes: 0,
    };
  }
  return invoke<MediaCleanupReport>('cleanup_unreferenced_media');
}

/** 一次「旧素材迁移」的结果。 */
export interface MediaMigrationReport {
  /** 当前生效的落盘位置（迁移目标）。 */
  targetRoot: string;
  /** 参与迁移的旧位置（不含目标本身）。 */
  sourceRoots: string[];
  copiedFiles: number;
  copiedBytes: number;
  /** 新位置里已有同名文件而跳过 —— 文件名就是内容 md5，同名即同内容。 */
  skippedFiles: number;
  failedFiles: number;
}

/**
 * 把旧落盘位置里的素材复制到当前位置。
 *
 * 是**复制**不是移动：画布/工程里存的是绝对路径，文件一旦离开旧目录，那些引用立刻失效
 * —— 刚经历过「原来的图片全变成损坏图标」的人不该再赌第二次。原文件一律保留，
 * 确认新位置无误后可由用户自行清理旧目录。
 */
export async function migrateMediaOutputFiles(): Promise<MediaMigrationReport> {
  if (!isTauri()) {
    return {
      targetRoot: '',
      sourceRoots: [],
      copiedFiles: 0,
      copiedBytes: 0,
      skippedFiles: 0,
      failedFiles: 0,
    };
  }
  return invoke<MediaMigrationReport>('migrate_media_output_files');
}
