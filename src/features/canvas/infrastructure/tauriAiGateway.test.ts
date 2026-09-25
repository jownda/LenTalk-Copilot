import { describe, expect, it } from "vitest";
import { JIMENG_CLI_PROVIDER_ID, RUNNINGHUB_CLI_PROVIDER_ID } from "@/features/canvas/models";
import {
  isPubliclyReachableHttpUrl,
  localizeReferenceTokens,
  needsCompatibilityVideoWorker,
  usesRunningHubCliDirectApi,
  withZhiniaoImageMode,
} from "./tauriAiGateway";

describe("needsCompatibilityVideoWorker", () => {
  const withTransport = (model: string, transport?: string) =>
    ({
      model,
      extraParams: transport ? { video_transport: transport } : {},
    }) as never;

  it("所有远端视频协议都必须交给 Rust 后端任务执行器", () => {
    // 这些协议迁到后端后, 任务 ID 与查询地址会落进 ai_generation_jobs;
    // 只要有一条退回前端兼容 worker, 它的任务就会回到 WebView 内存 Map ——
    // 刷新/切页即丢, 仍在平台生成且已计费的付费任务会被判成「中断」。
    const remoteTransports = [
      "openai-video",
      "zhiniao-video",
      "wgspai-video",
      "binghuo-video",
      "kling-control",
      "zhenjian-task-api",
      "zzdh-v8-video",
      "sub2api-video",
    ];
    for (const transport of remoteTransports) {
      expect(needsCompatibilityVideoWorker(withTransport("custom:relay/m", transport))).toBe(false);
    }
  });

  it("Base URL 兜底不再把已迁后端的平台拉回前端", () => {
    // 旧实现有 isRjmVideoApiBaseUrl / isZhenjianProvider / isZzdhProvider 三条
    // Base URL 兜底; transport 缺失时它们会把任务退回 WebView 内存 Map。
    for (const baseUrl of [
      "https://zhenjian.work",
      "https://zizidonghua.com",
      "https://video.rjm.us.ci",
      "https://sub2api.rjm.us.ci",
      "https://cuai.token6688.com",
      "https://api.7tai.cc",
      "https://api.wgspai.cn",
    ]) {
      expect(
        needsCompatibilityVideoWorker({
          model: "custom:relay/m",
          extraParams: { provider_base_url: baseUrl },
        } as never),
      ).toBe(false);
    }
  });

  it("本地 CLI 类视频(即梦 / Wan)仍由前端适配器承载", () => {
    expect(needsCompatibilityVideoWorker(withTransport("wan-cli/2.2"))).toBe(true);
    expect(needsCompatibilityVideoWorker(withTransport(`${JIMENG_CLI_PROVIDER_ID}/v3`))).toBe(true);
  });

  it("CLI 目录缺失的新 RunningHub 模型改走标准模型后端协议", () => {
    const seedance = `${RUNNINGHUB_CLI_PROVIDER_ID}/bytedance/seedance-2.5-token/text-to-video`;
    const minimax = `${RUNNINGHUB_CLI_PROVIDER_ID}/minimax/hailuo-h3/text-to-video`;
    const catalogModel = `${RUNNINGHUB_CLI_PROVIDER_ID}/rhart-video/sparkvideo-2.0/text-to-video`;

    expect(usesRunningHubCliDirectApi(seedance)).toBe(true);
    expect(usesRunningHubCliDirectApi(minimax)).toBe(true);
    expect(needsCompatibilityVideoWorker(withTransport(seedance))).toBe(false);
    expect(needsCompatibilityVideoWorker(withTransport(minimax))).toBe(false);
    expect(usesRunningHubCliDirectApi(catalogModel)).toBe(false);
    expect(needsCompatibilityVideoWorker(withTransport(catalogModel))).toBe(true);
  });
});

describe("localizeReferenceTokens", () => {
  it("fal 模型: @图N / 图N 转换为 Image N", () => {
    expect(localizeReferenceTokens("@图1 保持人物一致", "fal/nano-banana-2")).toBe(
      "Image 1 保持人物一致",
    );
    expect(localizeReferenceTokens("分镜1：图2 使用该场景", "fal/nano-banana-pro")).toBe(
      "分镜1：Image 2 使用该场景",
    );
    expect(localizeReferenceTokens("图3", "fal/nano-banana-2")).toBe("Image 3");
  });

  it("ppio gemini 模型: 同样转换为 Image N", () => {
    expect(localizeReferenceTokens("保持 @图1 的风格", "ppio/gemini-3.1-flash")).toBe(
      "保持 Image 1 的风格",
    );
  });

  it("grsai 中文模型: 保留中文图N 标记", () => {
    expect(localizeReferenceTokens("图1 人物", "grsai/hunyuan-draw")).toBe("图1 人物");
  });

  it("正文中的图N 字样不被误转(前接汉字)", () => {
    expect(localizeReferenceTokens("如图1所示, 主体居中", "fal/nano-banana-2")).toBe(
      "如图1所示, 主体居中",
    );
    expect(localizeReferenceTokens("参考图1的风格", "fal/nano-banana-2")).toBe("参考图1的风格");
  });

  it("多张参考图按序映射", () => {
    expect(localizeReferenceTokens("@图1 人物, @图2 背景", "fal/nano-banana-2")).toBe(
      "Image 1 人物, Image 2 背景",
    );
  });

  it("空 prompt 安全返回", () => {
    expect(localizeReferenceTokens("", "fal/nano-banana-2")).toBe("");
  });
});

