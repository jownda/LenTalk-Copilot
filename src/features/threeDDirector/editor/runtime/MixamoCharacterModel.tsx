import { useFrame, useLoader } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Euler,
  LoopRepeat,
  Matrix4,
  Quaternion,
  SkinnedMesh,
  Vector3,
  type Object3D,
} from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton, retargetClip } from "three/examples/jsm/utils/SkeletonUtils.js";
import { getCharacterActionPreset } from "../presets/characterActionPresets";
import { resolveNativeClipNameFromPresetId } from "../presets/nativeActionClipCatalog";
import { getObjectMotionActionSample } from "../schema/objectMotion";
import type { CharacterRigState, DirectorModelFormat, DirectorObject } from "../schema/directorProject";
import type { DirectorCharacterBoneMap } from "../schema/semanticBody";
import { getSemanticBodyPartForBoneName } from "./semanticBodyTracking";
import { getRuntimePlaybackProgress } from "./playbackRuntime";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "../schema/viewportLabels";
import { disposeIsolatedModelMaterials, isolateAndTintModelMaterials } from "./modelMaterialTint";

interface MixamoCharacterModelProps {
  url: string;
  format?: DirectorModelFormat;
  externalAnimation?: ExternalCharacterAnimation | null;
  orientationCorrection?: [number, number, number];
  rigState?: CharacterRigState;
  actionPresetId?: string | null;
  animationTimeSeconds?: number;
  onLabelAnchorYChange?: (anchorY: number) => void;
  runtimeMotion?: { duration: number; object: DirectorObject };
  boneMap?: DirectorCharacterBoneMap;
  color?: string;
}

export interface ExternalCharacterAnimation {
  url: string;
  format: "fbx" | "glb";
  clipName: string;
}

const DEFAULT_ORIENTATION_CORRECTION: [number, number, number] = [0, 0, 0];

type RestTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
};

export type CharacterRestPose = ReadonlyMap<string, RestTransform>;
export type MixamoRetargetMode = "direct" | "local-rest" | "skeleton";

export type NativeActionClipNames = Partial<Record<string, string>>;

export function getCanonicalHumanoidBoneName(name: string) {
  return name.replace(/:/g, "").replace(/^mixamorig1/i, "mixamorig");
}

export const SOLDIER_NATIVE_ACTION_CLIPS: NativeActionClipNames = {
  "run-cycle": "run",
  "walk-cycle": "walk",
  "wave-cycle": "idle",
};

export function getNativeMixamoActionClip(
  actionPresetId: string | null | undefined,
  clips: AnimationClip[],
  clipNames: NativeActionClipNames = SOLDIER_NATIVE_ACTION_CLIPS
) {
  // 自带动画面板选择: preset id 形如 "native:<clipName>"(如 native:Run),
  // 直接按动画名匹配; 否则按内置预设 id 的映射表查找。
  const clipName = resolveNativeClipNameFromPresetId(actionPresetId)
    ?? (actionPresetId ? clipNames[actionPresetId] : undefined);
  return clipName ? clips.find((clip) => clip.name.toLowerCase() === clipName) ?? null : null;
}

export function getFallbackMixamoAnimationUrl(
  actionPresetId: string | null | undefined,
  nativeClip: AnimationClip | null,
  allowExternalAnimations = true
) {
  if (nativeClip || !allowExternalAnimations) return null;
  return getCharacterActionPreset(actionPresetId)?.mixamoAnimationUrl ?? null;
}

const BONE_MAP = {
  body: "mixamorig:Hips",
  torso: "mixamorig:Spine2",
  head: "mixamorig:Head",
  leftShoulder: "mixamorig:LeftArm",
  rightShoulder: "mixamorig:RightArm",
  leftElbow: "mixamorig:LeftForeArm",
  rightElbow: "mixamorig:RightForeArm",
  leftHand: "mixamorig:LeftHand",
  rightHand: "mixamorig:RightHand",
  leftFoot: "mixamorig:LeftFoot",
  rightFoot: "mixamorig:RightFoot",
  leftHip: "mixamorig:LeftUpLeg",
  rightHip: "mixamorig:RightUpLeg",
  leftKnee: "mixamorig:LeftLeg",
  rightKnee: "mixamorig:RightLeg",
} as const;

