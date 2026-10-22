// ---------------------------------------------------------------------------
// 集号识别：与引擎 src-tauri/resources/pajuben/pajuben.py 的 guess_ep() 是同一套
// 规则的镜像。两处必须保持一致，否则界面上显示的集号会和落盘的 `第N集.txt` 对不上。
//
// 旧引擎的兜底是「取文件名里第一段 1~3 位数字」，于是 uuid 命名的视频
// （node-16e678df-….mp4）会被写成「第16集」。现在只认明确的集号写法。
// ---------------------------------------------------------------------------

/**
 * 从视频文件名猜集号；认不出来一律返回 1。
 *
 * @param path 视频路径或文件名（目录分隔符与扩展名会被忽略，兼容 Windows 反斜杠）
 */
export function guessEpisodeFromVideoName(path: string): number {
  const base = path.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');

  const zhi = /第\s*(\d+)\s*集/.exec(name);
  if (zhi) return Number(zhi[1]);

  const ji = /(\d+)\s*集/.exec(name);
  if (ji) return Number(ji[1]);

  // S01E16 / s1e16
  const season = /[Ss]\d{1,3}\s*[Ee]\s*(\d{1,4})(?![0-9])/.exec(name);
  if (season) return Number(season[1]);

  // E16 / EP16 / -e16（前面必须是非字母数字，避免 uuid 里的 e6 被当集号）
  const ep = /(?:^|[^A-Za-z0-9])[Ee][Pp]?[-_. ]?(\d{1,4})(?![0-9])/.exec(name);
  if (ep) return Number(ep[1]);

  // 纯数字名：01 / 16 / [16] / （16）
  const pure = /^[\s[\]()（）【】]*(\d{1,4})[\s[\]()（）【】]*$/.exec(name);
  if (pure) return Number(pure[1]);

  // 不含拉丁字母的名字（9月19日.mp4）才允许取首段数字；
  // uuid / C6218 / IMG_20260207 这类含字母的名字一律不猜。
  if (!/[A-Za-z]/.test(name)) {
    const loose = /(\d{1,3})/.exec(name);
    if (loose) return Number(loose[1]);
  }

  return 1;
}

/** 单集模式下「集号」留空时，界面提示用：把识别过程与结果讲清楚。 */
export function describeEpisodeGuess(path: string): { episode: number; recognized: boolean } {
  const episode = guessEpisodeFromVideoName(path);
  const base = path.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  // 认出来的情况一定命中显式写法；只落到 1 且名字里本来就没有 1 时视为「没认出来」。
  const explicit =
    /第\s*\d+\s*集/.test(name) ||
    /\d+\s*集/.test(name) ||
    /[Ss]\d{1,3}\s*[Ee]\s*\d{1,4}(?![0-9])/.test(name) ||
    /(?:^|[^A-Za-z0-9])[Ee][Pp]?[-_. ]?\d{1,4}(?![0-9])/.test(name) ||
    /^[\s[\]()（）【】]*\d{1,4}[\s[\]()（）【】]*$/.test(name) ||
    (!/[A-Za-z]/.test(name) && /\d{1,3}/.test(name));
  return { episode, recognized: explicit };
}
