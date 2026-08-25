/**
 * Golden Project Seed：博物馆红门（Museum Red Doors）
 * 对应 docs/V0.2-CLICK-TO-PROMPT-IMPLEMENTATION.md §7 最终验收路径。
 * 桌面端「打开示例项目」与引擎 Golden Tests 共享此数据，保证单一真源。
 * P0.1 验收：Asset-ID 模板输出 EXACTLY FOUR、四条唯一身份规则、资产 UUID/[imageN]。
 */
import type { ProjectV2 } from "../../shared-types";

export const museumRedDoorsProject: ProjectV2 = {
  id: "golden-museum-red-doors",
  title: "Museum Red Doors",
  description: "Four characters stage a boombox heist at a museum service area; a detonator blows the red double doors.",
  preset: "Hollywood Naturalism",
  styleId: "lubezki-deakins",
  schemaVersion: 2,
  characterCountLock: 4,
  negativePrompt: "character drift, wardrobe changes, extra limbs, no-gravity movement, floating props, text or watermarks",
  assets: [
    {
      id: "asset-lulu", kind: "character", name: "LULU", lockLevel: "strict",
      description: "Slim woman in a vintage bomber jacket, sharp silver bob haircut.",
      descriptionZh: "瘦削女子，复古飞行员夹克，利落银色短发。",
      referencePaths: [], tags: ["museum-heist"],
      uniqueMarkers: ["silver bob haircut"],
      alwaysVisible: ["black leather gloves on both hands at all times"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-roko", kind: "character", name: "ROKO", lockLevel: "strict",
      description: "Broad-shouldered man in a grey beanie and work jacket, small scar on left cheek.",
      descriptionZh: "宽肩男子，灰色毛线帽与工装夹克，左脸颊小疤痕。",
      referencePaths: [], tags: ["museum-heist"],
      uniqueMarkers: ["scar on left cheek only"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-jaxx", kind: "character", name: "JAXX", lockLevel: "strict",
      description: "Tall lanky man with a coiled braid, sleeveless hoodie, carries the boombox.",
      descriptionZh: "高瘦男子，盘发辫，无袖连帽衫，携带音箱。",
      referencePaths: [], tags: ["museum-heist"],
      uniqueMarkers: ["coiled braid"],
      alwaysVisible: ["black leather gloves on both hands at all times"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-rein", kind: "character", name: "REIN", lockLevel: "strict",
      description: "Stocky woman with a shaved undercut and a red neck scarf, low center of gravity.",
      descriptionZh: "敦实女子，剃发底切发型，红色围巾，重心低。",
      referencePaths: [], tags: ["museum-heist"],
      uniqueMarkers: ["shaved undercut"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-museum-service", kind: "location", name: "MUSEUM SERVICE AREA", lockLevel: "soft",
      description: "Museum back-of-house service corridor with two red double doors at the end.",
      descriptionZh: "博物馆后勤服务走廊，尽头是两扇红色双开门。",
      referencePaths: [], tags: ["museum"],
      useFor: ["environment"],
    },
    {
      id: "asset-boombox", kind: "prop", name: "boombox", lockLevel: "soft",
      description: "Vintage silver cassette boombox with twin speakers.",
      descriptionZh: "复古银色卡带音箱，双扬声器。",
      referencePaths: [], tags: ["museum-heist"],
      useFor: ["appearance"],
    },
    {
      id: "asset-detonator", kind: "prop", name: "detonator", lockLevel: "soft",
      description: "Small black radio detonator with a red button and short antenna.",
      descriptionZh: "小型黑色无线电引爆器，红色按钮与短天线。",
      referencePaths: [], tags: ["museum-heist"],
      useFor: ["appearance"],
    },
  ],
  identityRules: [
    { characterId: "asset-lulu", uniqueMarkers: ["silver bob haircut"], alwaysVisible: ["black leather gloves on both hands at all times"] },
    { characterId: "asset-roko", uniqueMarkers: ["scar on left cheek only"] },
    { characterId: "asset-jaxx", uniqueMarkers: ["coiled braid"], alwaysVisible: ["black leather gloves on both hands at all times"] },
    { characterId: "asset-rein", uniqueMarkers: ["shaved undercut"] },
  ],
  technicalProfile: {
    recipeId: "lubezki-deakins-action",
    format: "photoreal",
    filmStock: "kodak-250d",
    fps: 24,
    shutterAngle: 180,
    resolution: "4K",
  },
  audioPlan: {
    diegeticMusic: ["boombox beat building, then bass drop"],
    sfx: ["detonator click", "door explosion", "debris", "skateboard wheels"],
    score: "none",
    subtitles: false,
  },
  scenes: [{
    id: "scene-heist", name: "Museum Service Area", logline: "Four friends stage a prank heist, then a real detonator blows the red doors.",
    location: "Museum back-of-house corridor", time: "Night", weather: "Overcast", duration: "24s", palette: "blue-grey / amber", lighting: "fluorescent service lighting", environmentLock: true,
    staging: {
      locationAssetId: "asset-museum-service",
      anchorDescription: "All four have their backs against the white concrete wall beside the red double doors; skateboards at their feet.",
      characterOrder: ["asset-lulu", "asset-roko", "asset-jaxx", "asset-rein"],
      axisDirection: "left-to-right",
      priorContext: "The crew rolls in on skateboards from the loading dock.",
    },
    shots: [
      {
        id: "shot-group", label: "01", duration: "0-6s", framing: "Wide", lens: "24mm", movement: "Static", camera: "arri-alexa-35", lensModel: "zeiss-supreme-prime", action: "Four characters stand against the wall.", acting: "Playful confidence.", direction: "left-to-right",
        participants: [
          { characterId: "asset-lulu", role: "primary", position: "foreground-left", entrance: "already-in-frame" },
          { characterId: "asset-roko", role: "primary", position: "center-left", entrance: "already-in-frame" },
          { characterId: "asset-jaxx", role: "primary", position: "center-right", entrance: "already-in-frame" },
          { characterId: "asset-rein", role: "primary", position: "foreground-right", entrance: "already-in-frame" },
        ],
        propStatesAtStart: [
          { propId: "asset-boombox", state: "on-ground" },
        ],
      },
      {
        id: "shot-boombox", label: "02", duration: "6-12s", framing: "Medium close-up", lens: "50mm", movement: "Handheld", camera: "arri-alexa-mini-lf", lensModel: "cooke-s7i", action: "JAXX sets the boombox on his shoulder.", acting: "Show-off grin.", direction: "left-to-right",
        participants: [
          { characterId: "asset-jaxx", role: "primary", position: "center", entrance: "already-in-frame" },
          { characterId: "asset-lulu", role: "supporting", position: "foreground-left", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-jaxx", "asset-lulu"] },
        propStatesAtStart: [
          { propId: "asset-boombox", state: "on-ground" },
        ],
        propStatesAtEnd: [
          { propId: "asset-boombox", state: "playing", holderCharacterId: "asset-jaxx", position: "on shoulder" },
        ],
      },
      {
        id: "shot-reaction", label: "03", duration: "12-15s", framing: "Extreme close-up, profile", lens: "85mm", movement: "Static", camera: "arri-alexa-35", lensModel: "zeiss-supreme-prime", action: "ROKO and REIN trade a glance of mock dread.", acting: "Restrained laughter, micro-expressions.", direction: "left-to-right",
        participants: [
          { characterId: "asset-roko", role: "primary", position: "center-left", entrance: "already-in-frame" },
          { characterId: "asset-rein", role: "primary", position: "center-right", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-roko", "asset-rein"] },
      },
      {
        id: "shot-detonate", label: "04", duration: "15-24s", framing: "Wide", lens: "35mm", movement: "Dolly", camera: "sony-venice-2", lensModel: "cooke-s7i", action: "JAXX opens the cover, presses the detonator; the red doors blow open.", acting: "Urgent action, stunned silence.", direction: "left-to-right",
        participants: [
          { characterId: "asset-jaxx", role: "primary", position: "center", entrance: "already-in-frame" },
          { characterId: "asset-lulu", role: "supporting", position: "background-left", entrance: "already-in-frame" },
          { characterId: "asset-roko", role: "supporting", position: "background-center", entrance: "already-in-frame" },
          { characterId: "asset-rein", role: "supporting", position: "background-right", entrance: "already-in-frame" },
        ],
        propStatesAtStart: [
          { propId: "asset-detonator", state: "closed cover", holderCharacterId: "asset-jaxx" },
        ],
        beats: [
          { id: "beat-1", order: 1, duration: 3, actorId: "asset-jaxx", verb: "opens", targetPropId: "asset-detonator", targetBodyPart: "cover", required: true, stateBefore: [{ propId: "asset-detonator", state: "closed cover", holderCharacterId: "asset-jaxx" }], stateAfter: [{ propId: "asset-detonator", state: "cover open, button exposed", holderCharacterId: "asset-jaxx" }] },
          { id: "beat-2", order: 2, duration: 1, actorId: "asset-jaxx", verb: "presses", targetPropId: "asset-detonator", targetBodyPart: "red button", required: true, stateBefore: [{ propId: "asset-detonator", state: "cover open, button exposed", holderCharacterId: "asset-jaxx" }], stateAfter: [{ propId: "asset-detonator", state: "pressed", holderCharacterId: "asset-jaxx" }] },
          { id: "beat-3", order: 3, duration: 5, actorId: "asset-jaxx", verb: "watches", targetPropId: "asset-museum-service", actionText: "the red double doors blow open with a muffled boom", required: true, cutRule: "cut exactly when the doors begin to fly inward", stateBefore: [{ propId: "asset-museum-service", state: "closed" }], stateAfter: [{ propId: "asset-museum-service", state: "blown-open" }] },
        ],
        propStatesAtEnd: [
          { propId: "asset-detonator", state: "pressed", holderCharacterId: "asset-jaxx" },
          { propId: "asset-museum-service", state: "blown-open" },
        ],
      },
    ],
  }],
};
