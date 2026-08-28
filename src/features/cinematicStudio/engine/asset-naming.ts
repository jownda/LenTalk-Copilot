import type { Asset, AssetKind } from "../shared-types";

const KIND_PREFIX: Record<AssetKind, string> = {
  character: "char",
  location: "loc",
  prop: "prop",
  "style-reference": "style",
  "audio-reference": "audio",
};

/** 保留中英文、数字与连字符，保证 @ 引用可读且不会因空格或标点拆开。 */
export function assetToken(value: string, fallback: string): string {
  const token = value.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return token || fallback;
}

export function deriveProjectCode(title?: string): string {
  return assetToken(title || "project", "project").slice(0, 24);
}

export function buildAssetReferenceTag(asset: Pick<Asset, "kind" | "name" | "stateName" | "version">, projectCode: string): string {
  const prefix = KIND_PREFIX[asset.kind] ?? "asset";
  const code = assetToken(projectCode, "project");
  const name = assetToken(asset.name, prefix);
  const state = assetToken(asset.stateName || "base", "base");
  const version = Math.max(1, Math.round(asset.version ?? 1));
  return `${prefix}_${code}_${name}_${state}_v${version}`;
}

/** 旧资产也必须拥有稳定引用与状态基卡信息，避免同名资产在提示词里互相覆盖。 */
export function withAssetReferenceTag(asset: Asset, projectCode: string): Asset {
  const groupId = asset.variantGroupId?.trim() || asset.baseAssetId?.trim() || asset.id;
  const baseAssetId = asset.baseAssetId?.trim() || asset.id;
  const stateName = asset.stateName?.trim() || "base";
  const version = Math.max(1, Math.round(asset.version ?? 1));
  return {
    ...asset,
    variantGroupId: groupId,
    baseAssetId,
    stateName,
    version,
    referenceTag: buildAssetReferenceTag({ ...asset, stateName, version }, projectCode),
  };
}

/** 变体输出完整基卡描述加上本卡变化，基卡本身仍只输出自己的完整描述。 */
export function assetCanonicalDescription(asset: Asset, locale: "zh" | "en"): string {
  const base = locale === "zh" ? asset.baseDescriptionZh?.trim() : asset.baseDescription?.trim();
  const current = locale === "zh"
    ? (asset.descriptionZh?.trim() || asset.description.trim())
    : (asset.description.trim() || asset.descriptionZh?.trim());
  const description = [base, current].filter(Boolean).join(locale === "zh" ? "；" : "; ");
  if (description) return description;
  const kind = locale === "zh"
    ? ({ character: "角色", location: "地点", prop: "道具", "style-reference": "风格参考", "audio-reference": "音频参考" }[asset.kind])
    : asset.kind.replace("-", " ");
  const name = asset.name.trim();
  return name ? (locale === "zh" ? `${name}（${kind}）` : `${name} (${kind})`) : kind;
}
