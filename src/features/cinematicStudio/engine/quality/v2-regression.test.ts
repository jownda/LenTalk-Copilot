import { describe, expect, it } from "vitest";

import type { Asset, ProjectV2, SceneV2 } from "../../shared-types";
import { sanitizeDirectorText } from "./sanitize";
import { validateDirectorLayers } from "./validateDirectorLayers";

const assets: Asset[] = [
  { id: "location", kind: "location", name: "无尽地铁车厢", description: "endless white subway carriage", referencePaths: [], lockLevel: "none", tags: [] },
  { id: "lin", kind: "character", name: "林sir", description: "middle-aged East Asian man", referencePaths: [], lockLevel: "strict", tags: [] },
  { id: "ajun", kind: "character", name: "阿俊", description: "young man", referencePaths: [], lockLevel: "soft", tags: [] },
];

const scene: SceneV2 = {
  id: "scene-1", name: "无尽车厢", logline: "林sir坐在车厢中回忆。", location: "地铁车厢", time: "夜晚",
  weather: "暴雨", duration: "34秒", palette: "冷白", lighting: "顶部冷白灯", environmentLock: true,
  shootingMode: "multi-shot",
  staging: { locationAssetId: "location", characterOrder: ["lin", "ajun"] },
  shots: [{
    id: "shot-1", label: "1", duration: "34秒", framing: "低角度中近景", lens: "50mm",
    movement: "Handheld", action: "林sir坐在车厢中央", acting: "克制", direction: "left-to-right",
    participants: [
      { characterId: "lin", role: "primary" },
      { characterId: "ajun", role: "supporting" },
    ],
  }],
};

const project: ProjectV2 = {
  id: "project-1", title: "回归测试", description: "", preset: "custom", scenes: [scene], characters: [], assets,
};

const correctedLayers: Record<string, string> = {
  activeReferences: "活动引用：@无尽地铁车厢、@林sir、@阿俊。",
  locationMap: "位置图：镜头位于车厢中央过道偏低位置，阿俊在画外右前方。",
  firstFrame: "首帧与站位：林sir已坐在画面中央偏下，阿俊首帧不入画。",
  formatMode: "格式模式：CONTROLLED MULTI-SHOT SEQUENCE。",
  optics: "光学：84°广角纵深透视，近大远小，前后景深度拉开。",
  camera: "相机：低机位轻微手持，听到画外声音后物理性右摇。",
  actionTiming: "动作时间：镜头1 · 0:00-0:17：林sir回忆；镜头2 · 0:17-0:34：阿俊画外插话后入画。",
  physics: "物理：坐姿重量落在地板，背部与扶手保持接触阴影。",
  lighting: "光线：主光来自车厢顶部冷白灯，曝光优先面部眼神。",
  audio: "音频：无配乐，保留列车低频轰鸣与对白抢话。",
  positiveConstraints: "正向约束：林sir保持中年东亚男性、敦实身材、深蓝西装白衬衫。",
  negativeLocks: "负面局部锁：禁止身份漂移、额外人物、漂浮运动、字幕错字和水印。",
};

describe("V2.7 真实片段回归", () => {
  it("修正版不再触发五类已知导演文档问题", () => {
    const issues = validateDirectorLayers(correctedLayers, project, scene);
    const codes = issues.map((issue) => issue.code);
    expect(codes).not.toContain("DIRECTOR.MULTI_SHOT_TIMELINE");
    expect(codes).not.toContain("DIRECTOR.UNREFERENCED_ASSET");
    expect(codes).not.toContain("DIRECTOR.META_STATEMENT");
    expect(codes).not.toContain("DIRECTOR.OPTICS_WIDE_COMPRESSION");
    expect(codes).not.toContain("DIRECTOR.IDENTITY_ANCHOR_DUP");
  });

  it("导出净化移除连续性诊断，但不删除画面指令", () => {
    const output = sanitizeDirectorText([
      Object.values(correctedLayers).join("\n"),
      "连续性：共 5 个问题（0 个错误，4 个警告）。",
      "最终导出前请解决错误级问题。",
    ].join("\n\n"));
    expect(output).not.toContain("场景上下文");
    expect(output).not.toContain("连续性：共 5 个问题");
    expect(output).not.toContain("最终导出前请解决");
  });
});
