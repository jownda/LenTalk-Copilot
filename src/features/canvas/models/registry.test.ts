import { describe, expect, it } from "vitest";

import {
  JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID,
  JIMENG_CLI_PROVIDER_ID,
  RUNNINGHUB_CLI_PROVIDER_ID,
  getImageModel,
  isApiKeylessProvider,
  listAudioModels,
  matchesAudioCreativePanel,
  listImageModels,
  listImageUpscaleModels,
  listVideoModels,
} from "./registry";
import { JIMENG_CLI_IMAGE_UPSCALE_MODEL } from "@/commands/ai";
import { resolveModelPriceDisplay } from "@/features/canvas/pricing";
import { isVideoGenerationModelName, useSettingsStore, type CustomApiProvider } from "@/stores/settingsStore";
import { recommendedApis, type RecommendedApi } from "@/features/settings/recommendedApis";
import type { AudioCreativePanel } from "./types";

describe("isVideoGenerationModelName", () => {
  it.each([
    "bh2.0-720p",
    "SD2.5-1080p",
    "rd2.5-720p",
    "wan3.0-720p",
    "gz-sd2.5-480p",
    "sdvip4k",
    "quanneng2.0",
    "tj-sp2.5",
    "video2.0",
    "seedance2.5",
  ])("recognizes %s as a video model", (model) => {
    expect(isVideoGenerationModelName(model)).toBe(true);
  });

  it.each(["gemini-3-pro-image-preview", "gpt-image-2", "sdxl", "qwen-image"])(
    "keeps %s out of the video list",
    (model) => {
      expect(isVideoGenerationModelName(model)).toBe(false);
    },
  );
});

