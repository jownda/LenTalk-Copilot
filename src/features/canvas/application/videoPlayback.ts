/**
 * 视频播放兼容性的纯判定逻辑。
 *
 * 背景：WebView2(Chromium 内核) 遇到**没有解码器**的视频轨(HEVC/H.265、ProRes 等)
 * 时，行为并不是抛错 —— 它会把视频轨**静默丢掉**，只保留音轨继续播。于是：
 *
 *   - `video.error` 恒为 `null`（不会触发元素的 `onError`）；
 *   - `duration` / `readyState` 一切正常，容器与音轨都解析成功；
 *   - 只有 `videoWidth` / `videoHeight` 是 `0`，画面区永远空白。
 *
 * 实测（本机 Chrome/WebView2 同源内核加载 hvc1 素材）：
 *   canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') === ''
 *   readyState=4, duration=15.069, videoWidth=0, videoHeight=0, error=null
 *
 * 项目原有的 H.264 播放代理只在 `onError` 时启动，因此这条「不报错」的路径必须显式
 * 补一道判定，否则节点会永远停在「只有声音、没有画面」。
 */

/** 判定所需的最小信息，直接从 `<video>` 元素读取即可。 */
export interface VideoTrackProbe {
  videoWidth: number;
  videoHeight: number;
  duration: number;
}

/**
 * 容器已经解析出有效时长，但视频轨没有被解码。
 *
 * 之所以要求 `duration > 0`：元数据尚未就绪时 `videoWidth` 同样是 0，那不是编码问题，
 * 不能据此触发转码。只有「时长已拿到 + 尺寸仍为 0」才是「视频轨被丢掉」的特征。
 */
export function isVideoTrackUndecoded(video: VideoTrackProbe): boolean {
  const hasDecodedDuration = Number.isFinite(video.duration) && video.duration > 0;
  return hasDecodedDuration && video.videoWidth <= 0 && video.videoHeight <= 0;
}
