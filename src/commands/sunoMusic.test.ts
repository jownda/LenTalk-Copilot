import { describe, expect, it } from "vitest";

import {
  buildSunoMusicBody,
  describeSunoValidation,
  extractSunoClipId,
  extractSunoFileUrls,
  extractSunoLyricsText,
  extractSunoTaskId,
  isSunoFailureState,
  isSunoMusicModel,
  normalizeSunoMode,
  normalizeSunoOperation,
  normalizeSunoVersion,
  normalizeSunoVocalGender,
  readSunoTaskStatus,
  resolveSunoMusicOperation,
  resolveSunoTaskPath,
  SUNO_MEDIA_OPERATIONS,
  SUNO_OPERATION_SPECS,
  validateSunoMusicInput,
} from "./sunoMusic";

/**
 * Suno 链路的协议回归。
 *
 * 这层最贵的错误是**静默放行**: 平台按提交次数计费(⚡0.17/次), 参数错了也是在扣费
 * 之后才报错, 所以「模型判定」「必填校验」「请求体形状」三者错一个就是一次白扣费。
 */

describe("resolveSunoMusicOperation", () => {
  it("只认知鸟 Suno 的模型 id", () => {
    expect(resolveSunoMusicOperation("music")).toBe("generate");
    expect(resolveSunoMusicOperation("MUSIC")).toBe("generate");
  });

  it("不吃别家的音乐模型 —— 它们的协议完全不同", () => {
    // 字子动画: /v1/audio/music + metadata{lyrics_text, music_length_ms}
    expect(resolveSunoMusicOperation("music-2.6")).toBeNull();
    expect(resolveSunoMusicOperation("music-cover")).toBeNull();
    // FHL: OpenAI 兼容
    expect(resolveSunoMusicOperation("suno-v3")).toBeNull();
    // 同平台的语音模型不该被当成音乐
    expect(resolveSunoMusicOperation("speech-2.8")).toBeNull();
    expect(resolveSunoMusicOperation("tts-1")).toBeNull();
    expect(resolveSunoMusicOperation("")).toBeNull();
    expect(resolveSunoMusicOperation(undefined)).toBeNull();

    expect(isSunoMusicModel("music")).toBe(true);
    expect(isSunoMusicModel("music-2.6")).toBe(false);
  });
});

describe("operations", () => {
  it("媒体操作 7 个, lyrics 被摘出去(它产出文本而不是媒体)", () => {
    expect(SUNO_MEDIA_OPERATIONS).toHaveLength(7);
    expect(SUNO_MEDIA_OPERATIONS).not.toContain("lyrics");
    expect(SUNO_OPERATION_SPECS.lyrics.output).toBe("text");
  });

  it("源 clip 字段按 param_schema 逐条对得上", () => {
    expect(SUNO_OPERATION_SPECS.generate.clipSource).toBeNull();
    expect(SUNO_OPERATION_SPECS.lyrics.clipSource).toBeNull();
    expect(SUNO_OPERATION_SPECS.extend.clipSource).toBe("continue_clip_id");
    expect(SUNO_OPERATION_SPECS.cover.clipSource).toBe("cover_clip_id");
    for (const operation of ["stems", "stems_all", "mp4", "concat"] as const) {
      expect(SUNO_OPERATION_SPECS[operation].clipSource).toBe("clip_id");
    }
  });

  it("只有 mp4 产出视频, 分离类是多轨", () => {
    expect(SUNO_OPERATION_SPECS.mp4.output).toBe("video");
    expect(SUNO_OPERATION_SPECS.stems.multiTrack).toBe(true);
    expect(SUNO_OPERATION_SPECS.stems_all.multiTrack).toBe(true);
    expect(SUNO_OPERATION_SPECS.generate.multiTrack).toBe(false);
  });
});