function degrees(value: number) {
  return value * Math.PI / 180;
}

export function captureCharacterRestPose(scene: Object3D): CharacterRestPose {
  const restPose = new Map<string, RestTransform>();
  scene.traverse((object) => {
    restPose.set(object.uuid, {
      position: object.position.toArray(),
      quaternion: object.quaternion.toArray(),
      scale: object.scale.toArray(),
    });
  });
  return restPose;
}

export function applyCharacterRestPose(scene: Object3D, restPose: CharacterRestPose) {
  scene.traverse((object) => {
    const rest = restPose.get(object.uuid);
    if (!rest) return;
    object.position.fromArray(rest.position);
    object.quaternion.fromArray(rest.quaternion);
    object.scale.fromArray(rest.scale);
  });
  scene.updateMatrixWorld(true);
}

function getRestTransform(object: Object3D, restPose?: CharacterRestPose) {
  return restPose?.get(object.uuid) ?? {
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  };
}

function getRestWorldMatrix(object: Object3D, restPose?: CharacterRestPose) {
  const hierarchy: Object3D[] = [];
  let current: Object3D | null = object;
  while (current) {
    hierarchy.unshift(current);
    current = current.parent;
  }

  return hierarchy.reduce((worldMatrix, node) => {
    const rest = getRestTransform(node, restPose);
    const localMatrix = new Matrix4().compose(
      new Vector3().fromArray(rest.position),
      new Quaternion().fromArray(rest.quaternion),
      new Vector3().fromArray(rest.scale)
    );
    return worldMatrix.multiply(localMatrix);
  }, new Matrix4());
}

function getRestWorldPosition(object: Object3D, restPose?: CharacterRestPose) {
  return new Vector3().setFromMatrixPosition(getRestWorldMatrix(object, restPose));
}

function findPrimarySkinnedMesh(scene: Object3D) {
  let primary: SkinnedMesh | null = null;
  scene.traverse((object) => {
    if (!("isSkinnedMesh" in object) || object.isSkinnedMesh !== true) return;
    const skinnedMesh = object as SkinnedMesh;
    if (!primary || skinnedMesh.skeleton.bones.length > primary.skeleton.bones.length) primary = skinnedMesh;
  });
  return primary as SkinnedMesh | null;
}

function prepareSkinnedMixamoAnimationClip(
  sourceClip: AnimationClip,
  scene: Object3D,
  sourceScene: Object3D,
  targetRestPose?: CharacterRestPose
) {
  const targetMesh = findPrimarySkinnedMesh(scene);
  const sourceMesh = findPrimarySkinnedMesh(sourceScene);
  if (!targetMesh || !sourceMesh) return null;

  const sourceBonesByNormalizedName = new Map(
    sourceMesh.skeleton.bones.map((bone) => [getCanonicalHumanoidBoneName(bone.name), bone])
  );
  const sourceHips = sourceMesh.skeleton.bones.find((bone) => getCanonicalHumanoidBoneName(bone.name).endsWith("mixamorigHips"));
  const targetHips = targetMesh.skeleton.bones.find((bone) => getCanonicalHumanoidBoneName(bone.name).endsWith("mixamorigHips"));
  if (!sourceHips || !targetHips) return null;
  const targetHipsRestPosition = new Vector3().fromArray(getRestTransform(targetHips, targetRestPose).position);

  sourceMesh.skeleton.pose();
  targetMesh.skeleton.pose();
  sourceScene.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  const sourceHipsHeight = Math.max(0.0001, Math.abs(sourceHips.getWorldPosition(new Vector3()).y));
  const hipsScale = Math.abs(targetHips.getWorldPosition(new Vector3()).y) / sourceHipsHeight;

  const clip = retargetClip(targetMesh, sourceMesh, sourceClip, {
    fps: 30,
    getBoneName: (targetBone) => sourceBonesByNormalizedName.get(getCanonicalHumanoidBoneName(targetBone.name))?.name ?? targetBone.name,
    hip: sourceHips.name,
    hipInfluence: new Vector3(0, 1, 0),
    preserveBoneMatrix: true,
    scale: hipsScale,
    useFirstFramePosition: false,
  });

  for (const track of clip.tracks) {
    const match = track.name.match(/^\.bones\[(.+)]\.(position|quaternion)$/);
    if (match) track.name = `${match[1]}.${match[2]}`;
    if (track.name === `${targetHips.name}.position` && track.getValueSize() === 3) {
      for (let index = 0; index < track.values.length; index += 3) {
        targetHipsRestPosition.toArray(track.values, index);
      }
    }
  }
  sourceMesh.skeleton.pose();
  targetMesh.skeleton.pose();
  sourceScene.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  return clip;
}

