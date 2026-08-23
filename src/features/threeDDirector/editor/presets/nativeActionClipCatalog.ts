/**
 * 模型自带动作注册表。
 *
 * 「自带动作」= 模型文件(GLB/FBX)内嵌的动画片段。带此注册表的模型在
 * 「动作 → 动作预设」面板里会额外显示一个「自带动作」分组, 可直接选择
 * 播放对应内嵌动画; 该分组仅对匹配的模型可见(其他模型自动隐藏)。
 *
 * preset id 使用 `native:<clipName>` 格式, 运行时按 clip 名直接匹配,
 * 与 characterActionPresets 里的内置预设(walk-cycle 等)互不冲突。
 *
 * 注意: 当前无模型注册自带动作(士兵已改为系统动画, xbot/表情机器人已删)。
 * 后续若要启用某模型的自带动画面板, 在 MODEL_NATIVE_ACTION_CATALOG 加条目即可。
 */

export interface ModelNativeActionClip {
  /** 面板选择后写入 role.characterRig.actionPresetId 的 id */
  id: string;
  /** GLB/FBX 内嵌动画名(大小写不敏感匹配) */
  clipName: string;
  /** 面板显示名(名称体现自带动作) */
  label: string;
  /** 估算时长(秒), 仅用于面板展示 */
  duration: number;
}

export interface ModelNativeActionCatalogEntry {
  /** 模型显示名 */
  modelName: string;
  /** 匹配模型 url 的正则 */
  urlPattern: RegExp;
  clips: ModelNativeActionClip[];
}

export const MODEL_NATIVE_ACTION_CATALOG: ModelNativeActionCatalogEntry[] = [];

/** 按模型 url 获取该模型的自带动画选项; 不匹配的模型返回空数组(面板自动隐藏) */
export function getModelNativeActionOptions(
  modelUrl: string | null | undefined
): ModelNativeActionClip[] {
  if (!modelUrl) return [];
  const entry = MODEL_NATIVE_ACTION_CATALOG.find((item) => item.urlPattern.test(modelUrl));
  return entry?.clips ?? [];
}

/** 判断 preset id 是否为自带动画选择(id 形如 native:<clipName>) */
export function isNativeActionPresetId(presetId: string | null | undefined): boolean {
  return typeof presetId === "string" && presetId.startsWith("native:");
}

/** 从自带动画 preset id 解析出 clip 名(如 native:Run → Run) */
export function resolveNativeClipNameFromPresetId(
  presetId: string | null | undefined
): string | null {
  if (typeof presetId !== "string" || !presetId.startsWith("native:")) return null;
  const clipName = presetId.slice("native:".length).trim();
  return clipName || null;
}