describe("buildSunoMusicBody", () => {
  it("generate: 顶层扁平字段, 且有 version/mode/vocal_gender", () => {
    const body = buildSunoMusicBody("music", {
      operation: "generate",
      prompt: "古风 治愈",
      version: "chirp-v6",
      mode: "song",
      style: "古风, 钢琴",
      lyrics: "山高水长",
      title: "归途",
      vocalGender: "f",
      negativeTags: "重金属",
    });
    expect(body).toMatchObject({
      model: "music",
      operation: "generate",
      input: "古风 治愈",
      version: "chirp-v6",
      mode: "song",
      style: "古风, 钢琴",
      lyrics: "山高水长",
      title: "归途",
      vocal_gender: "f",
      negative_tags: "重金属",
    });
  });

  it("不再发字子动画的 metadata 信封, 也不再发 music_length_ms / voice", () => {
    const body = buildSunoMusicBody("music", { operation: "generate", prompt: "x" });
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("music_length_ms");
    // Suno 的 param_schema 里没有 voice —— 旧 UI 那个「演唱音色」是凭空造的。
    expect(body).not.toHaveProperty("voice");
  });

  it("pure instrumental: 不发 vocal_gender(param_schema 原文「纯音乐模式无效」)", () => {
    const body = buildSunoMusicBody("music", {
      operation: "generate",
      prompt: "x",
      mode: "instrumental",
      vocalGender: "m",
    });
    expect(body.mode).toBe("instrumental");
    expect(body).not.toHaveProperty("vocal_gender");
  });

  it("非法枚举值退回默认, 不把平台不认的值发出去", () => {
    const body = buildSunoMusicBody("music", {
      operation: "generate",
      prompt: "x",
      version: "chirp-v99",
      mode: "karaoke",
      vocalGender: "x",
    });
    expect(body.version).toBe("chirp-v6");
    expect(body.mode).toBe("song");
    expect(body.vocal_gender).toBe("auto");
  });

  it("stems: 只带 clip_id, 不带生成类字段", () => {
    const body = buildSunoMusicBody("music", {
      operation: "stems",
      clipId: "clip-abc",
      style: "不该出现",
      lyrics: "不该出现",
      version: "chirp-v5",
    });
    expect(body).toMatchObject({ model: "music", operation: "stems", clip_id: "clip-abc" });
    expect(body).not.toHaveProperty("style");
    expect(body).not.toHaveProperty("lyrics");
    expect(body).not.toHaveProperty("version");
  });

  it("extend: continue_clip_id + continue_at, 只有数值才带起点", () => {
    const withAt = buildSunoMusicBody("music", {
      operation: "extend",
      continueClipId: "clip-1",
      continueAt: "12.5",
    });
    expect(withAt.continue_clip_id).toBe("clip-1");
    expect(withAt.continue_at).toBe("12.5");

    // 「不传默认从结尾续」—— 非法值宁可漏发也不发一个看不懂的字符串。
    const withoutAt = buildSunoMusicBody("music", {
      operation: "extend",
      continueClipId: "clip-1",
      continueAt: "abc",
    });
    expect(withoutAt).not.toHaveProperty("continue_at");
  });

  it("cover: 只带 cover_clip_id", () => {
    const body = buildSunoMusicBody("music", { operation: "cover", coverClipId: "clip-2", prompt: "爵士" });
    expect(body.cover_clip_id).toBe("clip-2");
    expect(body).not.toHaveProperty("clip_id");
    expect(body).not.toHaveProperty("continue_clip_id");
  });
});

describe("validateSunoMusicInput", () => {
  it("生成需要主题", () => {
    expect(validateSunoMusicInput({ operation: "generate" })).toBe("needPrompt");
    expect(validateSunoMusicInput({ operation: "generate", prompt: "   " })).toBe("needPrompt");
    expect(validateSunoMusicInput({ operation: "generate", prompt: "城市夜景 lo-fi" })).toBeNull();
  });

  it("后处理操作缺源 clip 就地拦住(别扣了费再报错)", () => {
    expect(validateSunoMusicInput({ operation: "stems" })).toBe("needClipId");
    expect(validateSunoMusicInput({ operation: "concat", clipId: "c" })).toBeNull();
    expect(validateSunoMusicInput({ operation: "extend" })).toBe("needContinueClipId");
    expect(validateSunoMusicInput({ operation: "cover" })).toBe("needCoverClipId");
  });

  it("后处理操作不需要主题", () => {
    expect(validateSunoMusicInput({ operation: "stems_all", clipId: "c" })).toBeNull();
    expect(validateSunoMusicInput({ operation: "mp4", clipId: "c" })).toBeNull();
  });

  it("每种失败都有中文兜底文案", () => {
    for (const key of ["needClipId", "needContinueClipId", "needCoverClipId", "needPrompt"]) {
      expect(describeSunoValidation(key)).not.toBe(key);
    }
  });
});