export function prepareMixamoAnimationClip(
  sourceClip: AnimationClip,
  scene: Object3D,
  sourceScene?: Object3D,
  retargetMode: MixamoRetargetMode = "direct",
  targetRestPose?: CharacterRestPose,
  sourceRestPose?: CharacterRestPose,
  targetBoneMap?: DirectorCharacterBoneMap,
  stripHipsPosition = false,
) {
  if (sourceScene && retargetMode === "skeleton") {
    const skinnedClip = prepareSkinnedMixamoAnimationClip(sourceClip, scene, sourceScene, targetRestPose);
    if (skinnedClip) return skinnedClip;
  }

  const clip = sourceClip.clone();
  const objectsByNormalizedName = new Map<string, Object3D>();
  const sourceObjectsByNormalizedName = new Map<string, Object3D>();
  scene.traverse((object) => {
    const normalizedName = getCanonicalHumanoidBoneName(object.name);
    if (normalizedName && !objectsByNormalizedName.has(normalizedName)) {
      objectsByNormalizedName.set(normalizedName, object);
    }
  });
  sourceScene?.traverse((object) => {
    const normalizedName = getCanonicalHumanoidBoneName(object.name);
    if (normalizedName && !sourceObjectsByNormalizedName.has(normalizedName)) {
      sourceObjectsByNormalizedName.set(normalizedName, object);
    }
  });
  clip.tracks.forEach((track) => {
    const propertySeparator = track.name.lastIndexOf(".");
    if (propertySeparator < 0) return;
    const sourceNodeName = track.name.slice(0, propertySeparator);
    const normalizedSourceNodeName = getCanonicalHumanoidBoneName(sourceNodeName);
    const semanticBodyPart = getSemanticBodyPartForBoneName(sourceNodeName);
    const mappedTargetName = semanticBodyPart ? targetBoneMap?.[semanticBodyPart] : undefined;
    const mappedTargetNode = mappedTargetName ? scene.getObjectByName(mappedTargetName) : null;
    const targetNode = mappedTargetNode
      ?? scene.getObjectByName(sourceNodeName)
      ?? objectsByNormalizedName.get(normalizedSourceNodeName);
    if (!targetNode) return;

    if (
      track.name.endsWith(".quaternion")
      && track.getValueSize() === 4
      && sourceScene
      && (retargetMode === "local-rest" || retargetMode === "skeleton")
    ) {
      const sourceNode = sourceScene.getObjectByName(sourceNodeName)
        ?? sourceObjectsByNormalizedName.get(normalizedSourceNodeName);
      if (sourceNode) {
        const targetRestQuaternion = new Quaternion().fromArray(getRestTransform(targetNode, targetRestPose).quaternion);
        const sourceRestQuaternion = new Quaternion().fromArray(getRestTransform(sourceNode, sourceRestPose).quaternion);
        const restOffset = targetRestQuaternion.multiply(sourceRestQuaternion.invert());
        const sourceRotation = new Quaternion();
        for (let index = 0; index < track.values.length; index += 4) {
          sourceRotation.fromArray(track.values, index);
          restOffset.clone().multiply(sourceRotation).normalize().toArray(track.values, index);
        }
      }
    }

    if (targetNode.name !== sourceNodeName) {
      track.name = `${targetNode.name}${track.name.slice(propertySeparator)}`;
    }
  });
  // 剥离全部骨骼的 position track: 角色位置由场景 rest transform 控制, 动画不做位移。
  // 用于骨骼 rest 单位与动画单位不一致的模型(如 soldier.glb 骨骼 position 是 cm、
  // 根节点 -90°+scale 0.01, 而 walk.fbx 动画 position 是米)——mixer 把米值直接
  // 写到 cm 骨骼会压扁骨架(Hips z=106 也因 worldHeightScale 巨大被抛飞)。只保留
  // 旋转 track(无量纲, 与 rest 无关, direct 模式直接应用)。
  if (stripHipsPosition) {
    clip.tracks = clip.tracks.filter((track) => {
      const separator = track.name.lastIndexOf(".");
      if (separator < 0) return true;
      const trackPropertyName = track.name.slice(separator + 1);
      return trackPropertyName !== "position";
    });
    return clip;
  }

  const hipsTrack = clip.tracks.find((track) => {
    const [nodeName, propertyName] = track.name.split(".");
    return propertyName === "position" && getCanonicalHumanoidBoneName(nodeName).endsWith("mixamorigHips");
  });
  if (!hipsTrack || hipsTrack.getValueSize() !== 3) return clip;

  const nodeName = hipsTrack.name.slice(0, hipsTrack.name.lastIndexOf("."));
  const targetHips = scene.getObjectByName(nodeName)
    ?? objectsByNormalizedName.get(getCanonicalHumanoidBoneName(nodeName));
  if (!targetHips || hipsTrack.values.length < 3) return clip;

  const sourceBaseY = hipsTrack.values[1];
  const sourceHips = sourceScene
    ? sourceScene.getObjectByName(nodeName)
      ?? sourceObjectsByNormalizedName.get(getCanonicalHumanoidBoneName(nodeName))
    : null;
  const sourceHipsWorldHeight = sourceHips
    ? Math.max(0.0001, Math.abs(getRestWorldPosition(sourceHips, sourceRestPose).y))
    : Math.max(0.0001, Math.abs(sourceBaseY));
  const targetHipsWorldHeight = Math.max(0.0001, Math.abs(getRestWorldPosition(targetHips, targetRestPose).y));
  const worldHeightScale = sourceScene ? targetHipsWorldHeight / sourceHipsWorldHeight : 1;
  const targetBasePosition = new Vector3().fromArray(getRestTransform(targetHips, targetRestPose).position);
  const parentWorldInverse = targetHips.parent
    ? getRestWorldMatrix(targetHips.parent, targetRestPose).invert()
    : null;
  const localOrigin = parentWorldInverse
    ? new Vector3().applyMatrix4(parentWorldInverse)
    : new Vector3();
  for (let index = 0; index < hipsTrack.values.length; index += 3) {
    const worldVerticalDelta = new Vector3(
      0,
      retargetMode === "skeleton"
        ? 0
        : (hipsTrack.values[index + 1] - sourceBaseY) * worldHeightScale,
      0
    );
    const localDelta = parentWorldInverse
      ? worldVerticalDelta.applyMatrix4(parentWorldInverse).sub(localOrigin)
      : worldVerticalDelta;
    hipsTrack.values[index] = targetBasePosition.x + localDelta.x;
    hipsTrack.values[index + 1] = targetBasePosition.y + localDelta.y;
    hipsTrack.values[index + 2] = targetBasePosition.z + localDelta.z;
  }
  return clip;
}

