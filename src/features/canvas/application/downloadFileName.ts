/**
 * 把节点标题变成能落盘的文件名。
 *
 * 节点标题不等于短名字：实测有音视频节点的 `displayName` 被写进了一整段提示词
 * （1835 个字符、含大量换行）。直接拿去当文件名会撞 Windows 的两条硬限制 ——
 *
 * - 单个路径组件最多 255 个 UTF-16 单元；
 * - 结尾不能是空格或点。
 *
 * 超了报的是 `ERROR_INVALID_NAME`（os error 123），提示语「文件名、目录名或卷标语法
 * 不正确」完全看不出是「名字太长」，所以这里必须先压再截，别指望后端兜底。
 */

/** 建议文件名最多保留多少个字符（与 Rust 侧 `MAX_FILE_STEM_CHARS` 保持一致）。 */
const MAX_FILE_STEM_CHARS = 80;

export function buildDownloadFileName(
  displayName: string | null | undefined,
  fallback: string,
): string {
  const compacted = (displayName ?? "")
    // 这些字符在 Windows 上非法，直接换成空格（换成下划线会把中英混排切得很碎）。
    .replace(/[\\/:*?"<>|]/g, " ")
    // 换行、制表符、连续空格一律压成一个空格。
    .replace(/\s+/g, " ")
    .trim();

  // 按**字符**截断，避免把 emoji 的代理对切成半个。
  const truncated = Array.from(compacted)
    .slice(0, MAX_FILE_STEM_CHARS)
    .join("")
    .replace(/[.\s]+$/, "");

  return truncated || fallback;
}
