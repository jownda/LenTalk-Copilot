/**
 * 项目结构 Reducer（P0 开始拆分：所有结构更新集中在此，Compiler/Continuity 只接收不可变快照）
 * P0.1 覆盖：资产库（增删改、参考图）、角色（增删改、绑定资产）、身份规则、角色数量锁。
 * 场景/镜头/节拍操作在 P0.2-P0.4 分批迁入。
 */
import { deriveProjectCode, withAssetReferenceTag } from "../../engine";
import type { Asset, AssetKind, FinalAuditLogEntry, ProjectV2 } from "../../shared-types";

export const newId = () => crypto.randomUUID();

export type ProjectAction =
  | { type: "SET_PROJECT"; project: ProjectV2 }
  | { type: "PATCH_PROJECT"; patch: Partial<ProjectV2> }
  | { type: "ADD_ASSET"; kind: AssetKind; name?: string; id?: string; referencePaths?: string[]; propHolderCharacterId?: string }
  | { type: "SET_PROP_CHARACTER_LINK"; propId: string; characterId: string; linked: boolean }
  | { type: "CREATE_ASSET_VARIANT"; sourceId: string; id: string; stateName: string }
  | { type: "UPDATE_ASSET"; id: string; patch: Partial<Asset> }
  | { type: "DELETE_ASSET"; id: string }
  | { type: "SET_CHARACTER_COUNT_LOCK"; count?: number }
  | { type: "UPSERT_IDENTITY_RULE"; characterId: string; patch: Partial<NonNullable<ProjectV2["identityRules"]>[number]> }
  | { type: "DELETE_IDENTITY_RULE"; characterId: string }
  | { type: "RECORD_FINAL_AUDIT"; record: FinalAuditLogEntry };

export function assetKindLabel(kind: AssetKind): string {
  return { character: "character", location: "location", prop: "prop", "style-reference": "style-reference", "audio-reference": "audio-reference" }[kind];
}