describe("listVideoModels", () => {
  it("prices 知鸟 AI models from the built-in table (含 MJ 按组翻倍与视频按秒)", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zhiniao: CustomApiProvider = {
      id: "知鸟ai",
      name: "知鸟AI",
      baseUrl: "https://cuai.token6688.com",
      apiKey: "",
      models: ["mj_imagine", "gpt-image-2"],
      videoModels: ["seedance-2-5", "veo-3.1"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "images" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    };

    useSettingsStore.setState({ customApis: [zhiniao] });
    try {
      const imageModels = listImageModels();
      const videoModels = listVideoModels();
      const gptImage = imageModels.find((model) => model.id.endsWith("/gpt-image-2"));
      const midjourney = imageModels.find((model) => model.id.endsWith("/mj_imagine"));
      const seedance = videoModels.find((model) => model.id.endsWith("/seedance-2-5"));
      const veo = videoModels.find((model) => model.id.endsWith("/veo-3.1"));

      expect(gptImage?.pricing).toBeDefined();
      expect(resolveModelPriceDisplay(gptImage!, { resolution: "1K", language: "zh-CN" })?.label).toContain("0.03");

      // 一组 4 张按次计费；count 是组数，两组就该翻倍。
      const oneGroup = resolveModelPriceDisplay(midjourney!, {
        resolution: "1K",
        extraParams: { count: 1 },
        language: "zh-CN",
      })?.label;
      const twoGroups = resolveModelPriceDisplay(midjourney!, {
        resolution: "1K",
        extraParams: { count: 2 },
        language: "zh-CN",
      })?.label;
      expect(oneGroup).toContain("0.09");
      expect(twoGroups).toContain("0.17");

      // 按秒：时长变了价格就得变。
      const shortClip = resolveModelPriceDisplay(seedance!, {
        resolution: "720P",
        extraParams: { duration: 5 },
        language: "zh-CN",
      })?.label;
      const longClip = resolveModelPriceDisplay(seedance!, {
        resolution: "720P",
        extraParams: { duration: 10 },
        language: "zh-CN",
      })?.label;
      expect(shortClip).not.toEqual(longClip);

      // 按次：时长不影响价格。
      const veoShort = resolveModelPriceDisplay(veo!, {
        resolution: "720P",
        extraParams: { duration: 5 },
        language: "zh-CN",
      })?.label;
      const veoLong = resolveModelPriceDisplay(veo!, {
        resolution: "720P",
        extraParams: { duration: 20 },
        language: "zh-CN",
      })?.label;
      expect(veoShort).toContain("0.87");
      expect(veoLong).toEqual(veoShort);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("prices 字字动画 models from the 2026-10-23 platform sync", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zzdh: CustomApiProvider = {
      id: "zizidonghua",
      name: "字字动画",
      baseUrl: "https://zizidonghua.com",
      apiKey: "",
      models: ["qwen-image-3.0", "qwen-image-max"],
      // 对口型是靠 ZZDH_LIP_SYNC_MODEL_NAMES 自动补进来的, 不需要用户手动登记。
      videoModels: ["doubao-seedance-2-720p"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "images" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    };

    useSettingsStore.setState({ customApis: [zzdh] });
    try {
      const imageModels = listImageModels();
      const videoModels = listVideoModels();
      const qwenImage = imageModels.find((model) => model.id.endsWith("/qwen-image-3.0"));
      const seedance = videoModels.find((model) => model.id.endsWith("/doubao-seedance-2-720p"));
      const lipSync = videoModels.find((model) => model.id.includes("限时优惠-对口型-480p"));

      // 图片按次: 0.21 元/张, 与分辨率档位无关。
      expect(resolveModelPriceDisplay(qwenImage!, { resolution: "2K", language: "zh-CN" })?.label).toContain(
        "0.21",
      );
      // 视频按秒: 0.70 元/秒 → 5 秒 3.50, 10 秒 7.00(2026-10-23 前是 1.09, 会算成 5.45)。
      expect(
        resolveModelPriceDisplay(seedance!, { resolution: "720P", extraParams: { duration: 5 }, language: "zh-CN" })
          ?.label,
      ).toContain("3.50");
      expect(
        resolveModelPriceDisplay(seedance!, { resolution: "720P", extraParams: { duration: 10 }, language: "zh-CN" })
          ?.label,
      ).toContain("7.00");
      // 对口型限时优惠档 0.04 元/秒。
      expect(
        resolveModelPriceDisplay(lipSync!, { resolution: "480P", extraParams: { duration: 5 }, language: "zh-CN" })
          ?.label,
      ).toContain("0.20");
      // 平台已下架的模型宁可不报价, 也不要留一个旧价格。
      const delisted = imageModels.find((model) => model.id.endsWith("/qwen-image-max"));
      expect(resolveModelPriceDisplay(delisted!, { resolution: "1K", language: "zh-CN" })).toBeNull();
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("opens kling-v4 up to 30s and defaults brand-new 知鸟 models to 30s", () => {
    // 用户规则（2026-10-19）：可灵 v4 平台支持 30s，但之前被限制成 15s；
    // 以后平台新上、我们还没核过枚举的模型，一律先给到 30s 并默认 30s。
    // 一旦某个模型在 ZHNIAO_VIDEO_OPTION_TABLE 里登记了真实枚举，就改听登记表。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zhiniao: CustomApiProvider = {
      id: "知鸟ai",
      name: "知鸟AI",
      baseUrl: "https://cuai.token6688.com",
      apiKey: "",
      models: [],
      videoModels: ["kling-v4", "kling-v9-unlisted", "seedance-2-0-official"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "images" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    };

    useSettingsStore.setState({ customApis: [zhiniao] });
    try {
      const videoModels = listVideoModels();
      const klingV4 = videoModels.find((model) => model.id.endsWith("/kling-v4"));
      const unlisted = videoModels.find((model) => model.id.endsWith("/kling-v9-unlisted"));
      const seedance = videoModels.find((model) => model.id.endsWith("/seedance-2-0-official"));

      // 登记过：文档给的是 3~30 的逐秒枚举，中间秒数必须有（16~29 曾经整段选不到）
      expect(klingV4?.durationOptions).toEqual([
        3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      ]);
      expect(klingV4?.durationOptions).toContain(18);
      expect(klingV4?.defaultDuration).toBe(30);

      // 没登记的新模型：同样给到 30s，默认也是 30s
      expect(unlisted?.durationOptions).toContain(30);
      expect(unlisted?.defaultDuration).toBe(30);

      // 已登记、上限本来就只有 15s 的模型不受影响（别把不支持的档位塞给它）
      expect(seedance?.durationOptions).not.toContain(30);
      expect(seedance?.defaultDuration).toBe(5);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("api666888 按模型登记真实档位（2.5 = 4~30 逐秒 / 2.0 = 4~15 / 默认取最大档）", () => {
    // 文档(2026-10-19): duration 是逐秒枚举, 不是 5/10/15 这种稀疏档。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const api666888: CustomApiProvider = {
      id: "api666888",
      name: "API666888",
      baseUrl: "https://api666888.com",
      apiKey: "",
      models: [],
      videoModels: ["seedance-2.5-anmiao-wensheng", "seedance-2.0-guanfang-anmiao"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "image" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    };

    useSettingsStore.setState({ customApis: [api666888] });
    try {
      const videoModels = listVideoModels();
      const twoFive = videoModels.find((model) => model.id.endsWith("/seedance-2.5-anmiao-wensheng"));
      const twoZero = videoModels.find((model) => model.id.endsWith("/seedance-2.0-guanfang-anmiao"));

      expect(twoFive?.durationOptions[0]).toBe(4);
      expect(twoFive?.durationOptions[twoFive.durationOptions.length - 1]).toBe(30);
      expect(twoFive?.durationOptions).toContain(18);
      expect(twoFive?.resolutions?.map((item) => item.value)).toEqual(["480p", "720p", "1080p"]);
      // 2026-10-20 起档位来自平台逐模型登记表(lingkeVideoOptions.ts):
      // 默认秒数 = 该模型支持的最大档(上限 30), 不再统一取最短档。
      expect(twoFive?.defaultDuration).toBe(30);
      expect(twoFive?.aspectRatios.map((item) => item.value)).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);

      expect(twoZero?.durationOptions[twoZero.durationOptions.length - 1]).toBe(15);
      expect(twoZero?.resolutions?.map((item) => item.value)).toContain("4K");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("api666888 换成任意官方/白标域名后档位照样生效(baseUrl 兜底)", () => {
    // 官方主域名 api.lk888.ai、备用 api.lk666.ai, 加上历史出现过的 api.lingkeai.ai /
    // api666888.com, 全都要认。id 也不能只靠 `api666888` 命中 —— 平台名派生出来的
    // id 可能是 `custom:api-666888`, 这条用例锁住 baseUrl 分支。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const makeGateway = (baseUrl: string): CustomApiProvider => ({
      id: "custom:api-666888",
      name: "灵柯AI",
      baseUrl,
      apiKey: "",
      models: [],
      videoModels: ["seedance-2.5-anmiao"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "image" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    });

    try {
      for (const baseUrl of [
        "https://api.lk888.ai",
        "https://api.lk888.ai/v1",
        "https://api.lk666.ai",
        "https://api.lingkeai.ai",
        "https://api666888.com",
      ]) {
        useSettingsStore.setState({ customApis: [makeGateway(baseUrl)] });
        const model = listVideoModels().find((item) => item.id.endsWith("/seedance-2.5-anmiao"));
        expect(model?.durationOptions[0], `${baseUrl} 丢了最短档`).toBe(4);
        expect(model?.durationOptions, `${baseUrl} 丢了 23 秒档`).toContain(23);
        expect(model?.durationOptions, `${baseUrl} 丢了 30 秒档`).toContain(30);
      }

      // 无关域名不能被误判成灵柯, 否则任何自定义平台都会套上它的档位表。
      // gk-video-3.5 在灵柯表里只有 5 种画幅(16:9 / 9:16 / 1:1 / 3:2 / 2:3),
      // 通用表是 10 种 —— 用画幅数量区分, 时长表在两边都是 4~30 逐秒, 分不出来。
      useSettingsStore.setState({
        customApis: [{ ...makeGateway("https://api.openai.com"), videoModels: ["gk-video-3.5"] }],
      });
      const outsider = listVideoModels().find((item) => item.id.endsWith("/gk-video-3.5"));
      expect(outsider?.aspectRatios).toHaveLength(10);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("prices WGSPAI models from the built-in table (图片按张、视频按次/按秒)", () => {
    // 价格来自平台自己的 GET /api/pricing(2026-10-18 实测), 三款图片都是 0.1 元/张;
    // 视频大多按次一口价, 唯一按秒的是 seedance-2.0-720-new(0.25 元/秒)。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const wgspai: CustomApiProvider = {
      id: "wgspai",
      name: "Wgspai",
      baseUrl: "https://api.wgspai.cn",
      apiKey: "",
      models: ["gpt-image-2-2k", "nano-banana-2"],
      videoModels: ["seedance-v2-720p", "seedance-2.0-720-new"],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "image" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    };

    useSettingsStore.setState({ customApis: [wgspai] });
    try {
      const imageModels = listImageModels();
      const videoModels = listVideoModels();
      const single = imageModels.find((model) => model.id.endsWith("/gpt-image-2-2k"));
      const nano = imageModels.find((model) => model.id.endsWith("/nano-banana-2"));
      const perCall = videoModels.find((model) => model.id.endsWith("/seedance-v2-720p"));
      const perSecond = videoModels.find((model) => model.id.endsWith("/seedance-2.0-720-new"));

      expect(
        resolveModelPriceDisplay(single!, {
          resolution: "1K",
          extraParams: { count: 1 },
          language: "zh-CN",
        })?.label,
      ).toContain("0.1");
      // 按张：4 张 = 4 倍价。
      expect(
        resolveModelPriceDisplay(single!, {
          resolution: "1K",
          extraParams: { count: 4 },
          language: "zh-CN",
        })?.label,
      ).toContain("0.4");
      expect(nano?.pricing).toBeDefined();

      // 按次：时长不影响价格。
      const callShort = resolveModelPriceDisplay(perCall!, {
        resolution: "720P",
        extraParams: { duration: 5 },
        language: "zh-CN",
      })?.label;
      const callLong = resolveModelPriceDisplay(perCall!, {
        resolution: "720P",
        extraParams: { duration: 15 },
        language: "zh-CN",
      })?.label;
      expect(callShort).toContain("5.5");
      expect(callLong).toEqual(callShort);

      // 按秒：时长变了价格就得变。
      const secondShort = resolveModelPriceDisplay(perSecond!, {
        resolution: "720P",
        extraParams: { duration: 5 },
        language: "zh-CN",
      })?.label;
      const secondLong = resolveModelPriceDisplay(perSecond!, {
        resolution: "720P",
        extraParams: { duration: 15 },
        language: "zh-CN",
      })?.label;
      expect(secondShort).not.toEqual(secondLong);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("uses synced official prices for custom image/video models", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const frame = {
      id: "zhenjian",
      name: "帧间 API",
      baseUrl: "https://www.zhenjian.work",
      apiKey: "",
      models: ["image-model"],
      videoModels: ["video-model"],
      audioModels: [],
      chatModels: [],
      modelPrices: { "image-model": 0.24, "video-model": 1.5 },
      createdAt: Date.now(),
      requestMode: "sync" as const,
      protocol: "images" as const,
      referenceImageField: "image" as const,
      referenceImageEncoding: "auto" as const,
      imageTransport: "generations_json" as const,
    } satisfies CustomApiProvider;

    useSettingsStore.setState({ customApis: [frame] });
    try {
      const image = listImageModels().find((model) => model.id.endsWith("/image-model"));
      const video = listVideoModels().find((model) => model.id.endsWith("/video-model"));
      expect(
        resolveModelPriceDisplay(image!, {
          resolution: "1K",
          language: "zh-CN",
        })?.label,
      ).toContain("0.24");
      expect(
        resolveModelPriceDisplay(video!, {
          resolution: "720p",
          extraParams: { duration: 5 },
          language: "zh-CN",
        })?.label,
      ).toContain("1.50");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("locks Sub2API Seedance durations, resolution, and aspect ratios", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const sub2Api: CustomApiProvider = {
      id: "sub2api-video",
      name: "Sub2API 视频",
      baseUrl: "https://video.rjm.us.ci",
      apiKey: "",
      models: [],
      videoModels: ["seedance2.0", "seedance2.5"],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "data_url",
      imageTransport: "auto",
    };

    useSettingsStore.setState({ customApis: [sub2Api] });
    try {
      const models = listVideoModels();
      const seedance20 = models.find((model) => model.id.endsWith("/seedance2.0"));
      const seedance25 = models.find((model) => model.id.endsWith("/seedance2.5"));

      expect(seedance20?.displayName).toContain("Seedance 2.0");
      expect(seedance20?.durationOptions).toEqual([15]);
      expect(seedance20?.defaultDuration).toBe(15);
      expect(seedance20?.resolutions?.map((option) => option.value)).toEqual(["480p", "720p", "1080p", "4k"]);
      expect(seedance20?.aspectRatios.map((option) => option.value)).toEqual(["16:9", "9:16"]);

      expect(seedance25?.displayName).toContain("Seedance 2.5");
      expect(seedance25?.durationOptions).toEqual([30]);
      expect(seedance25?.defaultDuration).toBe(30);
      expect(seedance25?.resolutions?.map((option) => option.value)).toEqual(["480p", "720p"]);
      expect(seedance25?.aspectRatios.map((option) => option.value)).toEqual(["16:9", "9:16"]);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("gives WGSPAI models their documented duration and aspect options", () => {
    // 回归: WGSPAI 曾被并进炳火的档位表, 于是 seedance2.5(固定 30 秒按次计费)
    // 落到默认的 4~15 秒 —— 下拉里选 12 秒, 平台照 30 秒出片。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const wgspai: CustomApiProvider = {
      id: "wgspai",
      name: "WGSPAI 视频",
      baseUrl: "https://api.wgspai.cn",
      apiKey: "",
      models: [],
      videoModels: ["seedance2.5", "seedance-v2-720p", "Minimax-h3", "sd-2", "LongXia-O-sora2-pro-8s-9x16"],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "url",
      imageTransport: "auto",
    };

    useSettingsStore.setState({ customApis: [wgspai] });
    try {
      const models = listVideoModels();
      const byModel = (suffix: string) => models.find((model) => model.id.endsWith(`/${suffix}`));

      // seedance2.5: 固定 30 秒, 白名单 9:16 / 16:9 / 1:1。
      expect(byModel("seedance2.5")?.durationOptions).toEqual([30]);
      expect(byModel("seedance2.5")?.defaultDuration).toBe(30);
      expect(byModel("seedance2.5")?.aspectRatios.map((option) => option.value)).toEqual(["9:16", "16:9", "1:1"]);

      // seedance-v2-720p: 4~15 秒整数, 且只给 9:16 / 16:9。
      expect(byModel("seedance-v2-720p")?.durationOptions).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(byModel("seedance-v2-720p")?.aspectRatios.map((option) => option.value)).toEqual(["9:16", "16:9"]);

      // Minimax-h3: 4~15 秒, 画幅未限定 → 保留通用枚举。
      expect(byModel("Minimax-h3")?.durationOptions).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      // sd-2: 文档口径 5~15 秒整数。
      expect(byModel("sd-2")?.durationOptions).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      // 时长编在模型名里 → 只给那一个值。
      expect(byModel("LongXia-O-sora2-pro-8s-9x16")?.durationOptions).toEqual([8]);
      expect(byModel("LongXia-O-sora2-pro-8s-9x16")?.defaultDuration).toBe(8);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("gives 知鸟AI models their documented duration / resolution / aspect tiers", () => {
    // 2026-10-07 官方文档《模型清单与参数约束》: 逐模型照抄 duration/resolution/aspect,
    // 按次模型把时长锁成文档那一档(一口价)。旧实现只按模型族粗分 —— grok-imagine 视频族
    // 落到默认 [5,8,10,15,20,30], 30s 一口价的模型还能选 5~30 秒; 对按秒计费的模型,
    // 时长档位就是价格档位, 分错等于报价错。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zhiniao = recommendedApis.find((api) => api.id === "zhiniao");
    const zhiniaoApi: CustomApiProvider = {
      id: "zhiniao",
      name: "知鸟AI",
      baseUrl: "https://cuai.token6688.com",
      apiKey: "",
      models: [],
      videoModels: zhiniao?.videoModels ?? [],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "images",
      referenceImageEncoding: "url",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [zhiniaoApi] });
    try {
      const models = listVideoModels();
      const byModel = (suffix: string) => models.find((model) => model.id.endsWith(`/${suffix}`));
      const durations = (suffix: string) => byModel(suffix)?.durationOptions;
      const resolutions = (suffix: string) => byModel(suffix)?.resolutions?.map((option) => option.value);
      const aspects = (suffix: string) => byModel(suffix)?.aspectRatios.map((option) => option.value);

      // 按秒: 时长枚举照抄文档, 也就是价格档位。
      expect(durations("seedance-2-5")).toEqual([4, 5, 6, 8, 10, 12, 15, 20, 25, 29, 30]);
      expect(resolutions("seedance-2-5")).toEqual(["480p", "720p", "1080p"]);
      expect(aspects("seedance-2-5")).toEqual(["16:9", "9:16", "21:9", "3:4", "1:1", "4:3"]);
      // Seedance 2.0 官方直连只有 4~15 秒(与 2.5 的 4~30 不同)。
      expect(durations("seedance-2-0-official")).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      // 按次一口价: 时长锁成唯一一档。
      expect(durations("seedance-2-5-special")).toEqual([30]);
      expect(durations("seedance-2-0-special")).toEqual([15]);
      expect(durations("veo-3.1")).toEqual([8]);
      expect(durations("veo-3-1-manju-special")).toEqual([8]);
      expect(durations("wan-3-0-special")).toEqual([5, 10, 15, 20, 25, 30]);
      expect(durations("omni-flash-1-1")).toEqual([10]);

      // Grok Imagine 视频族: 之前按默认档位兜底, 现在各自成档。
      expect(durations("grok-imagine-1-5-7tu-special")).toEqual([3, 5, 6, 8, 10, 12, 15]);
      expect(resolutions("grok-imagine-1-5-7tu-special")).toEqual(["480p", "720p"]);
      expect(durations("grok-imagine-1.5")).toEqual([4, 6, 8, 10, 12, 15, 20, 30]);
      // 文档(2026-10-19)里 grok-imagine-video 还有 12s 一档，画幅含 4:3 / 3:4
      expect(durations("grok-imagine-video")).toEqual([3, 4, 5, 6, 8, 10, 12, 15, 20, 30]);
      expect(resolutions("grok-imagine-video-special")).toEqual(["720p"]);

      // 文档未声明分辨率的模型 → 直接隐藏分辨率控件(resolutions 不下发)。
      expect(resolutions("sora-2-official")).toBeUndefined();
      expect(durations("sora-2-official")).toEqual([4, 8, 12]);
      expect(resolutions("seedance-video-edit")).toBeUndefined();

      // 画幅/分辨率严格按文档收敛。
      expect(aspects("kling-3.0-turbo")).toEqual(["16:9", "9:16"]);
      expect(resolutions("kling-3.0-turbo")).toEqual(["720p"]);
      expect(resolutions("viduq3")).toEqual(["540p", "720p", "1080p"]);
      expect(resolutions("minimax-h3")).toEqual(["768p", "2k"]);
      expect(aspects("happyhorse-1-1")).toContain("9:21");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("applies the RJM profile and restrictions to a manually added platform URL", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const customRjm: CustomApiProvider = {
      id: "my-rjm",
      name: "我的 RJM 平台",
      baseUrl: "https://sub2api.rjm.us.ci/v1",
      apiKey: "",
      models: [],
      videoModels: ["seedance2.5"],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "data_url",
      imageTransport: "auto",
    };

    useSettingsStore.setState({ customApis: [customRjm] });
    try {
      const model = listVideoModels().find((item) => item.id.endsWith("/seedance2.5"));
      expect(model?.profileId).toBe("sub2api-video");
      expect(model?.durationOptions).toEqual([30]);
      expect(model?.resolutions?.map((option) => option.value)).toEqual(["480p", "720p"]);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("uses 炳火 video constraints and the verified async profile", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const binghuo: CustomApiProvider = {
      id: "binghuo",
      name: "炳火 API",
      baseUrl: "https://api.7tai.cc/v1",
      apiKey: "",
      models: [],
      videoModels: [
        "gz-sd720p",
        "tj-sp2.5",
        "minimax-h3-pro-768p",
        "minimax-h3-pro-2k",
        "bh2.5-1080p",
        "db-sd2.5-720p",
        "hs-sd2.0-720p",
        "sora-v4-pro",
      ],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "url",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [binghuo] });
    try {
      const models = listVideoModels();
      const standard = models.find((model) => model.id.endsWith("/gz-sd720p"));
      const fixed = models.find((model) => model.id.endsWith("/tj-sp2.5"));
      const minimax768 = models.find((model) => model.id.endsWith("/minimax-h3-pro-768p"));
      const minimax2k = models.find((model) => model.id.endsWith("/minimax-h3-pro-2k"));
      const bh25 = models.find((model) => model.id.endsWith("/bh2.5-1080p"));
      const dbSd = models.find((model) => model.id.endsWith("/db-sd2.5-720p"));
      const hsSd = models.find((model) => model.id.endsWith("/hs-sd2.0-720p"));
      const sora = models.find((model) => model.id.endsWith("/sora-v4-pro"));

      expect(standard?.durationOptions).toEqual(Array.from({ length: 12 }, (_, index) => index + 4));
      expect(standard?.resolutions?.map((option) => option.value)).toEqual(["720P"]);
      expect(standard?.aspectRatios.map((option) => option.value)).toContain("21:9");
      expect(standard?.profileId).toBe("binghuo-video");
      expect(standard?.profileStatus).toBe("verified");
      expect(
        resolveModelPriceDisplay(standard!, {
          resolution: "720P",
          extraParams: { duration: 5 },
          language: "zh-CN",
        })?.label,
      ).toContain("2.50");
      expect(fixed?.durationOptions).toEqual([30]);
      expect(
        resolveModelPriceDisplay(fixed!, {
          resolution: "720P",
          extraParams: { duration: 30 },
          language: "zh-CN",
        })?.label,
      ).toContain("3.85");
      expect(minimax768?.aspectRatios.map((option) => option.value)).toEqual(["16:9", "9:16"]);
      expect(minimax768?.resolutions?.map((option) => option.value)).toEqual(["768P"]);
      expect(minimax2k?.resolutions?.map((option) => option.value)).toEqual(["2K"]);
      expect(minimax2k?.durationOptions).toEqual(Array.from({ length: 12 }, (_, index) => index + 4));
      // bh2.5 全系是 4~30 秒逐秒(平台文档口径)。回归钉子: 之前没登记, 落到默认 4~15,
      // UI 滑杆被夹到 15 秒 —— 用户报的就是「bh2.5-1080p 只能最高 15 秒」。
      expect(bh25?.durationOptions).toEqual(Array.from({ length: 27 }, (_, index) => index + 4));
      expect(bh25?.durationOptions[0]).toBe(4);
      expect(bh25?.durationOptions[bh25.durationOptions.length - 1]).toBe(30);
      expect(bh25?.resolutions?.map((option) => option.value)).toEqual(["1080P"]);
      expect(bh25?.defaultDuration).toBe(4);
      expect(bh25?.profileId).toBe("binghuo-video");
      // 2026-10-13 价格表: minimax-h3-pro-768p 由「0.05 元/秒」改为「2.5 元/条」，
      // 断言随之从 0.50 变 2.50 —— 计价方式变更必须被测试钉住，否则会静默按秒低估。
      expect(
        resolveModelPriceDisplay(minimax768!, {
          resolution: "768P",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("2.50");
      // bh2.5-1080p 1.06 元/秒（新登记，此前价格徽标为空）。
      expect(
        resolveModelPriceDisplay(bh25!, {
          resolution: "1080P",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("10.60");
      // 本次新上架渠道：db-（56 折直连）/ hs-（官方直连）。
      expect(
        resolveModelPriceDisplay(dbSd!, {
          resolution: "720P",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("8.50");
      expect(
        resolveModelPriceDisplay(hsSd!, {
          resolution: "720P",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("5.80");
      expect(
        resolveModelPriceDisplay(sora!, {
          resolution: "720P",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("4.50");
      expect(
        resolveModelPriceDisplay(minimax2k!, {
          resolution: "2K",
          extraParams: { duration: 10 },
          language: "zh-CN",
        })?.label,
      ).toContain("0.25");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("keeps pulled 炳火 video ids out of image models", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const binghuo: CustomApiProvider = {
      id: "binghuo-migration",
      name: "炳火 API",
      baseUrl: "https://api.7tai.cc/v1",
      apiKey: "",
      models: ["bh2.0-720p", "SD2.5-720p", "gpt-image-2"],
      videoModels: [],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "url",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [binghuo] });
    try {
      const videoModels = listVideoModels();
      const imageModels = listImageModels();
      expect(videoModels.some((model) => model.id.endsWith("/bh2.0-720p"))).toBe(true);
      expect(videoModels.some((model) => model.id.endsWith("/SD2.5-720p"))).toBe(true);
      expect(imageModels.some((model) => model.id.endsWith("/bh2.0-720p"))).toBe(false);
      expect(imageModels.some((model) => model.id.endsWith("/SD2.5-720p"))).toBe(false);
      expect(imageModels.some((model) => model.id.endsWith("/gpt-image-2"))).toBe(true);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});

describe("字字动画对口型模型", () => {
  it("旧版平台配置即使没保存这两个模型，也会在动作控制节点候选中补出", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zzdh: CustomApiProvider = {
      id: "字字动画",
      name: "字字动画",
      baseUrl: "https://www.zizidonghua.com",
      apiKey: "",
      models: [],
      videoModels: ["zzdh-Minimax-h3-720p"],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "async",
      protocol: "images",
      referenceImageField: "reference_images",
      referenceImageEncoding: "url",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [zzdh] });
    try {
      const ids = listVideoModels().map((model) => model.id);
      expect(ids).toContain("custom:字字动画/zzdh-minimax-h3-限时优惠-对口型-480p");
      expect(ids).toContain("custom:字字动画/zzdh-minimax-h3-限时优惠-对口型-768p");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});

describe("RunningHub 音频模型", () => {
  it("列出 IndexTTS 与标准 Speech/Music 端点", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    useSettingsStore.setState({
      customApis: [
        {
          id: "runninghub-cn",
          name: "RunningHub 国内版",
          baseUrl: "https://www.runninghub.cn",
          apiKey: "",
          models: [],
          videoModels: [],
          audioModels: [
            "indextts2_clone",
            "rhart-audio/text-to-audio/speech-2.8-turbo",
            "minimax/music-2.6/text-to-music",
          ],
          chatModels: [],
          createdAt: 0,
          requestMode: "sync",
          protocol: "images",
          referenceImageField: "image",
          referenceImageEncoding: "auto",
          imageTransport: "auto",
        },
      ],
    });
    try {
      const models = listAudioModels();
      expect(models.map((model) => model.id)).toEqual(
        expect.arrayContaining([
          "custom:runninghub-cn/indextts2_clone",
          "custom:runninghub-cn/rhart-audio/text-to-audio/speech-2.8-turbo",
          "custom:runninghub-cn/minimax/music-2.6/text-to-music",
          "runninghub-cli/rhart-audio/suno-v5/single",
        ]),
      );
      expect(models.find((model) => model.id.endsWith("indextts2_clone"))?.family).toBe("indextts");
      expect(models.find((model) => model.id.endsWith("music-2.6/text-to-music"))?.audioKind).toBe("music");
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});

describe("RunningHub CLI 模型", () => {
  it("注册无密钥的视频与音频模型，且 Suno 端点只暴露真实操作", () => {
    const videoModels = listVideoModels().filter((model) => model.providerId === RUNNINGHUB_CLI_PROVIDER_ID);
    const audioModels = listAudioModels().filter((model) => model.providerId === RUNNINGHUB_CLI_PROVIDER_ID);
    expect(videoModels.length).toBeGreaterThan(0);
    expect(videoModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runninghub-cli/bytedance/seedance-2.5-token/text-to-video",
          displayName: "RunningHub CLI · Seedance 2.5 Token 计费",
        }),
        expect.objectContaining({
          id: "runninghub-cli/minimax/hailuo-h3/text-to-video",
          displayName: "RunningHub CLI · MiniMax H3",
        }),
      ]),
    );
    expect(audioModels.some((model) => model.id.endsWith("/rhart-audio/suno-v5.5/single"))).toBe(true);
    expect(
      audioModels.find((model) => model.id.endsWith("/rhart-audio/suno-v5.5/single"))?.sunoSupportedOperations,
    ).toEqual(["generate"]);
    expect(isApiKeylessProvider(RUNNINGHUB_CLI_PROVIDER_ID)).toBe(true);
  });
});

describe("listAudioModels(字子动画)", () => {
  it("按模型名把音频分成 语音合成 / 音效 / 音乐 三类, 且不混进图片或视频列表", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const zzdh: CustomApiProvider = {
      id: "字子动画",
      name: "字子动画",
      baseUrl: "https://www.zizidonghua.com",
      apiKey: "",
      models: ["qwen-image-3.0"],
      videoModels: ["zzdh-Minimax-h3-720p"],
      audioModels: ["eleven_multilingual_v2", "eleven_text_to_sound_v2", "eleven_music_v1", "indextts2-v1"],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "reference_images",
      referenceImageEncoding: "auto",
      imageTransport: "auto",
    };

    useSettingsStore.setState({ customApis: [zzdh] });
    try {
      const audioModels = listAudioModels();
      const byModel = (name: string) => audioModels.find((model) => model.id === `custom:字子动画/${name}`);

      expect(byModel("eleven_multilingual_v2")?.audioKind).toBe("speech");
      expect(byModel("indextts2-v1")?.audioKind).toBe("speech");
      expect(byModel("eleven_text_to_sound_v2")?.audioKind).toBe("sound-effects");
      expect(byModel("eleven_music_v1")?.audioKind).toBe("music");

      // 语音合成才有音色/格式; 音乐才有长度选项。
      expect(byModel("eleven_multilingual_v2")?.defaultFormat).toBe("mp3");
      expect(byModel("eleven_music_v1")?.defaultMusicLengthMs).toBe(30000);
      expect(byModel("eleven_multilingual_v2")?.defaultMusicLengthMs).toBeUndefined();

      // 平台对音频按用量比例计费, 没有可按次展示的固定价 —— 宁可不显示, 也不显示错价。
      expect(byModel("eleven_multilingual_v2")?.pricing).toBeUndefined();

      // 音频模型不能同时出现在图片/视频下拉里。
      expect(listImageModels().some((model) => model.id.includes("eleven_"))).toBe(false);
      expect(listVideoModels().some((model) => model.id.includes("eleven_"))).toBe(false);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});

/**
 * 音频节点四个创作面板的归属(音色克隆 / 音色设计 / 2.8 配音 / 音乐创作)。
 *
 * 这一层埋过三次坑, 每次都是「模型名认错 -> 模型整个消失或语义错」:
 *  1. 一度所有模型都能进任何面板(切供应商看不出变化);
 *  2. 修完又变成「名字里没有 clone 的克隆模型列不出来」;
 *  3. 2026-09-20 反向修正 —— 为了救 (2) 把 `speech[-_]?\d` 塞进了克隆标记, 结果把
 *     **消费端** `speech-2.8` 也拖进了克隆页。它的 param_schema 里没有任何参考样音
 *     字段, 用户传完样音平台静默忽略, 表现是「克隆了但声音没变」。
 *
 * 现在的分工(见 docs/api_docs/ZhiniaoAI_MiniMax_Voice_Chain.md):
 *   voice-clone  → 音色克隆页(上传样音建音色)
 *   voice-design → 音色设计页(文字描述建音色)
 *   speech-2.8   → 2.8 配音页(用 voice_id 合成)
 */
describe("listAudioModels: 创作面板归属", () => {
  const AUDIO_PANELS: AudioCreativePanel[] = ["voice-clone", "voice-design", "speech", "music"];

  const toCustomApi = (api: RecommendedApi, audioModels: string[]): CustomApiProvider => ({
    id: api.id,
    name: api.name,
    baseUrl: api.baseUrl,
    apiKey: "",
    models: api.models ?? [],
    videoModels: api.videoModels ?? [],
    audioModels,
    chatModels: api.chatModels ?? [],
    createdAt: Date.now(),
    requestMode: "sync",
    protocol: "images",
    referenceImageField: "image",
    referenceImageEncoding: "auto",
    imageTransport: "auto",
  });

  const withCustomApis = <T>(apis: CustomApiProvider[], run: () => T): T => {
    const previous = useSettingsStore.getState().customApis;
    useSettingsStore.setState({ customApis: apis });
    try {
      return run();
    } finally {
      useSettingsStore.setState({ customApis: previous });
    }
  };

  /** 某个模型会出现在哪些面板上(顺序同 AUDIO_PANELS)。 */
  const panelsOf = (apiId: string, model: string): AudioCreativePanel[] => {
    const definition = listAudioModels().find((item) => item.id === `custom:${apiId}/${model}`);
    if (!definition) throw new Error(`音频模型未注册: ${apiId}/${model}`);
    return AUDIO_PANELS.filter((panel) => matchesAudioCreativePanel(definition, panel));
  };

  const zhiniao = recommendedApis.find((api) => api.id === "zhiniao");

  it("知鸟AI: MiniMax 三件套各归各页, Suno music 只进「音乐创作」", () => {
    expect(zhiniao).toBeTruthy();
    const models = zhiniao?.audioModels ?? [];
    withCustomApis([toCustomApi(zhiniao as RecommendedApi, models)], () => {
      const apiId = (zhiniao as RecommendedApi).id;

      // 建音色的两个入口各自独立: 克隆吃样音, 设计吃文字描述。
      expect(panelsOf(apiId, "voice-clone")).toEqual(["voice-clone"]);
      expect(panelsOf(apiId, "voice-design")).toEqual(["voice-design"]);
      // speech-2.8 是消费端(只吃 voice_id), 绝不能出现在克隆页 ——
      // 它没有参考样音字段, 混进去就是「传了样音但声音没变」。
      expect(panelsOf(apiId, "speech-2.8")).toEqual(["speech"]);
      // 音乐模型必须离开「2.8 配音」, 否则语音页会混进 Suno。
      expect(panelsOf(apiId, "music")).toEqual(["music"]);
      expect(panelsOf(apiId, "gemini-2.5-pro-tts")).toEqual(["speech"]);
      expect(panelsOf(apiId, "tts-1")).toEqual(["speech"]);
    });
  });

  it("字子动画: 音乐模型只进「音乐创作」, 音效模型不会从所有面板消失", () => {
    const zzdh = recommendedApis.find((api) => api.id === "zizidonghua");
    expect(zzdh).toBeTruthy();
    const models = zzdh?.audioModels ?? [];
    withCustomApis([toCustomApi(zzdh as RecommendedApi, models)], () => {
      const apiId = (zzdh as RecommendedApi).id;

      expect(panelsOf(apiId, "eleven_music_v2")).toEqual(["music"]);
      // eleven 系既能克隆也能直接合成(有内置音色), 两个页面都该有它。
      expect(panelsOf(apiId, "eleven_multilingual_v2")).toEqual(["voice-clone", "speech"]);
      // 节点没有「音效」页: 音效模型必须仍然落在某个面板里。
      expect(panelsOf(apiId, "eleven_text_to_sound_v2")).toEqual(["voice-clone"]);
    });
  });

  it("推荐平台预置的音频模型都能落在至少一个面板(不会凭空消失)", () => {
    const presets = recommendedApis.filter((api) => (api.audioModels ?? []).length > 0);
    expect(presets.length).toBeGreaterThan(0);

    withCustomApis(
      presets.map((api) => toCustomApi(api, api.audioModels ?? [])),
      () => {
        for (const api of presets) {
          for (const model of api.audioModels ?? []) {
            expect(panelsOf(api.id, model).length, `${api.id}/${model}`).toBeGreaterThan(0);
          }
        }
      },
    );
  });
});

describe("即梦 CLI 图片模型", () => {
  const jimengModels = () => listImageModels().filter((model) => model.providerId === JIMENG_CLI_PROVIDER_ID);

  it("在图片列表里注册 9 个版本, 且属于无密钥平台", () => {
    expect(jimengModels().map((model) => model.id)).toEqual([
      "jimeng-cli/image-5.0Pro",
      "jimeng-cli/image-5.0",
      "jimeng-cli/image-4.7",
      "jimeng-cli/image-4.6",
      "jimeng-cli/image-4.5",
      "jimeng-cli/image-4.1",
      "jimeng-cli/image-4.0",
      "jimeng-cli/image-3.1",
      "jimeng-cli/image-3.0",
    ]);
    // 没有 API Key 可填 —— 图片模型选择器要靠它绕过"填过密钥"的过滤。
    expect(isApiKeylessProvider(JIMENG_CLI_PROVIDER_ID)).toBe(true);
    expect(isApiKeylessProvider("openai")).toBe(false);
  });

  it("档位与 CLI 校验一致: 3.x 只有 1K/2K, 4.x~5.0 是 2K/4K, 5.0Pro 多一档 1.5K", () => {
    const tiersOf = (version: string) =>
      jimengModels()
        .find((model) => model.id === `jimeng-cli/image-${version}`)!
        .resolutions.map((option) => option.value);

    expect(tiersOf("3.0")).toEqual(["1K", "2K"]);
    expect(tiersOf("3.1")).toEqual(["1K", "2K"]);
    expect(tiersOf("4.0")).toEqual(["2K", "4K"]);
    expect(tiersOf("4.5")).toEqual(["2K", "4K"]);
    expect(tiersOf("4.7")).toEqual(["2K", "4K"]);
    expect(tiersOf("5.0")).toEqual(["2K", "4K"]);
    expect(tiersOf("5.0Pro")).toEqual(["1.5K", "2K", "4K"]);
  });

  it("画幅用 CLI 的 8 档枚举, 不含自定义平台的 5:4 / 4:5", () => {
    const model = jimengModels()[0]!;
    expect(model.aspectRatios.map((option) => option.value)).toEqual([
      "21:9",
      "16:9",
      "3:2",
      "4:3",
      "1:1",
      "3:4",
      "2:3",
      "9:16",
    ]);
    expect(model.defaultAspectRatio).toBe("1:1");
    // 默认档位取该版本的首档, 保证默认值一定被 CLI 接受。
    expect(model.defaultResolution).toBe("1.5K");
    expect(jimengModels().find((item) => item.id === "jimeng-cli/image-3.0")?.defaultResolution).toBe("1K");
  });

  it("有参考图时走编辑模式, 无参考图走生成模式", () => {
    const model = jimengModels().find((item) => item.id === "jimeng-cli/image-5.0")!;
    expect(model.resolveRequest({ referenceImageCount: 0 })).toEqual({
      requestModel: "jimeng-cli/image-5.0",
      modeLabel: "生成模式",
    });
    expect(model.resolveRequest({ referenceImageCount: 2 })).toEqual({
      requestModel: "jimeng-cli/image-5.0",
      modeLabel: "编辑模式",
    });
  });

  it("getImageModel 能反查即梦模型, 不会兜底成内置模型", () => {
    // 回归防护: 即梦模型不参与 imageModelMap 构建, 漏了专门分支时重开工程会解析错。
    const resolved = getImageModel("jimeng-cli/image-5.0Pro");
    expect(resolved.id).toBe("jimeng-cli/image-5.0Pro");
    expect(resolved.providerId).toBe(JIMENG_CLI_PROVIDER_ID);
    expect(resolved.displayName).toContain("即梦 CLI");
    expect(resolved.resolutions.map((option) => option.value)).toEqual(["1.5K", "2K", "4K"]);
  });
});

describe("图片超清", () => {
  it("超清模型 id 与 commands/ai.ts 的常量保持一致", () => {
    // 两处字符串必须相等, 否则「图片高清」提交的 job 会落回普通图片链路。
    expect(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID).toBe(JIMENG_CLI_IMAGE_UPSCALE_MODEL);
  });

  it("超清模型不进图片下拉, 但 getImageModel 能解析出定义(记账要用)", () => {
    expect(listImageModels().some((model) => model.id === JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID)).toBe(false);

    const resolved = getImageModel(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID);
    expect(resolved.id).toBe(JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID);
    expect(resolved.providerId).toBe(JIMENG_CLI_PROVIDER_ID);
    expect(resolved.resolutions.map((option) => option.value)).toEqual(["2K", "4K", "8K"]);
    // 本机 CLI 不按次计费, 没有定价才不会在用量里算出假费用。
    expect(resolved.pricing).toBeUndefined();
  });

  it("候选列表目前只有内置的即梦超清, 中转站模型暂不并入", () => {
    const previousCustomApis = useSettingsStore.getState().customApis;
    const relay: CustomApiProvider = {
      id: "relay-hub",
      name: "中转站",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "",
      models: ["real-esrgan-upscale"],
      videoModels: [],
      audioModels: [],
      chatModels: [],
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "image",
      referenceImageEncoding: "url",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [relay] });
    try {
      const models = listImageUpscaleModels();
      // 用户要求先不放中转站模型: 放开时这里会失败, 提醒同步改测试与文案。
      expect(models.map((model) => model.id)).toEqual([JIMENG_CLI_IMAGE_UPSCALE_MODEL_ID]);
      expect(models.some((model) => model.id.startsWith("custom:"))).toBe(false);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });

  it("灵柯图片模型按平台的 options 裁剪画幅与档位, kling 出图也进图片下拉", () => {
    // 数据源: 2026-10-20 抓自 GET /v1/skills/models/{name} 的 params[].options。
    // 平台逐模型校验这两个枚举, 放开通用档位会让用户选出必被拒的值。
    const previousCustomApis = useSettingsStore.getState().customApis;
    const lingke: CustomApiProvider = {
      id: "custom:api-666888",
      name: "灵柯AI",
      baseUrl: "https://api.lk888.ai",
      apiKey: "",
      models: ["banana-2.1", "gk-image-2.0", "doubao-seedream-5-0-260128", "kling-v3", "tt-image-2"],
      videoModels: [],
      audioModels: [],
      chatModels: [],
      modelPrices: {},
      createdAt: Date.now(),
      requestMode: "sync",
      protocol: "images",
      referenceImageField: "images",
      referenceImageEncoding: "auto",
      imageTransport: "generations_json",
    };

    useSettingsStore.setState({ customApis: [lingke] });
    try {
      const models = listImageModels();
      const pick = (name: string) => models.find((model) => model.id.endsWith(`/${name}`));

      // banana 系全档位都在
      expect(pick("banana-2.1")?.resolutions.map((item) => item.value)).toEqual(["1K", "2K", "4K"]);
      expect(pick("banana-2.1")?.aspectRatios).toHaveLength(10);

      // gk-image-2.0 只有 1K/2K, 画幅只有 5 种
      expect(pick("gk-image-2.0")?.resolutions.map((item) => item.value)).toEqual(["1K", "2K"]);
      expect(pick("gk-image-2.0")?.aspectRatios.map((item) => item.value)).toEqual([
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
      ]);

      // doubao-seedream-5-0-260128 没有 1K/4K, 只有 2K/3K
      expect(pick("doubao-seedream-5-0-260128")?.resolutions.map((item) => item.value)).toEqual([
        "2K",
        "3K",
      ]);

      // 像素 size 族没有独立档位参数, 回退通用三档
      expect(pick("tt-image-2")?.resolutions.map((item) => item.value)).toEqual(["1K", "2K", "4K"]);

      // 名字像视频、平台登记为图片的 kling-v3 必须出现在图片下拉里
      expect(pick("kling-v3")).toBeDefined();
      expect(pick("kling-v3")?.resolutions.map((item) => item.value)).toEqual(["1K", "2K"]);

      // 同一个模型挂在别家平台上时不套灵柯的档位表
      useSettingsStore.setState({ customApis: [{ ...lingke, baseUrl: "https://api.openai.com" }] });
      const outsider = listImageModels().find((model) => model.id.endsWith("/gk-image-2.0"));
      expect(outsider?.resolutions.map((item) => item.value)).toEqual(["1K", "2K", "4K"]);
      expect(outsider?.aspectRatios).toHaveLength(10);
    } finally {
      useSettingsStore.setState({ customApis: previousCustomApis });
    }
  });
});
