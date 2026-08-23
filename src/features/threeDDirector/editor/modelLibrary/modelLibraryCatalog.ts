import type { CharacterImportReadiness, CharacterRigProfile } from "../schema/directorProject";
import { GEOMETRY_PRIMITIVE_OPTIONS, type GeometryPrimitiveType } from "../schema/directorProject";

export const LOCAL_MIXAMO_CHARACTER_AVAILABLE = __LOCAL_MIXAMO_CHARACTER_AVAILABLE__;
export const LOCAL_ROBOT_CHARACTER_AVAILABLE = __LOCAL_ROBOT_CHARACTER_AVAILABLE__;

export type ModelLibraryCategoryId = "characters" | "geometry" | "convenience" | "home" | "outdoor" | "tools" | "my-models";

export type ModelLibraryCategory = {
  directoryName: string;
  id: ModelLibraryCategoryId;
  label: string;
};

export type ModelLibraryItem = {
  categoryId: ModelLibraryCategoryId;
  fileName: string;
  id: string;
  name: string;
  thumbUrl?: string;
  url: string;
  kind?: "character" | "prop";
  geometryType?: GeometryPrimitiveType;
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
};

export function getModelLibraryCharacterStatus(item: ModelLibraryItem) {
  if (item.kind !== "character") return null;
  if (item.characterImportReadiness === "ready") return "可用动作";
  if (item.characterImportReadiness === "native-only") return "仅自带动作";
  if (item.characterImportReadiness === "manual-mapping") return "需骨架映射";
  if (item.characterImportReadiness === "static-only") return "仅静态";
  return "未体检";
}

export const MODEL_LIBRARY_CATEGORIES: ModelLibraryCategory[] = [
  ...(LOCAL_MIXAMO_CHARACTER_AVAILABLE || LOCAL_ROBOT_CHARACTER_AVAILABLE
    ? [{ id: "characters" as const, label: "人物", directoryName: "人物" }]
    : []),
  { id: "geometry", label: "几何模型", directoryName: "" },
  { id: "convenience", label: "便利生活", directoryName: "便利生活" },
  { id: "home", label: "居家生活", directoryName: "生活家居" },
  { id: "outdoor", label: "户外出行", directoryName: "户外出行" },
  { id: "tools", label: "工具配件", directoryName: "工具配件" },
  { id: "my-models", label: "我的模型", directoryName: "" },
];

/** 程序化几何体(立方体/球体/圆柱体等), 从「添加角色」菜单移到「模型库」的「几何模型」分类。 */
export const GEOMETRY_MODELS: ModelLibraryItem[] = GEOMETRY_PRIMITIVE_OPTIONS.map((option) => ({
  id: `geometry:${option.type}`,
  kind: "prop",
  categoryId: "geometry",
  fileName: `${option.type}.geom`,
  name: option.label,
  url: `geometry://${option.type}`,
  geometryType: option.type,
}));

const BUILTIN_LIFE_MODEL_INPUTS: Array<Omit<ModelLibraryItem, "id" | "thumbUrl" | "url">> = [
  { categoryId: "convenience", fileName: "ATM_low.fbx", name: "自动取款机" },
  { categoryId: "convenience", fileName: "trash_sorting_low.fbx", name: "分类垃圾桶" },
  { categoryId: "home", fileName: "sofa_modern_low.fbx", name: "沙发" },
  { categoryId: "home", fileName: "dining_table_low.fbx", name: "餐桌" },
  { categoryId: "home", fileName: "refrigerator_modern_low.fbx", name: "冰箱" },
  { categoryId: "home", fileName: "washing_machine_modern_low.fbx", name: "洗衣机" },
  { categoryId: "outdoor", fileName: "sedan_low.fbx", name: "家用轿车" },
  { categoryId: "outdoor", fileName: "suv_city_low.fbx", name: "城市SUV" },
  { categoryId: "outdoor", fileName: "city_bus_low.fbx", name: "城市公交车" },
  { categoryId: "outdoor", fileName: "bicycle_city_low.fbx", name: "自行车" },
  { categoryId: "outdoor", fileName: "electric_scooter_low.fbx", name: "电动踏板车" },
  { categoryId: "outdoor", fileName: "street_lamp_low.fbx", name: "路灯" },
  { categoryId: "outdoor", fileName: "street_tree_low.fbx", name: "绿化树" },
  { categoryId: "outdoor", fileName: "backpack_low.fbx", name: "背包" },
  { categoryId: "outdoor", fileName: "thermus_low.fbx", name: "保温瓶" },
  { categoryId: "outdoor", fileName: "deer_skull_low.fbx", name: "鹿头骨" },
  { categoryId: "tools", fileName: "wrench_low.fbx", name: "扳手" },
  { categoryId: "tools", fileName: "drill_press_low.fbx", name: "台钻" },
];

