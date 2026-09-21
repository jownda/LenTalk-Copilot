import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

/** 一个试听目标的三种状态。 */
export type AudioPreviewState = "idle" | "loading" | "playing";

/** 试听源: 现成的 URL, 或「点下去才去生成」的异步函数(内置音色试听就是后者, 按字符计费)。 */
export type AudioPreviewSource = string | undefined | null;

export interface AudioPreviewController {
  /** 当前正在取源 / 正在播的 key(`idle` 时为 null)。 */
  activeKey: string | null;
  /** 取某个 key 的状态 —— 只有 activeKey 会返回非 idle。 */
  stateOf: (key: string) => AudioPreviewState;
  /**
   * 点一下开始、再点一下停止。
   *
   * `key` 是「试听目标」的稳定标识(统一是 `voice:<音色 id>`), 不是音频地址 ——
   * 同一个目标换了地址(重新生成)也仍然算同一个目标, 动画不会闪断。
   */
  toggle: (key: string, resolve: () => AudioPreviewSource | Promise<AudioPreviewSource>) => void;
  stop: () => void;
  /** 播放失败的原因(展示用), 播下一条时自动清空。 */
  error: string | null;
}

/**
 * 音频试听的统一控制器 —— **整个音频节点只该有一个**。
 *
 * 为什么抽出来:
 *   1. 以前每个试听按钮各自 `new Audio(...)`, 结果可以同时放出三条声音, 而且
 *      点第二次既不重播也不停止(同一个 URL 的 play 会被浏览器忽略), 用户以为按钮坏了。
 *   2. 界面上没有任何「正在播」的状态 —— 点了没反馈。这里把 playingKey/loadingKey
 *      暴露出去, 由 `VoicePreviewButton` 渲染成跳动条。
 *
 * `requestRef` 那枚递增令牌是关键: 异步取源(内置音色要现场合成, 可能几秒)期间用户
 * 完全可能又点了另一个音色, 旧结果回来时必须**丢弃**, 否则会播出一个跟当前高亮不符的声音。
 */
export function useAudioPreview(): AudioPreviewController {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef(0);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 停掉当前声音并让所有在途的取源请求作废。 */
  const teardown = useCallback(() => {
    requestRef.current += 1;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    setLoadingKey(null);
    setPlayingKey(null);
  }, []);

  useEffect(() => teardown, [teardown]);

  const toggle = useCallback(
    (key: string, resolve: () => AudioPreviewSource | Promise<AudioPreviewSource>) => {
      // 同一个目标正在播 → 再点即停。
      if (playingKey === key) {
        teardown();
        return;
      }
      // 正在取源时忽略连点 —— 否则每点一次都会再发一次计费请求(内置音色是现场合成的)。
      if (loadingKey === key) return;

      teardown();
      const token = requestRef.current;
      setError(null);
      setLoadingKey(key);

      void (async () => {
        try {
          const source = await resolve();
          if (requestRef.current !== token) return;
          if (!source) {
            setLoadingKey(null);
            return;
          }
          const audio = new Audio(resolveImageDisplayUrl(source));
          audioRef.current = audio;
          audio.onended = () => setPlayingKey((current) => (current === key ? null : current));
          audio.onerror = () => {
            setPlayingKey((current) => (current === key ? null : current));
            setError(t("node.audioGen.previewFailed"));
          };
          setLoadingKey(null);
          setPlayingKey(key);
          await audio.play();
        } catch (previewError) {
          if (requestRef.current !== token) return;
          setLoadingKey(null);
          setPlayingKey(null);
          setError(previewError instanceof Error ? previewError.message : t("node.audioGen.previewFailed"));
        }
      })();
    },
    [loadingKey, playingKey, t, teardown],
  );

  const stateOf = useCallback(
    (key: string): AudioPreviewState =>
      playingKey === key ? "playing" : loadingKey === key ? "loading" : "idle",
    [loadingKey, playingKey],
  );

  return {
    activeKey: playingKey ?? loadingKey,
    stateOf,
    toggle,
    stop: teardown,
    error,
  };
}
