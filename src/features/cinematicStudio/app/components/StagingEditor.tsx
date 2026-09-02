/**
 * 场景站位（P0.2 · 卡片按钮 + 画面调整弹窗）
 * 场景卡片中以一张可点击的「场景站位」卡片展示：自动提取地点资产参考图作为场景缩略图，
 * 并生成简短描述。点击后在弹窗中调整画面参数（地点资产缩略图选择、180° 轴方向、
 * 左到右排序、人物间距、空间锚点）。
 */
import { useEffect, useMemo, useState } from "react";
import type { Asset, SceneStaging, SceneV2, ProjectV2 } from "../../shared-types";
import { ChevronDown, ChevronLeft, ChevronRight, GripVertical, ImagePlus, MapPin, Plus, Upload, X } from "lucide-react";
import type { CopyZh } from "../i18n";
import type { CanvasImageSource } from "./DirectorLayersCard";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

interface StagingEditorProps {
  project: ProjectV2;
  scene: SceneV2;
  t: CopyZh;
  canvasImageSources: CanvasImageSource[];
  onChange(patch: Partial<SceneStaging>): void;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function compressStagingReferenceImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    image.src = url;
  });
}

export default function StagingEditor({ project, scene, t, canvasImageSources, onChange }: StagingEditorProps) {
  const hydrate = useAssetLibraryStore((state) => state.hydrate);
  const libraryAssets = useAssetLibraryStore((state) => state.assets);
  const [open, setOpen] = useState(false);
  const [pickingLocation, setPickingLocation] = useState(false);
  const [pickingCharacter, setPickingCharacter] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [stagingReferenceBusy, setStagingReferenceBusy] = useState(false);
  const [stagingReferencePickerOpen, setStagingReferencePickerOpen] = useState(false);
  const [stagingReferencePickerSource, setStagingReferencePickerSource] = useState<"library" | "canvas">("library");
  const staging = scene.staging ?? {};
  const locationAssets = (project.assets ?? []).filter((asset) => asset.kind === "location");
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const locationAsset = locationAssets.find((asset) => asset.id === staging.locationAssetId);
  const nameOf = (id: string) => (project.assets ?? []).find((a) => a.id === id)?.name ?? id;
  const order = staging.characterOrder ?? [];
  const roster = staging.characterRoster ?? [];
  const characterCandidates = characterAssets.filter((asset) => !order.includes(asset.id));
  const libraryImages = useMemo(() => [
    ...(project.assets ?? []).flatMap((asset) => (asset.referencePaths ?? []).filter(Boolean).map((source) => ({ source, label: `${asset.name} · ${t.assetLibrary}` }))),
    ...libraryAssets.filter((asset) => asset.mediaType === "image").map((asset) => ({ source: asset.sourcePath, label: `${asset.name} · ${t.assetLibrary}` })),
  ], [libraryAssets, project.assets, t.assetLibrary]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const uploadStagingReference = async (file?: File) => {
    if (!file) return;
    setStagingReferenceBusy(true);
    try {
      onChange({ stagingReferenceImage: await compressStagingReferenceImage(file) });
      setStagingReferencePickerOpen(false);
    } finally {
      setStagingReferenceBusy(false);
    }
  };

  const selectStagingReference = (source: string) => {
    const trimmed = source.trim();
    if (!trimmed) return;
    onChange({ stagingReferenceImage: trimmed });
    setStagingReferencePickerOpen(false);
  };

  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange({ characterOrder: next });
  };
  const addCharacter = (id: string) => {
    if (order.includes(id)) return;
    onChange({
      characterOrder: [...order, id],
      // A staged character is necessarily available to the scene planner, but
      // roster-only characters do not need a default spatial placement.
      characterRoster: roster.includes(id) ? roster : [...roster, id],
    });
  };

  const sceneTitle = locationAsset?.name || scene.location?.trim() || "";
  const orderSummary = order.length ? order.map(nameOf).join(" → ") : "";
  const axisSummary = staging.axisDirection === "left-to-right" ? t.directionLTR : staging.axisDirection === "right-to-left" ? t.directionRTL : "";
  const spacingSummary = staging.spacing?.trim() ? `${t.spacing} ${staging.spacing.trim()}` : "";
  const anchorSummary = staging.anchorDescription?.trim() ? truncate(staging.anchorDescription.trim(), 22) : "";
  const summary = [sceneTitle, orderSummary, axisSummary, spacingSummary, anchorSummary].filter(Boolean).join(" · ") || t.stagingCardEmpty;
  const thumb = locationAsset?.referencePaths?.[0];

  return <div className="staging-editor">
    <button className="staging-card" onClick={() => setOpen(true)}>
      <span className="staging-card-thumb">{thumb ? <img src={thumb} alt={locationAsset?.name ?? ""} /> : <ImagePlus size={18} />}</span>
      <span className="staging-card-info">
        <span className="staging-card-title"><MapPin size={13} /> {t.stagingLock}</span>
        <span className="staging-card-desc">{summary}</span>
      </span>
      <ChevronRight size={16} className="staging-card-arrow" />
    </button>

    {open && <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal staging-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow">{t.stagingLock} · {t.stagingAdjustParams}</span>
          <button className="modal-close" onClick={() => setOpen(false)}><X size={14} /></button>
        </div>

        <div className="staging-location-field">
          <span className="chip-label">{t.locationAsset}</span>
          <div className="staging-location-row">
            {locationAsset
              ? <button className="staging-location-card" onClick={() => setPickingLocation(true)}>
                  {thumb ? <img src={thumb} alt={locationAsset.name} /> : <span className="staging-location-fallback small">{locationAsset.name.slice(0, 1)}</span>}
                  <b>{locationAsset.name}</b>
                  <span className="staging-location-remove" title={t.deleteAsset} onClick={(event) => { event.stopPropagation(); onChange({ locationAssetId: undefined }); }}><X size={12} /></span>
                </button>
              : <button className="staging-location-add" onClick={() => setPickingLocation(true)}><Plus size={18} /><span>{t.addFromAssets}</span></button>}
            <div className="staging-reference-control">
              <button type="button" className="staging-location-card staging-reference-upload" title={t.stagingReferenceImageHint} onClick={() => setStagingReferencePickerOpen((value) => !value)}>
                {staging.stagingReferenceImage
                  ? <img src={resolveImageDisplayUrl(staging.stagingReferenceImage)} alt={t.stagingReferenceImage} />
                  : <span className="staging-location-fallback small">{stagingReferenceBusy ? "…" : <ImagePlus size={15} />}</span>}
                <b>{t.stagingReferenceImage}</b>
              </button>
              {staging.stagingReferenceImage && <button type="button" className="staging-reference-remove" title={t.deleteAsset} onClick={() => onChange({ stagingReferenceImage: undefined })}><X size={12} /></button>}
            </div>
          </div>

          {stagingReferencePickerOpen && <div className="staging-reference-picker">
            <div className="reference-source-tabs">
              <button type="button" className={stagingReferencePickerSource === "library" ? "active" : ""} onClick={() => setStagingReferencePickerSource("library")}>{t.assetLibrary}</button>
              <button type="button" className={stagingReferencePickerSource === "canvas" ? "active" : ""} onClick={() => setStagingReferencePickerSource("canvas")}>{t.canvasImages}</button>
              <label className="first-frame-upload-button">
                {stagingReferenceBusy ? <span className="spin-dot" /> : <Upload size={13} />} {t.uploadImage}
                <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadStagingReference(event.target.files?.[0])} />
              </label>
            </div>
            <div className="reference-source-options">
              {(stagingReferencePickerSource === "library" ? libraryImages : canvasImageSources).length === 0
                ? <span className="hint-text">{stagingReferencePickerSource === "library" ? t.noImageReferences : t.noCanvasImages}</span>
                : (stagingReferencePickerSource === "library" ? libraryImages : canvasImageSources).map((item) => <button type="button" key={item.source} className={item.source === staging.stagingReferenceImage ? "active" : ""} onClick={() => selectStagingReference(item.source)}>
                    <img src={resolveImageDisplayUrl(item.source)} alt={item.label} />
                    <span>{item.label}</span>
                  </button>)}
            </div>
          </div>}

          {pickingLocation && <div className="staging-location-picker">
            <span className="hint-text">{t.stagingChooseLocation}</span>
            {locationAssets.length === 0
              ? <p className="hint-text">{t.stagingNoLocationHint}</p>
              : <div className="staging-location-picker-grid">
                  {locationAssets.map((asset: Asset) => (
                    <button key={asset.id} className={asset.id === staging.locationAssetId ? "active" : ""} onClick={() => { onChange({ locationAssetId: asset.id }); setPickingLocation(false); }}>
                      {asset.referencePaths?.[0] ? <img src={asset.referencePaths[0]} alt={asset.name} /> : <span className="staging-location-fallback">{asset.name.slice(0, 1)}</span>}
                      <span>{asset.name}</span>
                    </button>
                  ))}
                </div>}
          </div>}
        </div>

        <div className="fields-grid two">
          <label className="field-label">{t.axisDirection}<span className="select-wrap">
            <select value={staging.axisDirection ?? ""} onChange={(event) => onChange({ axisDirection: (event.target.value || undefined) as SceneStaging["axisDirection"] })}>
              <option value="">{t.none}</option>
              <option value="left-to-right">{t.directionLTR}</option>
              <option value="right-to-left">{t.directionRTL}</option>
            </select><ChevronDown size={14} /></span></label>
          <label className="field-label">{t.spacing}<input className="modal-input" value={staging.spacing ?? ""} placeholder={t.none} onChange={(event) => onChange({ spacing: event.target.value || undefined })} /></label>
        </div>

        <div className="field-label">{t.leftToRightOrder}
          <div className="stage-row">
            {order.length === 0 ? <span className="stage-row-empty">{t.emptyOrderHint}</span> : order.map((id, index) => (
              <span className="stage-chip order-chip" key={id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; setDragIndex(index); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) reorder(dragIndex, index); setDragIndex(null); }}>
                <GripVertical size={11} className="grip" />
                <span className="avatar small">{nameOf(id).slice(0, 1)}</span>
                <b>{nameOf(id)}</b>
                <button title={t.moveLeft} disabled={index === 0} onClick={() => reorder(index, index - 1)}><ChevronLeft size={11} /></button>
                <button title={t.moveRight} disabled={index === order.length - 1} onClick={() => reorder(index, index + 1)}><ChevronRight size={11} /></button>
                <button title={t.deleteParticipant} onClick={() => onChange({ characterOrder: order.filter((item) => item !== id) })}><X size={11} /></button>
              </span>
            ))}
          </div>
          <div className="staging-order-add-row">
            <button className="staging-order-add" onClick={() => setPickingCharacter((value) => !value)}><Plus size={13} /> {t.stagingAddCharacter}</button>
          </div>
          {pickingCharacter && <div className="staging-location-picker">
            <span className="hint-text">{t.stagingChooseCharacter}</span>
            {characterCandidates.length === 0
              ? (characterAssets.length === 0 ? <p className="hint-text">{t.stagingNoCharacterHint}</p> : <p className="hint-text">{t.stagingAllCharactersAdded}</p>)
              : <div className="staging-location-picker-grid">
                  {characterCandidates.map((asset: Asset) => (
                    <button key={asset.id} onClick={() => { addCharacter(asset.id); setPickingCharacter(false); }}>
                      {asset.referencePaths?.[0] ? <img src={asset.referencePaths[0]} alt={asset.name} /> : <span className="staging-location-fallback">{asset.name.slice(0, 1)}</span>}
                      <span>{asset.name}</span>
                    </button>
                  ))}
                </div>}
          </div>}
          <span className="hint-text">{t.dragHint}</span>
        </div>

        <label className="field-label">{t.spatialAnchor}<textarea className="modal-textarea" value={staging.anchorDescription ?? ""} placeholder={t.spatialAnchorPlaceholder} onChange={(event) => onChange({ anchorDescription: event.target.value || undefined })} /></label>

        <div className="modal-actions">
          <button className="outline-button" onClick={() => setOpen(false)}>{t.cancel}</button>
          <button className="primary-button" onClick={() => setOpen(false)}>{t.stagingDone}</button>
        </div>
      </div>
    </div>}
  </div>;
}