describe("extractSunoFileUrls", () => {
  it("结果里同时有音频和封面图时, 取音频", () => {
    const payload = {
      data: {
        clips: [
          {
            image_url: "https://cdn.example.com/cover.jpg",
            audio_url: "https://cdn.example.com/song.mp3",
          },
        ],
      },
    };
    expect(extractSunoFileUrls(payload)[0]).toBe("https://cdn.example.com/song.mp3");
  });

  it("分离类: 人声轨优先", () => {
    const payload = {
      result: {
        instrumental_url: "https://cdn.example.com/inst.mp3",
        vocal_url: "https://cdn.example.com/vocal.mp3",
      },
    };
    expect(extractSunoFileUrls(payload)[0]).toBe("https://cdn.example.com/vocal.mp3");
  });

  it("wantsVideo 时优先 mp4", () => {
    const payload = {
      data: { audio_url: "https://cdn.example.com/song.mp3", video_url: "https://cdn.example.com/clip.mp4" },
    };
    expect(extractSunoFileUrls(payload, { wantsVideo: true })[0]).toBe("https://cdn.example.com/clip.mp4");
    expect(extractSunoFileUrls(payload)[0]).toBe("https://cdn.example.com/song.mp3");
  });

  it("只有封面图时返回空 —— 宁可报「没有产出」也不要拿图片当音频", () => {
    expect(extractSunoFileUrls({ data: { image_url: "https://cdn.example.com/cover.png" } })).toEqual([]);
  });

  it("data:audio/... 也能识别", () => {
    const urls = extractSunoFileUrls({ audio: "data:audio/mp3;base64,AAAA" });
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith("data:audio/")).toBe(true);
  });
});

describe("任务与响应解析", () => {
  it("任务 ID 在顶层或嵌套里都能捞到", () => {
    expect(extractSunoTaskId({ task_id: "t1" })).toBe("t1");
    expect(extractSunoTaskId({ data: { id: "t2" } })).toBe("t2");
    expect(extractSunoTaskId({ code: 0 })).toBeNull();
  });

  it("状态读取同时认 state 与 status", () => {
    expect(readSunoTaskStatus({ state: "success" })).toBe("SUCCESS");
    expect(readSunoTaskStatus({ data: { status: "completed" } })).toBe("COMPLETED");
    expect(readSunoTaskStatus({ nothing: true })).toBe("");
  });

  it("失败态判定包含常见写法", () => {
    for (const state of ["failed", "FAILURE", "error", "canceled", "rejected", "expired"]) {
      expect(isSunoFailureState(state)).toBe(true);
    }
    expect(isSunoFailureState("success")).toBe(false);
    expect(isSunoFailureState("running")).toBe(false);
  });

  it("clip 标识优先取 source_id", () => {
    expect(extractSunoClipId({ data: { source_id: "src-1", clip_id: "clip-1" } })).toBe("src-1");
    expect(extractSunoClipId({ clip_id: "clip-2" })).toBe("clip-2");
    expect(extractSunoClipId({ audio_url: "https://x/a.mp3" })).toBeNull();
  });

  it("歌词文本抽取不把 URL 当歌词", () => {
    expect(extractSunoLyricsText({ data: { lyrics: "[Verse]\n夜色" } })).toBe("[Verse]\n夜色");
    expect(extractSunoLyricsText({ data: { audio_url: "https://cdn/x.mp3" } })).toBeNull();
  });

  it("任务路径走网关统一的 /v1/tasks, 不做字符串拼接", () => {
    expect(resolveSunoTaskPath("abc")).toBe("/v1/tasks/abc");
    expect(resolveSunoTaskPath("a/b c")).toBe("/v1/tasks/a%2Fb%20c");
  });
});

describe("normalize*", () => {
  it("非法值一律退回默认", () => {
    expect(normalizeSunoOperation("stems_all")).toBe("stems_all");
    expect(normalizeSunoOperation("nope")).toBe("generate");
    expect(normalizeSunoVersion("chirp-v4-5")).toBe("chirp-v4-5");
    expect(normalizeSunoVersion("")).toBe("chirp-v6");
    expect(normalizeSunoMode("Instrumental")).toBe("instrumental");
    expect(normalizeSunoMode("")).toBe("song");
    expect(normalizeSunoVocalGender("F")).toBe("f");
    expect(normalizeSunoVocalGender("")).toBe("auto");
  });
});