describe("withZhiniaoImageMode", () => {
  const ZN_MODEL = "custom:zhiniao/gemini-3.1-flash-image";
  const ZN_URL = "https://cuai.token6688.com";

  const build = (
    model: string,
    baseUrl: string,
    referenceImages: string[],
    extraParams: Record<string, unknown> = {},
  ) => ({
    model,
    extraParams: { provider_base_url: baseUrl, ...extraParams } as Record<string, unknown>,
    referenceImages,
  });
  const modeOf = (payload: { extraParams?: Record<string, unknown> }) =>
    payload.extraParams?.["image_generation_mode"];

  it("单张参考图 → image-edit", () => {
    expect(modeOf(withZhiniaoImageMode(build(ZN_MODEL, ZN_URL, ["a.png"])))).toBe("image-edit");
  });

  it("多张参考图 → multi-reference", () => {
    expect(modeOf(withZhiniaoImageMode(build(ZN_MODEL, ZN_URL, ["a.png", "b.png"])))).toBe(
      "multi-reference",
    );
  });

  it("无参考图 → 不注入, 保持平台默认的文生图", () => {
    expect(modeOf(withZhiniaoImageMode(build(ZN_MODEL, ZN_URL, [])))).toBeUndefined();
    expect(modeOf(withZhiniaoImageMode(build(ZN_MODEL, ZN_URL, ["  "])))).toBeUndefined();
  });

  it("按 baseUrl 识别: 平台 id 不叫 zhiniao 也生效", () => {
    expect(modeOf(withZhiniaoImageMode(build("custom:my-relay/gemini-3.1-flash-image", ZN_URL, ["a.png"])))).toBe(
      "image-edit",
    );
  });

  it("其它平台不受影响", () => {
    expect(modeOf(withZhiniaoImageMode(build("custom:other/nano-banana", "https://example.com", ["a.png"])))).toBeUndefined();
  });

  it("已显式配置时不覆盖调用方的选择", () => {
    expect(
      modeOf(withZhiniaoImageMode(build(ZN_MODEL, ZN_URL, ["a.png", "b.png"], { image_generation_mode: "text-to-image" })))
    ).toBe("text-to-image");
  });
});

/**
 * 平台是远端下载参考图: 本机/内网地址远端必然取不到, 只能先在本地读成 data URL。
 */
describe("isPubliclyReachableHttpUrl", () => {
  it("公网域名/公网 IP → 可直传", () => {
    expect(isPubliclyReachableHttpUrl("https://cdn.example.com/a.png")).toBe(true);
    expect(isPubliclyReachableHttpUrl("https://8.8.8.8/a.png")).toBe(true);
    expect(isPubliclyReachableHttpUrl("http://203.0.113.7/a.png")).toBe(true);
  });

  it("环回与 localhost → 不可直传", () => {
    expect(isPubliclyReachableHttpUrl("http://localhost:3000/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://127.0.0.1/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://asset.localhost/%2Ftmp%2Fa.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://[::1]:8080/a.png")).toBe(false);
  });

  it("私网段 → 不可直传", () => {
    expect(isPubliclyReachableHttpUrl("http://10.0.0.5/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://192.168.1.20/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://172.16.4.9/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://172.32.4.9/a.png")).toBe(true);
    expect(isPubliclyReachableHttpUrl("http://169.254.1.1/a.png")).toBe(false);
  });

  it("内网域名后缀 → 不可直传", () => {
    expect(isPubliclyReachableHttpUrl("http://nas.local/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://svc.internal/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("http://box.lan/a.png")).toBe(false);
  });

  it("非 http(s) 或非法地址 → 不可直传", () => {
    expect(isPubliclyReachableHttpUrl("blob:http://localhost/8f2c")).toBe(false);
    expect(isPubliclyReachableHttpUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isPubliclyReachableHttpUrl("/Users/job/a.png")).toBe(false);
    expect(isPubliclyReachableHttpUrl("")).toBe(false);
  });
});
