import { afterEach, describe, expect, it } from "vitest";

import type {
  JimengCatalogEntry,
  JimengModelCatalog,
  JimengPriceReport,
  LegacyCliModel,
} from "@/commands/jimengCatalog";
import {
  __setJimengCatalogForTest,
  jimengAutoImageUnitCredits,
  jimengAutoVideoUnitCredits,
  useJimengCatalogStore,
} from "./jimengCatalog";
import { getImageModel, getVideoModel, listImageModels, listVideoModels } from "./registry";

function entry(partial: Partial<JimengCatalogEntry> & { model: string }): JimengCatalogEntry {
  return {
    displayName: partial.model,
    aliases: [],
    mediaType: "image",
    modes: ["t2i"],
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "16:9"],
    durations: [],
    maxCount: 1,
    fixedCount: null,
    maxReferences: 0,
    supportsFirstFrame: false,
    vipRequired: false,
    ...partial,
  };
}

function catalog(image: JimengCatalogEntry[], video: JimengCatalogEntry[] = []): JimengModelCatalog {
  return { cliVersion: "1.2.1", fetchedAt: 1_700_000_000, image, video, audio: [] };
}

afterEach(() => {
  __setJimengCatalogForTest(null, null);
});

describe("即梦画布 CLI 模型目录合并", () => {
  it("目录里的档位覆盖内置兜底档位", () => {
    __setJimengCatalogForTest(
      catalog([
        entry({ model: "seedream_5.5", resolutions: ["1.5K", "2K", "4K"], aspectRatios: ["1:1", "3:4"] }),
      ])
    );

    const model = listImageModels().find((item) => item.id === "jimeng-canvas/seedream_5.5");
    expect(model).toBeDefined();
    expect(model!.resolutions.map((option) => option.value)).toEqual(["1.5K", "2K", "4K"]);
    expect(model!.aspectRatios.map((option) => option.value)).toEqual(["1:1", "3:4"]);
    // 默认档仍取第二档（画质中档），与内置表口径一致
    expect(model!.defaultResolution).toBe("2K");
  });

  it("固定张数模型（MJ 8.2）只给一档，且一档就是平台要求的 4 张", () => {
    __setJimengCatalogForTest(
      catalog([
        entry({
          model: "jm_image_model_yc_mj82",
          displayName: "图片美学模型 V8.2",
          resolutions: ["1K", "2K"],
          fixedCount: 4,
          minCount: 4,
          maxCount: 4,
          maxReferences: 20,
          maxPromptLength: 1024,
        }),
      ])
    );

    const model = getImageModel("jimeng-canvas/jm_image_model_yc_mj82");
    // 一档 = 4 张：按钮上要显示 4，而不是 1
    expect(model.imagesPerCountUnit).toBe(4);
    // 档位上限 1：给 2/3/4 档等于给一个必然被服务端拒的选项
    expect(model.maxImageCountUnits).toBe(1);
    expect(model.maxReferenceImages).toBe(20);
    expect(model.maxPromptLength).toBe(1024);
  });

  it("普通模型按目录声明的张数区间放开档位上限", () => {
    __setJimengCatalogForTest(
      catalog([entry({ model: "seedream_4.5", resolutions: ["2K", "4K"], maxCount: 3 })])
    );

    const model = getImageModel("jimeng-canvas/seedream_4.5");
    expect(model.imagesPerCountUnit).toBeUndefined();
    expect(model.maxImageCountUnits).toBe(3);
  });

  it("目录里有、策展表没有的模型追加到末尾", () => {
    __setJimengCatalogForTest(
      catalog([entry({ model: "jimeng_smart_image_v1", displayName: "即梦 ImageMax 1.0", resolutions: ["1K", "2K", "4K"] })])
    );

    const models = listImageModels();
    const added = models.find((item) => item.id === "jimeng-canvas/jimeng_smart_image_v1");
    expect(added).toBeDefined();
    expect(added!.displayName).toContain("即梦 ImageMax 1.0");
    expect(added!.resolutions).toHaveLength(3);
    // 追加项必须排在所有策展项之后
    const lastCuratedIndex = models.findIndex((item) => item.id === "jimeng-canvas/high_aes_general_v50_flash");
    expect(models.indexOf(added!)).toBeGreaterThan(lastCuratedIndex);
  });

  it("视频目录：时长区间与参考图上限来自清单", () => {
    __setJimengCatalogForTest(
      catalog([], [
        entry({
          model: "seedance_2.5",
          mediaType: "video",
          resolutions: ["480p", "720p", "1080p"],
          durations: [4, 8, 12],
          maxReferences: 50,
          aspectRatios: ["16:9", "9:16"],
        }),
      ])
    );

    const model = getVideoModel("jimeng-canvas/seedance_2.5");
    expect(model).toBeTruthy();
    expect(model!.durationOptions).toEqual([4, 8, 12]);
    expect(model!.defaultDuration).toBe(4);
    expect(model!.maxReferenceImages).toBe(50);
    expect(model!.resolutions?.map((option) => option.value)).toEqual(["480p", "720p", "1080p"]);
  });

  it("目录不可用时不崩，仍返回内置策展模型", () => {
    __setJimengCatalogForTest(null);
    const model = getImageModel("jimeng-canvas/seedream_5.5");
    expect(model.resolutions.map((option) => option.value)).toEqual(["1.5K", "2K"]);
    expect(listVideoModels().some((item) => item.id === "jimeng-canvas/seedance_2.5_draft")).toBe(true);
  });

  it("自动报价优先于人工价目表", () => {
    const report: JimengPriceReport = {
      quotes: [
        {
          model: "seedream_5.5",
          mediaType: "image",
          resolution: "1.5K",
          duration: null,
          credits: 9,
          units: 1,
          unitCredits: 9,
        },
      ],
      failures: [],
      probedAt: 1_700_000_000,
    };
    __setJimengCatalogForTest(null, report);

    expect(jimengAutoImageUnitCredits("seedream_5.5", "1.5k")).toBe(9);
    // 没报价过的组合返回 null，调用方回退人工表
    expect(jimengAutoImageUnitCredits("seedream_5.5", "2K")).toBeNull();
    expect(jimengAutoVideoUnitCredits("seedance_2.5", "720p")).toBeNull();
  });
});

