/**
 * Golden Project Seed：面包店救援（Bakery Rescue）
 * 文档 §1.2 验收案例之二。P0.3 验收：救援因果链（GUARD grips LULU → LULU freed）、
 * 玻璃瓶破碎（intact → shattered）、守卫将倒未倒的剪切约束、室内外地点、环境音效。
 */
import type { ProjectV2 } from "../../shared-types";

export const bakeryRescueProject: ProjectV2 = {
  id: "golden-bakery-rescue",
  title: "Bakery Rescue",
  description: "Five people rescue a held hostage inside a bakery; the guard is beaten, the bottle shatters, and the guard begins to fall.",
  preset: "Hollywood Naturalism",
  styleId: "bong-joon-ho",
  schemaVersion: 2,
  characterCountLock: 5,
  negativePrompt: "character drift, extra limbs, no-gravity movement, floating props, text or watermarks",
  assets: [
    {
      id: "asset-roco", kind: "character", name: "ROCO", lockLevel: "strict",
      description: "Lean, sharp-eyed rescuer in a dark cap; moves low and fast.",
      descriptionZh: "精瘦敏捷的救援者，深色鸭舌帽，行动低伏迅速。",
      referencePaths: [], tags: ["bakery"],
      uniqueMarkers: ["dark cap with torn brim"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-guard", kind: "character", name: "GUARD", lockLevel: "strict",
      description: "Burly security guard in a grey uniform, one hand gripping LULU's collar.",
      descriptionZh: "魁梧保安，灰色制服，一手抓住 LULU 衣领。",
      referencePaths: [], tags: ["bakery"],
      uniqueMarkers: ["grey uniform with stitched badge"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-lulu", kind: "character", name: "LULU", lockLevel: "strict",
      description: "Small woman in a flour-dusted apron, silver bob, frightened but defiant.",
      descriptionZh: "娇小女子，沾满面粉的围裙，银色短发，恐惧但倔强。",
      referencePaths: [], tags: ["bakery"],
      uniqueMarkers: ["silver bob haircut"],
      alwaysVisible: ["flour-dusted apron at all times"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-jaxx", kind: "character", name: "JAXX", lockLevel: "strict",
      description: "Tall man with a coiled braid, sleeves rolled, holding a bottle.",
      descriptionZh: "高个子，盘发辫，卷起袖子，手持玻璃瓶。",
      referencePaths: [], tags: ["bakery"],
      uniqueMarkers: ["coiled braid"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-rein", kind: "character", name: "REIN", lockLevel: "strict",
      description: "Stocky woman with a shaved undercut, red neck scarf, low center of gravity.",
      descriptionZh: "敦实女子，剃发底切发型，红色围巾，重心低。",
      referencePaths: [], tags: ["bakery"],
      uniqueMarkers: ["shaved undercut"],
      useFor: ["face", "body", "wardrobe"],
    },
    {
      id: "asset-bakery-interior", kind: "location", name: "BAKERY INTERIOR", lockLevel: "soft",
      description: "Warm-lit bakery with steel shelves of baguettes and a flour-dusted counter.",
      descriptionZh: "暖光面包店，金属货架摆满法棍，柜台落满面粉。",
      referencePaths: [], tags: ["bakery"],
      useFor: ["environment"],
    },
    {
      id: "asset-loading-dock", kind: "location", name: "BAKERY LOADING DOCK", lockLevel: "soft",
      description: "Grey back alley loading dock behind the bakery, rain-slicked concrete.",
      descriptionZh: "面包店后方的灰色卸货台，湿滑混凝土，微雨。",
      referencePaths: [], tags: ["bakery"],
      useFor: ["environment"],
    },
    {
      id: "asset-bottle", kind: "prop", name: "bottle", lockLevel: "soft",
      description: "Green glass beer bottle with a paper label.",
      descriptionZh: "绿色玻璃啤酒瓶，带纸质标签。",
      referencePaths: [], tags: ["bakery"],
      useFor: ["appearance"],
    },
  ],
  identityRules: [
    { characterId: "asset-roco", uniqueMarkers: ["dark cap with torn brim"] },
    { characterId: "asset-guard", uniqueMarkers: ["grey uniform with stitched badge"] },
    { characterId: "asset-lulu", uniqueMarkers: ["silver bob haircut"], alwaysVisible: ["flour-dusted apron at all times"] },
    { characterId: "asset-jaxx", uniqueMarkers: ["coiled braid"] },
    { characterId: "asset-rein", uniqueMarkers: ["shaved undercut"] },
  ],
  technicalProfile: {
    recipeId: "deakins-controlled",
    format: "photoreal",
    filmStock: "kodak-250d",
    fps: 24,
    shutterAngle: 180,
    resolution: "4K",
  },
  audioPlan: {
    sfx: ["glass shatter", "shelf crash", "guard grunt", "rain on concrete"],
    score: "none",
    subtitles: false,
  },
  scenes: [{
    id: "scene-rescue", name: "Bakery Interior", logline: "Five rescuers free LULU from the guard; the bottle shatters and the guard begins to fall.",
    location: "Warm-lit bakery", time: "Evening", weather: "Light rain", duration: "21s", palette: "warm amber / cool grey", lighting: "practical bakery light", environmentLock: true,
    staging: {
      locationAssetId: "asset-bakery-interior",
      anchorDescription: "The fight happens between the baguette shelves and the counter; the loading dock door stands open at the back.",
      characterOrder: ["asset-lulu", "asset-guard", "asset-roco", "asset-jaxx", "asset-rein"],
      axisDirection: "left-to-right",
      priorContext: "The guard grabbed LULU at the counter; the crew has just arrived through the open dock door.",
    },
    shots: [
      {
        id: "shot-grip", label: "01", duration: "0-4s", framing: "Medium close-up", lens: "35mm", movement: "Handheld", camera: "arri-alexa-35", lensModel: "zeiss-supreme-prime", action: "GUARD grips LULU's collar; she twists against his fist.", acting: "Defiant fear.", direction: "left-to-right",
        participants: [
          { characterId: "asset-lulu", role: "target", position: "center-left", entrance: "already-in-frame" },
          { characterId: "asset-guard", role: "primary", position: "center-right", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-lulu", "asset-guard"] },
        propStatesAtStart: [{ propId: "asset-lulu", state: "free" }],
        propStatesAtEnd: [{ propId: "asset-lulu", state: "gripped" }],
        beats: [
          { id: "b-grip-1", order: 1, duration: 3, actorId: "asset-guard", verb: "grips", targetCharacterId: "asset-lulu", targetBodyPart: "collar", required: true, stateAfter: [{ propId: "asset-lulu", state: "gripped" }] },
        ],
      },
      {
        id: "shot-bite", label: "02", duration: "4-9s", framing: "Close-up", lens: "50mm", movement: "Handheld", camera: "arri-alexa-35", lensModel: "cooke-s7i", action: "ROCO grabs the guard's forearm and bites; the guard recoils and LULU slips free.", acting: "Urgent precision.", direction: "left-to-right",
        participants: [
          { characterId: "asset-roco", role: "primary", position: "foreground-left", entrance: "enters-left" },
          { characterId: "asset-guard", role: "target", position: "center", entrance: "already-in-frame" },
          { characterId: "asset-lulu", role: "primary", position: "center-right", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-roco", "asset-guard", "asset-lulu"] },
        propStatesAtStart: [{ propId: "asset-lulu", state: "gripped" }],
        propStatesAtEnd: [{ propId: "asset-lulu", state: "freed" }],
        beats: [
          { id: "b-bite-1", order: 1, duration: 2, actorId: "asset-roco", verb: "grabs", targetCharacterId: "asset-guard", targetBodyPart: "right forearm", required: true, forbiddenTargets: ["asset-lulu"] },
          { id: "b-bite-2", order: 2, duration: 1, actorId: "asset-roco", verb: "bites", targetCharacterId: "asset-guard", targetBodyPart: "forearm", required: true, forbiddenTargets: ["asset-lulu"] },
          { id: "b-bite-3", order: 3, duration: 2, actorId: "asset-guard", verb: "recoils", targetCharacterId: "asset-lulu", actionText: "his grip opens; LULU slips free and stumbles backward into the shelves", required: true, stateBefore: [{ propId: "asset-lulu", state: "gripped" }], stateAfter: [{ propId: "asset-lulu", state: "freed" }] },
        ],
      },
      {
        id: "shot-bottle", label: "03", duration: "9-14s", framing: "Medium", lens: "35mm", movement: "Handheld", camera: "sony-venice-2", lensModel: "zeiss-supreme-prime", action: "JAXX raises the bottle and strikes the guard's head; glass shatters across the counter.", acting: "Desperate force.", direction: "left-to-right",
        participants: [
          { characterId: "asset-jaxx", role: "primary", position: "foreground-left", entrance: "enters-left" },
          { characterId: "asset-guard", role: "target", position: "center-right", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-jaxx", "asset-guard"] },
        propStatesAtStart: [{ propId: "asset-bottle", state: "intact", holderCharacterId: "asset-jaxx" }],
        propStatesAtEnd: [{ propId: "asset-bottle", state: "shattered" }],
        beats: [
          { id: "b-bottle-1", order: 1, duration: 2, actorId: "asset-jaxx", verb: "raises", targetPropId: "asset-bottle", targetBodyPart: "bottle neck", required: true },
          { id: "b-bottle-2", order: 2, duration: 2, actorId: "asset-jaxx", verb: "strikes", targetCharacterId: "asset-guard", targetBodyPart: "head", required: true, stateBefore: [{ propId: "asset-bottle", state: "intact", holderCharacterId: "asset-jaxx" }], stateAfter: [{ propId: "asset-bottle", state: "shattered" }] },
        ],
      },
      {
        id: "shot-sweep", label: "04", duration: "14-18s", framing: "Low wide", lens: "24mm", movement: "Handheld", camera: "arri-alexa-mini-lf", lensModel: "cooke-s7i", action: "REIN enters low and sweeps the guard's shins.", acting: "Precise, athletic.", direction: "left-to-right",
        participants: [
          { characterId: "asset-rein", role: "primary", position: "foreground", entrance: "enters-left" },
          { characterId: "asset-guard", role: "target", position: "center", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-rein", "asset-guard"] },
        propStatesAtStart: [{ propId: "asset-guard", state: "stable" }],
        propStatesAtEnd: [{ propId: "asset-guard", state: "falling-start" }],
        beats: [
          { id: "b-sweep-1", order: 1, duration: 3, actorId: "asset-rein", verb: "sweeps", targetCharacterId: "asset-guard", targetBodyPart: "shins", required: true, stateBefore: [{ propId: "asset-guard", state: "stable" }], stateAfter: [{ propId: "asset-guard", state: "falling-start" }], cutRule: "cut exactly when GUARD begins to fall; do not show the full collapse" },
        ],
      },
      {
        id: "shot-dock", label: "05", duration: "18-21s", framing: "Wide", lens: "35mm", movement: "Dolly", camera: "arri-alexa-35", lensModel: "angenieux-optimo", action: "The crew escapes through the loading dock into the rain; the guard is left falling behind.", acting: "Relief and urgency.", direction: "left-to-right",
        participants: [
          { characterId: "asset-roco", role: "primary", position: "foreground", entrance: "already-in-frame" },
          { characterId: "asset-lulu", role: "primary", position: "foreground-right", entrance: "already-in-frame" },
          { characterId: "asset-jaxx", role: "supporting", position: "center", entrance: "already-in-frame" },
          { characterId: "asset-rein", role: "supporting", position: "center-right", entrance: "already-in-frame" },
        ],
        layout: { useSceneStaging: false, characterOrder: ["asset-roco", "asset-lulu", "asset-jaxx", "asset-rein"] },
        propStatesAtStart: [{ propId: "asset-lulu", state: "freed" }, { propId: "asset-guard", state: "falling-start" }],
        propStatesAtEnd: [{ propId: "asset-lulu", state: "freed" }, { propId: "asset-guard", state: "collapsed" }],
      },
    ],
  }],
};
