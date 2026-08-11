import { Euler, Quaternion, type Object3D, type SkinnedMesh } from "three";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import {
  getUE4BodyBoneScales,
  getUE4NeutralPoseBoneRotations,
  getUE4PoseBonePositionOffsets,
  getUE4PoseBoneRotations,
} from "./ue4MannequinRig";

export interface UE4RestBoneTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export type UE4RestPose = Record<string, UE4RestBoneTransform>;

interface ApplyUE4RestPoseAndRigOptions {
  bodyType?: CharacterBodyType;
  controls: Record<string, number>;
  restPose: UE4RestPose;
}

function isBone(object: Object3D): object is Object3D & { isBone: true } {
  return "isBone" in object && object.isBone === true;
}

/**
 * 收集场景中蒙皮网格实际使用的骨骼(通过 skeleton.bones)。
 * 部分 glb(如 Mixamo Michelle)的 joints 节点不在场景树内,scene.traverse 遍历不到,
 * 必须从 SkinnedMesh.skeleton.bones 取,否则姿势/rest pose 应用会静默失效。
 */
function collectSkeletonBones(root: Object3D): Object3D[] {
  const bones = new Set<Object3D>();

  root.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh) {
      const skeleton = (object as SkinnedMesh).skeleton;
      if (skeleton?.bones) {
        skeleton.bones.forEach((bone) => bones.add(bone));
      }
    }
  });

  return Array.from(bones);
}

function applyRotationOffset(object: Object3D, rotation: [number, number, number]) {
  object.quaternion.multiply(new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2])));
}

export function captureUE4RestPose(scene: Object3D): UE4RestPose {
  const restPose: UE4RestPose = {};

  collectSkeletonBones(scene).forEach((object) => {
    if (!isBone(object)) return;

    restPose[object.name] = {
      position: [object.position.x, object.position.y, object.position.z],
      quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    };
  });

  return restPose;
}

export function applyUE4RestPoseAndRig(
  scene: Object3D,
  { bodyType = "mannequin", controls, restPose }: ApplyUE4RestPoseAndRigOptions
) {
  const bodyScales = getUE4BodyBoneScales(bodyType);
  const positionOffsets = getUE4PoseBonePositionOffsets(controls);
  const neutralRotations = getUE4NeutralPoseBoneRotations();
  const poseRotations = getUE4PoseBoneRotations(controls, bodyType);

  collectSkeletonBones(scene).forEach((object) => {
    if (!isBone(object)) return;

    const rest = restPose[object.name];
    if (!rest) return;

    object.position.set(rest.position[0], rest.position[1], rest.position[2]);
    object.quaternion.set(rest.quaternion[0], rest.quaternion[1], rest.quaternion[2], rest.quaternion[3]);
    object.scale.set(rest.scale[0], rest.scale[1], rest.scale[2]);

    const positionOffset = positionOffsets[object.name];
    if (positionOffset) {
      object.position.set(
        rest.position[0] + positionOffset[0],
        rest.position[1] + positionOffset[1],
        rest.position[2] + positionOffset[2]
      );
    }

    const scale = bodyScales[object.name];
    if (scale) {
      object.scale.set(rest.scale[0] * scale[0], rest.scale[1] * scale[1], rest.scale[2] * scale[2]);
    }

    const neutralRotation = neutralRotations[object.name];
    if (neutralRotation) {
      applyRotationOffset(object, neutralRotation);
    }

    const rotation = poseRotations[object.name];
    if (rotation) {
      applyRotationOffset(object, rotation);
    }
  });
}