/**
 * 旧 CLI（`dreamina`）的型号清单：`-h` 文本 + 服务端回显的权威清单合并后由后端下发。
 * 这里只验证「下发的清单怎么变成下拉里的模型」—— 服务端探测在 Rust 侧。
 */
describe("旧 CLI 型号清单合并", () => {
  const setLegacy = (image: LegacyCliModel[], video: LegacyCliModel[] = []) =>
    useJimengCatalogStore.setState({
      legacy: { cliVersion: "1.4.22", fetchedAt: 1_700_000_000, image, video },
      revision: 1,
    });

  afterEach(() => {
    useJimengCatalogStore.setState({ legacy: null });
  });

  it("服务端有、help 没写的型号也会出现在下拉里", () => {
    setLegacy(
      [{ version: "6.0", resolutions: ["2k", "4k"], minDuration: null, maxDuration: null }],
      [{ version: "seedance3.0", resolutions: ["1080p"], minDuration: 4, maxDuration: 20 }]
    );

    const image = listImageModels().find((item) => item.id === "jimeng-cli/image-6.0");
    expect(image?.resolutions.map((option) => option.value)).toEqual(["2K", "4K"]);

    const video = listVideoModels().find((item) => item.id === "jimeng-cli/seedance3.0");
    expect(video?.resolutions?.map((option) => option.value)).toEqual(["1080p"]);
    expect(video?.durationOptions).toEqual(
      Array.from({ length: 17 }, (_, index) => index + 4)
    );
  });

  it("清单里的档位比内置表可信：声明了什么就只给什么", () => {
    setLegacy([{ version: "4.8", resolutions: ["1k", "2k"], minDuration: null, maxDuration: null }]);
    const model = getImageModel("jimeng-cli/image-4.8");
    expect(model.resolutions.map((option) => option.value)).toEqual(["1K", "2K"]);
  });

  it("清单为空（CLI 没装 / 解析失败）时回退内置策展表", () => {
    useJimengCatalogStore.setState({ legacy: null });
    expect(listImageModels().some((item) => item.id === "jimeng-cli/image-5.0lite")).toBe(true);
    expect(listVideoModels().some((item) => item.id === "jimeng-cli/seedance2.5_flash")).toBe(true);
  });
});
