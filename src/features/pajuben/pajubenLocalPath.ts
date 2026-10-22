// ---------------------------------------------------------------------------
// 「扒视频」的前置校验：引擎只吃本机文件。
//
// 视频节点的 `sourcePath` 有两种形态：
//   - 本机绝对路径（`C:\Users\...\jimeng-cli\videos\...\x.mp4`）—— 可以直接扒；
//   - 远端地址（炳火那类平台回 OSS 链接 `https://.../x.mp4`）—— 必须先下载。
// `pajuben_run` 会先 `Path::exists()`，远端地址只会得到一句「路径不存在」，
// 所以这里提前拦住并给出人话。
// ---------------------------------------------------------------------------

export function isLocalVideoPath(path: string): boolean {
  const value = path.trim();
  if (!value) return false;
  // Windows 盘符（C:\ 或 C:/）
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  // UNC 共享路径 \\server\share
  if (value.startsWith('\\\\')) return true;
  // POSIX 绝对路径 /Users/...
  if (value.startsWith('/')) return true;
  return false;
}