function rotationForBone(name: string, controls: Record<string, number>): [number, number, number] | null {
  const normalizedName = getCanonicalHumanoidBoneName(name);
  const joint = Object.entries(BONE_MAP).find(([, bone]) => getCanonicalHumanoidBoneName(bone) === normalizedName)?.[0];
  if (!joint) return null;
  const pitch = degrees(controls[`${joint}.pitch`] ?? controls[`${joint}.bend`] ?? 0);
  const yaw = degrees(controls[`${joint}.yaw`] ?? controls[`${joint}.twist`] ?? 0);
  const roll = degrees(controls[`${joint}.roll`] ?? controls[`${joint}.spread`] ?? 0);

  if (joint === "leftShoulder" || joint === "leftHip") return [yaw, pitch, roll];
  if (joint === "rightShoulder" || joint === "rightHip") return [yaw, pitch, -roll];
  if (joint === "leftElbow" || joint === "leftKnee") return [0, pitch, 0];
  if (joint === "rightElbow" || joint === "rightKnee") return [0, -pitch, 0];
  return [pitch, yaw, roll];
}

const ROBOT_TPOSE_CONTROLS = {
  "leftShoulder.spread": -70,
  "rightShoulder.spread": 70,
  "leftShoulder.pitch": 15,
  "rightShoulder.pitch": 15,
  "leftElbow.bend": 10,
  "rightElbow.bend": 10,
};