export function projectReducer(state: ProjectV2, action: ProjectAction): ProjectV2 {
  switch (action.type) {
    case "SET_PROJECT":
      return action.project;
    case "PATCH_PROJECT": {
      const next = { ...state, ...action.patch };
      if (action.patch.projectCode === undefined) return next;
      const projectCode = action.patch.projectCode.trim() || deriveProjectCode(next.title);
      return { ...next, projectCode, assets: (next.assets ?? []).map((asset) => withAssetReferenceTag(asset, projectCode)) };
    }
    case "ADD_ASSET": {
      const id = action.id ?? newId();
      const created: Asset = withAssetReferenceTag({
        id,
        kind: action.kind,
        name: action.name ?? `NEW ${assetKindLabel(action.kind).toUpperCase()}`,
        description: "",
        descriptionZh: "",
        referencePaths: action.referencePaths ?? [],
        propHolderCharacterId: action.propHolderCharacterId,
        lockLevel: "none",
        tags: [],
        variantGroupId: id,
        baseAssetId: id,
        stateName: "base",
        version: 1,
        changeLog: "",
      }, state.projectCode?.trim() || deriveProjectCode(state.title));
      return { ...state, assets: [...(state.assets ?? []), created] };
    }
    case "SET_PROP_CHARACTER_LINK":
      return {
        ...state,
        assets: (state.assets ?? []).map((asset) => {
          if (asset.id !== action.characterId || asset.kind !== "character") return asset;
          const attached = asset.attachedPropIds ?? [];
          return action.linked
            ? (attached.includes(action.propId) ? asset : { ...asset, attachedPropIds: [...attached, action.propId] })
            : { ...asset, attachedPropIds: attached.filter((id) => id !== action.propId) };
        }),
      };
    case "CREATE_ASSET_VARIANT": {
      const source = (state.assets ?? []).find((asset) => asset.id === action.sourceId);
      if (!source) return state;
      const groupId = source.variantGroupId || source.baseAssetId || source.id;
      const nextVersion = Math.max(0, ...(state.assets ?? []).filter((asset) => asset.variantGroupId === groupId).map((asset) => asset.version ?? 1)) + 1;
      const variant = withAssetReferenceTag({
        ...source,
        id: action.id,
        variantGroupId: groupId,
        baseAssetId: source.baseAssetId || source.id,
        stateName: action.stateName.trim() || "variant",
        version: nextVersion,
        description: "",
        descriptionZh: "",
        baseDescription: source.baseDescription || source.description,
        baseDescriptionZh: source.baseDescriptionZh || source.descriptionZh,
        changeLog: "",
        stressTestStatus: "untested",
        stressTestNotes: "",
      }, state.projectCode?.trim() || deriveProjectCode(state.title));
      return { ...state, assets: [...(state.assets ?? []), variant] };
    }
    case "UPDATE_ASSET":
      return {
        ...state,
        assets: (state.assets ?? []).map((asset) => asset.id === action.id
          ? withAssetReferenceTag({ ...asset, ...action.patch }, state.projectCode?.trim() || deriveProjectCode(state.title))
          : asset),
      };
    case "DELETE_ASSET":
      return {
        ...state,
        assets: (state.assets ?? [])
          .filter((asset) => asset.id !== action.id)
          .map((asset) => asset.attachedPropIds?.includes(action.id)
            ? { ...asset, attachedPropIds: asset.attachedPropIds.filter((id) => id !== action.id) }
            : asset),
        // 删除资产时同步清理风格配方绑定
        technicalProfile: {
          ...(state.technicalProfile ?? {}),
          assetIds: (state.technicalProfile?.assetIds ?? []).filter((id) => id !== action.id),
        },
        // 同时清理引用该资产的身份规则与场景/镜头引用
        identityRules: (state.identityRules ?? []).filter((rule) => rule.characterId !== action.id),
        scenes: (state.scenes ?? []).map((scene) => ({
          ...scene,
          staging: scene.staging
            ? {
                ...scene.staging,
                ...(scene.staging.locationAssetId === action.id ? { locationAssetId: undefined } : {}),
                characterRoster: (scene.staging.characterRoster ?? []).filter((id) => id !== action.id),
                characterOrder: (scene.staging.characterOrder ?? []).filter((id) => id !== action.id),
              }
            : scene.staging,
          shots: (scene.shots ?? []).map((shot) => ({
            ...shot,
            participants: (shot.participants ?? []).filter((p) => p.characterId !== action.id),
            propStatesAtStart: (shot.propStatesAtStart ?? []).filter((s) => s.propId !== action.id),
            beats: (shot.beats ?? []).map((beat) => ({
              ...beat,
              actorId: beat.actorId === action.id ? undefined : beat.actorId,
              targetPropId: beat.targetPropId === action.id ? undefined : beat.targetPropId,
              targetCharacterId: beat.targetCharacterId === action.id ? undefined : beat.targetCharacterId,
              stateBefore: (beat.stateBefore ?? []).filter((s) => s.propId !== action.id),
              stateAfter: (beat.stateAfter ?? []).filter((s) => s.propId !== action.id),
            })),
          })),
        })),
      };
    case "SET_CHARACTER_COUNT_LOCK":
      return { ...state, characterCountLock: action.count };
    case "UPSERT_IDENTITY_RULE": {
      const rules = state.identityRules ?? [];
      const existing = rules.find((rule) => rule.characterId === action.characterId);
      const next = existing
        ? rules.map((rule) => rule.characterId === action.characterId ? { ...rule, ...action.patch } : rule)
        : [...rules, { characterId: action.characterId, uniqueMarkers: [], ...action.patch }];
      return { ...state, identityRules: next };
    }
    case "DELETE_IDENTITY_RULE":
      return { ...state, identityRules: (state.identityRules ?? []).filter((rule) => rule.characterId !== action.characterId) };
    case "RECORD_FINAL_AUDIT":
      return { ...state, finalAuditLog: [action.record, ...(state.finalAuditLog ?? [])].slice(0, 30) };
    default:
      return state;
  }
}
