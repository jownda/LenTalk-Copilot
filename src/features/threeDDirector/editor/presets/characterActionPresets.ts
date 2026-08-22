export interface CharacterActionKeyframe {
  t: number;
  controls: Record<string, number>;
}

export interface CharacterActionPreset {
  id: string;
  label: string;
  duration: number;
  /** This action requires an imported Mixamo-compatible character asset. */
  mixamoOnly?: boolean;
  /** Optional Mixamo FBX clip used by imported Mixamo-compatible characters. */
  mixamoAnimationUrl?: string;
  mixamoDuration?: number;
  robotExpressiveDuration?: number;
  keyframes: CharacterActionKeyframe[];
}

const mixamoAnimationUrl = (fileName: string) =>
  __LOCAL_MIXAMO_ANIMATIONS_AVAILABLE__
    ? `${import.meta.env.BASE_URL}local-assets/mixamo/animations/${fileName}`
    : undefined;

export const CHARACTER_ACTION_PRESETS: CharacterActionPreset[] = [
  { id: "walk-cycle", label: "正常行走", duration: 1.1, mixamoDuration: 1.03, robotExpressiveDuration: .96, mixamoAnimationUrl: mixamoAnimationUrl("walk.fbx"), keyframes: [
    { t: 0, controls: { "leftShoulder.pitch": 24, "rightShoulder.pitch": -24, "leftElbow.bend": 18, "rightElbow.bend": 24, "leftHip.pitch": -22, "rightHip.pitch": 22, "leftKnee.bend": 8, "rightKnee.bend": 28 } },
    { t: .25, controls: { "leftShoulder.pitch": 0, "rightShoulder.pitch": 0, "leftElbow.bend": 16, "rightElbow.bend": 16, "leftHip.pitch": 0, "rightHip.pitch": 0, "leftKnee.bend": 18, "rightKnee.bend": 10 } },
    { t: .5, controls: { "leftShoulder.pitch": -24, "rightShoulder.pitch": 24, "leftElbow.bend": 24, "rightElbow.bend": 18, "leftHip.pitch": 22, "rightHip.pitch": -22, "leftKnee.bend": 28, "rightKnee.bend": 8 } },
    { t: .75, controls: { "leftShoulder.pitch": 0, "rightShoulder.pitch": 0, "leftElbow.bend": 16, "rightElbow.bend": 16, "leftHip.pitch": 0, "rightHip.pitch": 0, "leftKnee.bend": 10, "rightKnee.bend": 18 } },
    { t: 1, controls: { "leftShoulder.pitch": 24, "rightShoulder.pitch": -24, "leftElbow.bend": 18, "rightElbow.bend": 24, "leftHip.pitch": -22, "rightHip.pitch": 22, "leftKnee.bend": 8, "rightKnee.bend": 28 } },
  ] },
  { id: "run-cycle", label: "跑步", duration: .72, mixamoDuration: .72, robotExpressiveDuration: .96, mixamoAnimationUrl: mixamoAnimationUrl("run.fbx"), keyframes: [
    { t: 0, controls: { "body.pitch": 12, "leftShoulder.pitch": 46, "rightShoulder.pitch": -46, "leftElbow.bend": 78, "rightElbow.bend": 86, "leftHip.pitch": -38, "rightHip.pitch": 44, "leftKnee.bend": 26, "rightKnee.bend": 70 } },
    { t: .25, controls: { "body.pitch": 12, "leftShoulder.pitch": 0, "rightShoulder.pitch": 0, "leftElbow.bend": 82, "rightElbow.bend": 82, "leftHip.pitch": 6, "rightHip.pitch": 6, "leftKnee.bend": 46, "rightKnee.bend": 30 } },
    { t: .5, controls: { "body.pitch": 12, "leftShoulder.pitch": -46, "rightShoulder.pitch": 46, "leftElbow.bend": 86, "rightElbow.bend": 78, "leftHip.pitch": 44, "rightHip.pitch": -38, "leftKnee.bend": 70, "rightKnee.bend": 26 } },
    { t: .75, controls: { "body.pitch": 12, "leftShoulder.pitch": 0, "rightShoulder.pitch": 0, "leftElbow.bend": 82, "rightElbow.bend": 82, "leftHip.pitch": 6, "rightHip.pitch": 6, "leftKnee.bend": 30, "rightKnee.bend": 46 } },
    { t: 1, controls: { "body.pitch": 12, "leftShoulder.pitch": 46, "rightShoulder.pitch": -46, "leftElbow.bend": 78, "rightElbow.bend": 86, "leftHip.pitch": -38, "rightHip.pitch": 44, "leftKnee.bend": 26, "rightKnee.bend": 70 } },
  ] },
  { id: "wave-cycle", label: "挥手打招呼", duration: 1.2, mixamoDuration: 4.73, robotExpressiveDuration: 1.83, mixamoAnimationUrl: mixamoAnimationUrl("wave.fbx"), keyframes: [
    { t: 0, controls: { "rightShoulder.pitch": 60, "rightShoulder.spread": 0, "rightShoulder.twist": 30, "rightElbow.bend": 90, "rightHand.roll": -30, "leftShoulder.pitch": -10, "leftElbow.bend": 18 } },
    { t: .5, controls: { "rightShoulder.pitch": 60, "rightShoulder.spread": 0, "rightShoulder.twist": 30, "rightElbow.bend": 60, "rightHand.roll": 10, "leftShoulder.pitch": -10, "leftElbow.bend": 18 } },
    { t: 1, controls: { "rightShoulder.pitch": 60, "rightShoulder.spread": 0, "rightShoulder.twist": 30, "rightElbow.bend": 90, "rightHand.roll": -30, "leftShoulder.pitch": -10, "leftElbow.bend": 18 } },
  ] },
  { id: "walk-left", label: "向左走", duration: 1.466667, mixamoOnly: true, mixamoDuration: 1.466667, mixamoAnimationUrl: mixamoAnimationUrl("walk-left.fbx"), keyframes: [] },
  { id: "sit-laugh", label: "坐着大笑", duration: 8.333333, mixamoOnly: true, mixamoDuration: 8.333333, mixamoAnimationUrl: mixamoAnimationUrl("sit-laugh.fbx"), keyframes: [] },
  { id: "lazy-old-man", label: "懒老头", duration: 12.166667, mixamoOnly: true, mixamoDuration: 12.166667, mixamoAnimationUrl: mixamoAnimationUrl("lazy-old-man.fbx"), keyframes: [] },
  { id: "stumble-fall", label: "蹒跚摔倒", duration: 4.933333, mixamoOnly: true, mixamoDuration: 4.933333, mixamoAnimationUrl: mixamoAnimationUrl("stumble-fall.fbx"), keyframes: [] },
  { id: "squat-stand", label: "蹲着站起来", duration: 2.566667, mixamoOnly: true, mixamoDuration: 2.566667, mixamoAnimationUrl: mixamoAnimationUrl("squat-stand.fbx"), keyframes: [] },
];

export function getCharacterActionPreset(presetId: string | null | undefined) {
  return CHARACTER_ACTION_PRESETS.find((item) => item.id === presetId) ?? null;
}

export function sampleCharacterActionControls(presetId: string | null | undefined, elapsedSeconds: number, baseControls: Record<string, number> = {}) {
  const preset = getCharacterActionPreset(presetId);
  if (!preset?.keyframes.length) return baseControls;
  const progress = (((elapsedSeconds % preset.duration) + preset.duration) % preset.duration) / preset.duration;
  let start = preset.keyframes[0];
  let end = preset.keyframes[preset.keyframes.length - 1];
  for (let index = 1; index < preset.keyframes.length; index += 1) {
    if (progress <= preset.keyframes[index].t) {
      start = preset.keyframes[index - 1];
      end = preset.keyframes[index];
      break;
    }
  }
  const blend = Math.min(1, Math.max(0, (progress - start.t) / Math.max(.0001, end.t - start.t)));
  const controls = { ...baseControls };
  new Set([...Object.keys(start.controls), ...Object.keys(end.controls)]).forEach((key) => {
    const from = start.controls[key] ?? 0;
    controls[key] = from + ((end.controls[key] ?? 0) - from) * blend;
  });
  return controls;
}