function getRobotPoseJoint(name: string) {
  const normalizedName = getCanonicalHumanoidBoneName(name);
  return Object.entries(BONE_MAP).find(([, bone]) => getCanonicalHumanoidBoneName(bone) === normalizedName)?.[0] ?? null;
}

function getRobotPoseControlRotation(joint: string, controls: Record<string, number>) {
  const pitch = degrees(controls[`${joint}.pitch`] ?? controls[`${joint}.bend`] ?? 0);
  const yaw = degrees(controls[`${joint}.yaw`] ?? controls[`${joint}.twist`] ?? 0);
  const roll = degrees(controls[`${joint}.roll`] ?? controls[`${joint}.spread`] ?? 0);
  if (joint === "leftElbow" || joint === "rightElbow" || joint === "leftKnee" || joint === "rightKnee") {
    return new Euler(pitch, 0, 0);
  }
  return new Euler(pitch, yaw, roll);
}

/**
 * The 0029/0030 robot rigs are authored in a T-pose, unlike the default
 * mannequins whose arms rest downward. Convert semantic world rotations to
 * each bone's own local axis so the preset remains anatomically consistent.
 */
function applyGuoRobotPose(scene: Object3D, restPose: CharacterRestPose, controls: Record<string, number>) {
  // Keep the model-authored rest pose until the user selects a pose or edits a control.
  if (Object.keys(controls).length === 0) return;

  const robotTPose = Object.entries(ROBOT_TPOSE_CONTROLS).every(([key, value]) => controls[key] === value);
  const restObjectsByBoneName = new Map<string, Object3D>();
  scene.traverse((object) => {
    const joint = getRobotPoseJoint(object.name);
    if (joint) restObjectsByBoneName.set(joint, object);
  });

  scene.traverse((object) => {
    const rest = restPose.get(object.uuid);
    const joint = getRobotPoseJoint(object.name);
    if (!rest || !joint) return;

    const restWorldRotation = new Quaternion().setFromRotationMatrix(getRestWorldMatrix(object, restPose));
    const worldDelta = new Quaternion().setFromEuler(getRobotPoseControlRotation(joint, controls));

    if (joint === "leftShoulder" || joint === "rightShoulder") {
      if (robotTPose) return;
      const forearm = restObjectsByBoneName.get(joint === "leftShoulder" ? "leftElbow" : "rightElbow");
      if (forearm) {
        const armDirection = getRestWorldPosition(forearm, restPose)
          .sub(getRestWorldPosition(object, restPose))
          .normalize();
        const armDownDelta = new Quaternion().setFromUnitVectors(armDirection, new Vector3(0, -1, 0));
        worldDelta.multiply(armDownDelta);
      }
    } else if (robotTPose && (joint === "leftElbow" || joint === "rightElbow")) {
      return;
    }

    const localDelta = restWorldRotation.clone().invert()
      .multiply(worldDelta)
      .multiply(restWorldRotation);
    object.quaternion.fromArray(rest.quaternion).multiply(localDelta);
  });
  scene.updateMatrixWorld(true);
}

