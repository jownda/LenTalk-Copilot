/**
 * 媒体数值的统一格式化。
 *
 * 画布上「悬停标注」和「节点属性」都要显示体积/尺寸/时长，格式必须一致，
 * 否则同一张图在两处显示成 `1.2 MB` 和 `1234 KB`。这里只放纯函数，不做探测。
 */

/** 字节数 → 可读体积。非正数、NaN、Infinity 一律返回 null，由调用方决定要不要显示。 */
export function formatByteSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // B 与 KB 不带小数, 更大的单位保留一位, 避免出现 `1024.0 KB` 这类冗余精度。
  const rounded = unitIndex <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/** 像素尺寸 → `1920 × 1080 px`。任一维度非法时返回 null。 */
export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return `${Math.round(width)} × ${Math.round(height)} px`;
}

/** 秒 → `m:ss`,超过一小时用 `h:mm:ss`。用于音视频的真实时长。 */
export function formatDurationSeconds(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** 毫秒 → 便于阅读的等待时长,例如 `45 秒` / `2 分 30 秒`。 */
export function formatDurationMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 毫秒时间戳 → 本地时间文本(`2026-10-25 09:30:12`)。 */
export function formatTimestamp(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 从媒体地址推断格式标签(PNG / MP4 / MP3 ...)。
 * 兼容 data URL 的 MIME 与普通扩展名; `blob:`、无扩展名的 CDN 地址返回 null。
 */
export function resolveMediaFormatLabel(source: string | null | undefined): string | null {
  const trimmed = source?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("data:")) {
    const mime = trimmed.slice(5).split(/[;,]/)[0]?.trim().toLowerCase();
    const subtype = mime?.split("/")[1];
    return subtype ? subtype.replace("x-", "").replace("mpeg", "mp3").toUpperCase() : null;
  }
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? "";
  // 只看最后一段路径: `blob:http://127.0.0.1/abc` 里的点属于主机名,不能当扩展名。
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  const extension = lastSegment.slice(dotIndex + 1).toLowerCase();
  // 扩展名只可能是 2-5 位字母数字; 不满足说明这是普通路径而不是文件名。
  if (!/^[a-z0-9]{2,5}$/.test(extension)) {
    return null;
  }
  return extension === "jpeg" ? "JPG" : extension.toUpperCase();
}
