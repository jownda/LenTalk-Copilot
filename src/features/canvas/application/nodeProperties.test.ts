import { describe, expect, it } from "vitest";

import { buildNodeProperties, serializeNodeProperties } from "./nodeProperties";

const t = (_key: string, fallback: string) => fallback;

function collectRows(groups: ReturnType<typeof buildNodeProperties>) {
  return groups.flatMap((group) => group.rows.map((row) => `${row.label}|${row.value}`));
}

function findGroup(groups: ReturnType<typeof buildNodeProperties>, key: string) {
  return groups.find((group) => group.key === key);
}

describe("buildNodeProperties", () => {
  it("图片结果节点: 媒体信息 + 生成信息 + 提示词 + 参考素材都齐全", () => {
    const groups = buildNodeProperties({
      nodeType: "exportImageNode",
      mediaKind: "image",
      mediaUrl: "/Users/me/Library/Application Support/app/media/abc.png",
      data: {
        resultKind: "generic",
        displayName: "结果图片",
        generationProviderId: "custom:zhiniao",
        generationJobId: "job-123",
        generationStartedAt: 1_700_000_000_000,
        generationDurationMs: 60_000,
        generationSourceType: "imageEdit",
        generationRequest: {
          kind: "image",
          prompt: "商纣王三格设定图",
          negativePrompt: "模糊",
          model: "mj_imagine",
          size: "2K",
          aspectRatio: "16:9",
          imageCount: 2,
          referenceImages: ["https://cdn.example.com/ref1.png"],
          extraParams: { bot_type: "MID_JOURNEY" },
        },
      },
      probe: { width: 2048, height: 1152, byteSize: 1_258_291 },
      provider: {
        label: (id) => (id === "custom:zhiniao" ? "知鸟ai" : null),
        baseUrl: (id) => (id === "custom:zhiniao" ? "https://cuai.token6688.com" : null),
      },
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("类型|图片");
    expect(rows).toContain("节点类型|结果图片");
    expect(rows).toContain("分辨率|2048 × 1152 px");
    expect(rows).toContain("文件大小|1.2 MB");
    expect(rows).toContain("格式|PNG");
    expect(rows).toContain("生成平台|知鸟ai");
    expect(rows).toContain("接口地址|https://cuai.token6688.com");
    expect(rows).toContain("生成模型|mj_imagine");
    expect(rows).toContain("尺寸档位|2K");
    expect(rows).toContain("画幅比例|16:9");
    expect(rows).toContain("生成数量|2");
    expect(rows).toContain("任务 ID|job-123");
    expect(rows).toContain("生成来源|AI 图片节点");
    expect(rows).toContain("生成状态|已完成");
    expect(rows).toContain("提示词|商纣王三格设定图");
    expect(rows).toContain("负向提示词|模糊");
    expect(rows).toContain("参考图片|1");

    const extra = findGroup(groups, "extra-params");
    expect(extra?.rows[0].value).toContain("MID_JOURNEY");
  });

  it("上传图: 没有生成记录时只出媒体组,并明确说明无生成信息", () => {
    const groups = buildNodeProperties({
      nodeType: "uploadNode",
      mediaKind: "image",
      mediaUrl: "D:\\media\\shot.jpg",
      data: { imageUrl: "D:\\media\\shot.jpg", sourceFileName: "shot.jpg" },
      provider: { label: () => null, baseUrl: () => null },
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("类型|图片");
    expect(rows).toContain("节点类型|本地上传");
    expect(rows).toContain("格式|JPG");
    expect(rows).toContain("生成状态|无生成记录（上传或手动导入的素材）");
    // 没有生成记录时不该凭空造出「生成平台 / 生成模型」行。
    expect(rows.some((row) => row.startsWith("生成平台|"))).toBe(false);
    expect(findGroup(groups, "prompt")).toBeUndefined();
  });

  it("视频媒体节点: 读节点上的 provider/model/baseUrl 与请求快照", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "video",
      mediaUrl: "https://cdn.example.com/out.mp4",
      data: {
        mediaType: "video",
        generationProviderId: "custom:zhiniao",
        generationModel: "custom:zhiniao/seedance-2.5",
        providerBaseUrl: "https://cuai.token6688.com",
        generationJobId: "vid-9",
        generationStartedAt: 1_700_000_000_000,
        generationRequest: {
          kind: "video",
          prompt: "雨夜追逐",
          model: "custom:zhiniao/seedance-2.5",
          duration: 95,
          aspectRatio: "16:9",
          videoResolution: "1080p",
          referenceImages: ["a.png", "b.png"],
          referenceAudio: ["c.mp3"],
        },
      },
      probe: { width: 1920, height: 1080, durationSeconds: 5, byteSize: 4_194_304 },
      provider: {
        label: () => "知鸟ai",
        baseUrl: () => "https://cuai.token6688.com",
      },
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("类型|视频");
    expect(rows).toContain("分辨率|1920 × 1080 px");
    expect(rows).toContain("时长|0:05");
    expect(rows).toContain("文件大小|4 MB");
    expect(rows).toContain("格式|MP4");
    // 平台已单独一行展示, 模型只留模型名(`custom:zhiniao/` 前缀去掉)
    expect(rows).toContain("生成模型|seedance-2.5");
    expect(rows).toContain("生成时长|1:35");
    expect(rows).toContain("输出分辨率|1080p");
    expect(rows).toContain("参考图片|2");
    expect(rows).toContain("参考音频|1");
  });

  it("失败节点: 展示失败状态与原因, 而不是「已完成」", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "audio",
      mediaUrl: "/tmp/a.mp3",
      data: {
        mediaType: "audio",
        generationError: "余额不足",
        generationErrorDetails: "HTTP 402",
        generationRequest: { kind: "audio", prompt: "旁白", model: "mmx-speech" },
      },
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("生成状态|失败");
    expect(rows).toContain("失败原因|余额不足");
    expect(rows).toContain("详细报错|HTTP 402");
    expect(rows).not.toContain("生成状态|已完成");
  });

  it("生成中节点: 状态为生成中", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "video",
      mediaUrl: null,
      data: { mediaType: "video", isGenerating: true, generationProviderId: "custom:zhiniao" },
      provider: { label: () => "知鸟ai" },
      t,
    });

    expect(collectRows(groups)).toContain("生成状态|生成中");
  });
});