function isGuoRobotCharacterUrl(url: string) {
  return /(?:0029_male-bot-a|0030_female-bot-a)\.fbx(?:$|[?#])/i.test(url);
}

const ANIMATION_SAMPLE_EPSILON = 1e-7;

export function applyMixamoAnimationSample({
  animationTimeSeconds,
  clipDuration,
  lastClipTime,
  mixer,
  restPose,
  scene,
}: {
  animationTimeSeconds: number;
  clipDuration: number;
  lastClipTime: number | null;
  mixer: AnimationMixer;
  restPose: CharacterRestPose;
  scene: Object3D;
}) {
  if (clipDuration <= 0) return lastClipTime;
  const clipTime = ((animationTimeSeconds % clipDuration) + clipDuration) % clipDuration;
  if (lastClipTime != null && Math.abs(lastClipTime - clipTime) <= ANIMATION_SAMPLE_EPSILON) {
    return lastClipTime;
  }
  applyCharacterRestPose(scene, restPose);
  mixer.setTime(clipTime);
  scene.updateMatrixWorld(true);
  return clipTime;
}

function MixamoAnimationPlayer({
  animationTimeSeconds,
  clip,
  restPose,
  runtimeMotion,
  scene,
}: {
  animationTimeSeconds: number;
  clip: AnimationClip;
  restPose: CharacterRestPose;
  runtimeMotion?: { duration: number; object: DirectorObject };
  scene: Object3D;
}) {
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const lastClipTimeRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!clip) return;
    lastClipTimeRef.current = null;
    mixer.stopAllAction();
    mixer.uncacheRoot(scene);
    applyCharacterRestPose(scene, restPose);
    const action = mixer.clipAction(clip, scene);
    action.reset().setLoop(LoopRepeat, Infinity).play();
    return () => {
      lastClipTimeRef.current = null;
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      applyCharacterRestPose(scene, restPose);
    };
  }, [clip, mixer, restPose, scene]);

  useLayoutEffect(() => {
    if (!clip || clip.duration <= 0) return;
    lastClipTimeRef.current = applyMixamoAnimationSample({
      animationTimeSeconds,
      clipDuration: clip.duration,
      lastClipTime: lastClipTimeRef.current,
      mixer,
      restPose,
      scene,
    });
  }, [animationTimeSeconds, clip, mixer, restPose, scene]);

  useFrame(() => {
    if (!runtimeMotion || clip.duration <= 0) return;
    const animationTime = getObjectMotionActionSample(
      runtimeMotion.object,
      getRuntimePlaybackProgress(),
      runtimeMotion.duration,
    ).animationTimeSeconds;
    lastClipTimeRef.current = applyMixamoAnimationSample({
      animationTimeSeconds: animationTime,
      clipDuration: clip.duration,
      lastClipTime: lastClipTimeRef.current,
      mixer,
      restPose,
      scene,
    });
  });

  return null;
}

function PreparedExternalAnimationClip({
  animationTimeSeconds,
  retargetMode,
  restPose,
  scene,
  sourceClip,
  sourceScene,
  runtimeMotion,
  targetBoneMap,
  stripHipsPosition = false,
}: {
  animationTimeSeconds: number;
  retargetMode: MixamoRetargetMode;
  restPose: CharacterRestPose;
  scene: Object3D;
  sourceClip: AnimationClip | null;
  sourceScene: Object3D;
  runtimeMotion?: { duration: number; object: DirectorObject };
  targetBoneMap?: DirectorCharacterBoneMap;
  stripHipsPosition?: boolean;
}) {
  const sourceRestPose = useMemo(() => captureCharacterRestPose(sourceScene), [sourceScene]);
  const clip = useMemo(
    () => sourceClip
      ? prepareMixamoAnimationClip(
          sourceClip,
          scene,
          sourceScene,
          retargetMode,
          restPose,
          sourceRestPose,
          targetBoneMap,
          stripHipsPosition
        )
      : null,
    [restPose, retargetMode, scene, sourceClip, sourceRestPose, sourceScene, stripHipsPosition, targetBoneMap]
  );
  return clip
    ? <MixamoAnimationPlayer animationTimeSeconds={animationTimeSeconds} clip={clip} restPose={restPose} runtimeMotion={runtimeMotion} scene={scene} />
    : null;
}

function ExternalFbxAnimationClip({ animation, ...props }: {
  animation: ExternalCharacterAnimation;
  animationTimeSeconds: number;
  retargetMode: MixamoRetargetMode;
  restPose: CharacterRestPose;
  runtimeMotion?: { duration: number; object: DirectorObject };
  targetBoneMap?: DirectorCharacterBoneMap;
  stripHipsPosition?: boolean;
  scene: Object3D;
}) {
  const source = useLoader(FBXLoader, animation.url);
  const sourceClip = source.animations.find((clip) => clip.name === animation.clipName) ?? source.animations[0] ?? null;
  return <PreparedExternalAnimationClip {...props} sourceClip={sourceClip} sourceScene={source} />;
}

function ExternalGlbAnimationClip({ animation, ...props }: {
  animation: ExternalCharacterAnimation;
  animationTimeSeconds: number;
  retargetMode: MixamoRetargetMode;
  restPose: CharacterRestPose;
  runtimeMotion?: { duration: number; object: DirectorObject };
  targetBoneMap?: DirectorCharacterBoneMap;
  stripHipsPosition?: boolean;
  scene: Object3D;
}) {
  const source = useLoader(GLTFLoader, animation.url);
  const sourceClip = source.animations.find((clip) => clip.name === animation.clipName) ?? source.animations[0] ?? null;
  return <PreparedExternalAnimationClip {...props} sourceClip={sourceClip} sourceScene={source.scene} />;
}