const localBuiltinThumbnailUrl = (fileName: string) =>
  `${import.meta.env.BASE_URL}local-assets/thumbnails/${fileName.replace(/\.fbx$/i, ".png")}`;

export const BUILTIN_LIFE_MODELS: ModelLibraryItem[] = BUILTIN_LIFE_MODEL_INPUTS.map((item) => ({
  ...item,
  id: `builtin:${item.fileName}`,
  url: `builtin://life/${item.fileName}`,
  thumbUrl: localBuiltinThumbnailUrl(item.fileName),
}));

const localMixamoAssetUrl = (path: string) => `${import.meta.env.BASE_URL}local-assets/mixamo/${path}`;

// Keep one canonical entry for each robot. The old robot-* filenames were
// aliases of these same 0029/0030 models.
// 这两个角色(动态男性/动态女性)只在「添加角色」菜单快捷添加, 不列入模型库。
export const ROBOT_CHARACTER_MODELS: ModelLibraryItem[] = LOCAL_ROBOT_CHARACTER_AVAILABLE
  ? [{
      id: "guo-character:guo-skeleton-0029-male-bot-a",
      kind: "character",
      categoryId: "characters",
      fileName: "0029_male-bot-a.fbx",
      name: "动态男性",
      thumbUrl: localMixamoAssetUrl("thumbnails/0029_male-bot-a.png"),
      url: localMixamoAssetUrl("characters/0029_male-bot-a.fbx"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }, {
      id: "guo-character:guo-skeleton-0030-female-bot-a",
      kind: "character",
      categoryId: "characters",
      fileName: "0030_female-bot-a.fbx",
      name: "动态女性",
      thumbUrl: localMixamoAssetUrl("thumbnails/0030_female-bot-a.png"),
      url: localMixamoAssetUrl("characters/0030_female-bot-a.fbx"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }]
  : [];

export const MIXAMO_CHARACTER_MODELS: ModelLibraryItem[] = LOCAL_MIXAMO_CHARACTER_AVAILABLE
  ? [{
      id: "mixamo-character:camille",
      kind: "character",
      categoryId: "characters",
      fileName: "camille.fbx",
      name: "Camille（Mixamo）",
      url: localMixamoAssetUrl("characters/camille.fbx"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }, {
      id: "rigged-character:soldier",
      kind: "character",
      categoryId: "characters",
      fileName: "soldier.glb",
      name: "士兵（自带动作）",
      url: localMixamoAssetUrl("characters/soldier.glb"),
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
      characterOrientationCorrection: [0, 0, 0],
    }]
  : [];

export function getModelLibraryItems() {
  // ROBOT_CHARACTER_MODELS(动态男性/动态女性) 只在「添加角色」菜单快捷添加, 不列入模型库。
  return [...MIXAMO_CHARACTER_MODELS, ...GEOMETRY_MODELS, ...BUILTIN_LIFE_MODELS].sort((a, b) => {
    const categoryIndexA = MODEL_LIBRARY_CATEGORIES.findIndex((category) => category.id === a.categoryId);
    const categoryIndexB = MODEL_LIBRARY_CATEGORIES.findIndex((category) => category.id === b.categoryId);

    if (categoryIndexA !== categoryIndexB) return categoryIndexA - categoryIndexB;

    return a.name.localeCompare(b.name, "zh-CN");
  });
}