describe("上游节点兜底", () => {
  it("结果节点被清空生成字段时, 平台/模型/提示词从上游生成节点读", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "video",
      mediaUrl: "/media/out.mp4",
      // 生成完成后 Canvas 会把这三项清掉, 所以节点自身什么也没有
      data: {
        mediaType: "video",
        generationProviderId: null,
        generationRequest: undefined,
        generationDebugContext: undefined,
      },
      upstream: {
        nodeId: "gen-1",
        nodeType: "videoGenNode",
        data: {
          // 自定义平台的模型 id 带 `custom:<平台>/` 前缀(与 registry 一致)
          model: "custom:binghuo/doubao-seedance-2.5",
          aspectRatio: "16:9",
          prompt: "海边慢推镜头",
        },
      },
      provider: {
        label: (id) => (id === "custom:binghuo" ? "炳火" : null),
        baseUrl: (id) => (id === "custom:binghuo" ? "https://api.7tai.cc" : null),
      },
      resolveModelProviderId: (modelId) =>
        modelId === "custom:binghuo/doubao-seedance-2.5" ? "custom:binghuo" : null,
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("信息来源|取自上游 · AI 视频");
    expect(rows).toContain("生成平台|炳火");
    expect(rows).toContain("生成模型|doubao-seedance-2.5");
    expect(rows).toContain("接口地址|https://api.7tai.cc");
    expect(rows).toContain("生成来源|AI 视频节点");    expect(rows).toContain("画幅比例|16:9");
    expect(rows).toContain("提示词|海边慢推镜头");
  });

  it("节点自身有生成记录时不使用上游, 也不显示信息来源行", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "video",
      mediaUrl: "/media/out.mp4",
      data: {
        mediaType: "video",
        generationProviderId: "custom:zhiniao",
        generationModel: "seedance-1.0",
        generationRequest: { kind: "video", model: "seedance-1.0", prompt: "自身的提示词" },
      },
      upstream: {
        nodeType: "videoGenNode",
        data: { model: "seedance-9.9", prompt: "上游的提示词" },
      },
      provider: { label: (id) => (id === "custom:zhiniao" ? "知鸟ai" : null) },
      resolveModelProviderId: () => "custom:binghuo",
      t,
    });

    const rows = collectRows(groups);
    expect(rows).toContain("生成平台|知鸟ai");
    expect(rows).toContain("生成模型|seedance-1.0");
    expect(rows).toContain("提示词|自身的提示词");
    expect(rows.some((row) => row.startsWith("信息来源|"))).toBe(false);
  });

  it("没有上游也没有记录时仍然明确提示无生成记录", () => {
    const groups = buildNodeProperties({
      nodeType: "audioNode",
      mediaKind: "audio",
      mediaUrl: "/media/a.mp3",
      data: { mediaType: "audio" },
      upstream: null,
      t,
    });

    expect(collectRows(groups)).toContain("生成状态|无生成记录（上传或手动导入的素材）");
  });
  it("提示词独立成组: 节点没有生成记录而上游只留了提示词时也能显示并可复制", () => {
    const groups = buildNodeProperties({
      nodeType: "exportImageNode",
      mediaKind: "image",
      mediaUrl: "/media/a.png",
      data: {},
      upstream: {
        nodeId: "gen-2",
        nodeType: "imageNode",
        data: { prompt: "三格角色设定图，纯中性灰背景" },
      },
      t,
    });

    const promptGroup = findGroup(groups, "prompt");
    expect(promptGroup).toBeTruthy();
    expect(promptGroup?.rows[0]).toMatchObject({
      label: "提示词",
      value: "三格角色设定图，纯中性灰背景",
      id: "prompt",
      copyable: true,
    });
    // 生成信息确实没有, 但提示词不该被一起吞掉
    expect(collectRows(groups)).toContain("生成状态|无生成记录（上传或手动导入的素材）");
  });
});

describe("serializeNodeProperties", () => {
  it("输出带分组标题的纯文本, 可直接粘贴给他人排查", () => {
    const groups = buildNodeProperties({
      nodeType: "exportImageNode",
      mediaKind: "image",
      mediaUrl: "/media/a.png",
      data: {
        generationProviderId: "custom:zhiniao",
        generationRequest: { kind: "image", model: "mj_imagine", prompt: "一张图" },
      },
      provider: { label: () => "知鸟ai" },
      t,
    });

    const text = serializeNodeProperties(groups, { name: "结果图片", nodeId: "node-1" });
    expect(text).toContain("结果图片（node-1）");
    expect(text).toContain("[媒体信息]");
    expect(text).toContain("格式：PNG");
    expect(text).toContain("[生成信息]");
    expect(text).toContain("生成平台：知鸟ai");
    expect(text).toContain("提示词：一张图");
  });
});