function ExternalCharacterAnimationClip(props: {
  animation: ExternalCharacterAnimation;
  animationTimeSeconds: number;
  retargetMode: MixamoRetargetMode;
  restPose: CharacterRestPose;
  runtimeMotion?: { duration: number; object: DirectorObject };
  targetBoneMap?: DirectorCharacterBoneMap;
  stripHipsPosition?: boolean;
  scene: Object3D;
}) {
  return props.animation.format === "glb"
    ? <ExternalGlbAnimationClip {...props} />
    : <ExternalFbxAnimationClip {...props} />;
}

function LoadedMixamoCharacter({
  boneMap,
  color,
  actionPresetId,
  animationTimeSeconds = 0,
  allowExternalAnimations = true,
  externalAnimation,
  orientationCorrection = DEFAULT_ORIENTATION_CORRECTION,
  nativeActionClipNames = SOLDIER_NATIVE_ACTION_CLIPS,
  nativeAnimations = [],
  robotNeutralTPose = false,
  disableModelTextures = false,
  stripHipsPosition = false,
  source,
  retargetMode,
  rigState,
  runtimeMotion,
  onLabelAnchorYChange,
}: Omit<MixamoCharacterModelProps, "url"> & {
  allowExternalAnimations?: boolean;
  nativeActionClipNames?: NativeActionClipNames;
  nativeAnimations?: AnimationClip[];
  robotNeutralTPose?: boolean;
  disableModelTextures?: boolean;
  stripHipsPosition?: boolean;
  source: Object3D;
  retargetMode: MixamoRetargetMode;
}) {
  const nativeClip = getNativeMixamoActionClip(actionPresetId, nativeAnimations, nativeActionClipNames);
  const animationUrl = externalAnimation
    ? null
    : getFallbackMixamoAnimationUrl(actionPresetId, nativeClip, allowExternalAnimations);
  const { scene, restPose, scale, offset } = useMemo(() => {
    const clone = cloneSkeleton(source) as Object3D;
    clone.rotation.set(...orientationCorrection);
    clone.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(clone);
    const size = bounds.getSize(new Vector3());
    const modelScale = size.y > 0 ? 1.8 / size.y : 0.01;
    return {
      scene: clone,
      restPose: captureCharacterRestPose(clone),
      scale: modelScale,
      offset: new Vector3(
        -(bounds.min.x + bounds.max.x) * .5 * modelScale,
        -bounds.min.y * modelScale,
        -(bounds.min.z + bounds.max.z) * .5 * modelScale
      ),
    };
  }, [orientationCorrection, source]);

  useLayoutEffect(() => {
    isolateAndTintModelMaterials(scene, color, disableModelTextures);
  }, [color, disableModelTextures, scene]);
  useLayoutEffect(() => () => disposeIsolatedModelMaterials(scene), [scene]);

  useLayoutEffect(() => {
    if (animationUrl || nativeClip || externalAnimation) {
      onLabelAnchorYChange?.(1.8 + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP);
      return;
    }
    const controls = rigState?.controls ?? {};
    applyCharacterRestPose(scene, restPose);
    if (robotNeutralTPose) applyGuoRobotPose(scene, restPose, controls);
    else {
      scene.traverse((object) => {
        const rest = restPose.get(object.uuid);
        if (!rest) return;
        const rotation = rotationForBone(object.name, controls);
        if (rotation) object.quaternion.multiply(new Quaternion().setFromEuler(new Euler(...rotation)));
      });
    }
    onLabelAnchorYChange?.(1.8 + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP + (controls["body.offsetY"] ?? 0));
  }, [
    animationUrl,
    externalAnimation,
    nativeClip,
    onLabelAnchorYChange,
    restPose,
    rigState?.controls,
    robotNeutralTPose,
    scene,
  ]);

  // GLB 动画的 Hips position track 常含根骨骼位移(root motion):
  // soldier 的 Run 等也有位移。角色位置由场景 transform 控制, 直接应用
  // 该 track 会把角色放倒/抬飞, 故播放前剥离 Hips 的 position track,
  // 仅保留旋转(外部 FBX 动画已由 prepareMixamoAnimationClip 做过根位移
  // 处理, 不走这里)。
  const preparedNativeClip = useMemo(() => {
    if (!nativeClip) return null;
    const clip = nativeClip.clone();
    clip.tracks = clip.tracks.filter((track) => {
      const separator = track.name.lastIndexOf(".");
      if (separator < 0) return true;
      const nodeName = track.name.slice(0, separator);
      const propertyName = track.name.slice(separator + 1);
      if (propertyName === "position" && getCanonicalHumanoidBoneName(nodeName).endsWith("Hips")) {
        return false;
      }
      return true;
    });
    return clip;
  }, [nativeClip]);

  const bodyOffsetY = rigState?.controls["body.offsetY"] ?? 0;
  return (
    <group name="mixamo-character" position={[offset.x, offset.y + bodyOffsetY, offset.z]} scale={scale}>
      <primitive object={scene} />
      {externalAnimation ? (
        <ExternalCharacterAnimationClip
          animation={externalAnimation}
          animationTimeSeconds={animationTimeSeconds}
          retargetMode={retargetMode}
          restPose={restPose}
          runtimeMotion={runtimeMotion}
          stripHipsPosition={stripHipsPosition}
          targetBoneMap={boneMap}
          scene={scene}
        />
      ) : preparedNativeClip ? (
        <MixamoAnimationPlayer
          animationTimeSeconds={animationTimeSeconds}
          clip={preparedNativeClip}
          restPose={restPose}
          runtimeMotion={runtimeMotion}
          scene={scene}
        />
      ) : animationUrl ? (
        <ExternalFbxAnimationClip
          animation={{ url: animationUrl, format: "fbx", clipName: "" }}
          animationTimeSeconds={animationTimeSeconds}
          retargetMode={retargetMode}
          restPose={restPose}
          runtimeMotion={runtimeMotion}
          stripHipsPosition={stripHipsPosition}
          targetBoneMap={boneMap}
          scene={scene}
        />
      ) : null}
    </group>
  );
}

function MixamoFbxCharacter(props: MixamoCharacterModelProps) {
  const loaded = useLoader(FBXLoader, props.url);
  return (
    <LoadedMixamoCharacter
      {...props}
      robotNeutralTPose={isGuoRobotCharacterUrl(props.url)}
      retargetMode="local-rest"
      source={loaded}
    />
  );
}

function MixamoGlbCharacter(props: MixamoCharacterModelProps) {
  const loaded = useLoader(GLTFLoader, props.url);
  const isSoldier = /soldier\.glb(?:$|[?#])/i.test(props.url);

  // 士兵: 去掉贴图(纯色显示) + 禁用 GLB 内嵌动画(自带动作有绝对坐标根位移,
  // 易畸形/躺倒) + 外部系统动画。soldier.glb 骨骼 rest 变换非常规(Hips z=106
  // 大偏移、LeftUpLeg 等骨骼 rest 旋转非单位), local-rest 的 rest 校正会畸形、
  // Hips position 重写会因 worldHeightScale 巨大把角色抛飞, 故走 direct(动画
  // 旋转直接应用, 骨骼名与 Mixamo 一致) + 剥离 Hips position(位置由场景控制)。
  if (isSoldier) {
    return (
      <LoadedMixamoCharacter
        {...props}
        disableModelTextures
        nativeActionClipNames={{}}
        nativeAnimations={[]}
        retargetMode="direct"
        stripHipsPosition
        source={loaded.scene}
      />
    );
  }

  // 其他 GLB: 保留内嵌动画(用户导入模型), 外部动画回退也走 local-rest 校正。
  return (
    <LoadedMixamoCharacter
      {...props}
      nativeAnimations={loaded.animations}
      retargetMode="local-rest"
      source={loaded.scene}
    />
  );
}

export function MixamoCharacterModel(props: MixamoCharacterModelProps) {
  return props.format === "glb" || (!props.format && /\.glb(?:$|[?#])/i.test(props.url))
    ? <MixamoGlbCharacter {...props} />
    : <MixamoFbxCharacter {...props} />;
}
