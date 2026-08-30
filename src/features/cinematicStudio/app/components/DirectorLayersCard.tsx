/**
 * 分层导演文档卡（P0.6）。
 * 展示 AI 编译产出的导演文档各层（directorLayers），默认收起、可展开编辑：
 * - 每层一个可折叠区块，标签为 canonical 层名（中/英友好）；
 * - 层内容可编辑，改动写入 scene.directorLayers；
 * - 每层可锁定（🔒），锁定层在再次 AI 编译时不被覆盖（见 App.aiCompileScene）。
 */
import { useEffect, useMemo, useState } from "react";
import type { ProjectV2, SceneV2 } from "../../shared-types";
import { DIRECTOR_LAYERS, type DirectorLayerKey } from "../../engine";
import { ChevronDown, Lock, LockOpen, Plus, Upload, X } from "lucide-react";
import type { CopyZh, Locale } from "../i18n";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";

export interface CanvasImageSource {
  source: string;
  label: string;
}

interface DirectorLayersCardProps {
  project: ProjectV2;
  scene: SceneV2;
  t: CopyZh;
  locale: Locale;
  canvasImageSources: CanvasImageSource[];
  setNotice: (message: string) => void;
  onUpdateScene(patch: Partial<SceneV2>): void;
}

function compressFirstFrameImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, 960 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.84));
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    image.src = url;
  });
}

interface FirstFrameReferenceSlotsProps {
  project: ProjectV2;
  scene: SceneV2;
  t: CopyZh;
  canvasImageSources: CanvasImageSource[];
  setNotice: (message: string) => void;
  onUpdateScene(patch: Partial<SceneV2>): void;
  text: string;
  onTextChange(text: string): void;
}

function FirstFrameReferenceSlots({ project, scene, t, canvasImageSources, setNotice, onUpdateScene, text, onTextChange }: FirstFrameReferenceSlotsProps) {
  const hydrate = useAssetLibraryStore((state) => state.hydrate);
  const libraryAssets = useAssetLibraryStore((state) => state.assets);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<"library" | "canvas">("library");
  const [uploadBusy, setUploadBusy] = useState(false);
  const lock = scene.firstFrameLock ?? {};
  const references = lock.referenceImages ?? [];

  useEffect(() => { void hydrate(); }, [hydrate]);

  const libraryImages = useMemo(() => [
    ...(project.assets ?? []).flatMap((asset) => (asset.referencePaths ?? []).filter(Boolean).map((source) => ({ source, label: `${asset.name} · ${t.assetLibrary}` }))),
    ...libraryAssets.filter((asset) => asset.mediaType === "image").map((asset) => ({ source: asset.sourcePath, label: `${asset.name} · ${t.assetLibrary}` })),
  ], [libraryAssets, project.assets, t.assetLibrary]);

  const addReference = (source: string) => {
    const trimmed = source.trim();
    if (!trimmed || references.includes(trimmed)) return;
    onUpdateScene({ firstFrameLock: { ...lock, referenceImages: [...references, trimmed] } });
    setPickerOpen(false);
  };

  const removeReference = (source: string) => {
    const next = references.filter((item) => item !== source);
    onUpdateScene({ firstFrameLock: { ...lock, referenceImages: next.length > 0 ? next : undefined } });
  };

  const uploadReference = async (file?: File) => {
    if (!file) return;
    setUploadBusy(true);
    try {
      addReference(await compressFirstFrameImage(file));
      setNotice(t.firstFrameImageAdded);
    } catch {
      setNotice(t.uploadFailed);
    } finally {
      setUploadBusy(false);
    }
  };

  const options = pickerSource === "library" ? libraryImages : canvasImageSources;
  return <div className="first-frame-layer-editor" onClick={(event) => event.stopPropagation()}>
    <textarea className="modal-textarea director-layer-textarea" style={{ paddingLeft: `${references.length > 0 ? Math.min(references.length + 1, 5) * 40 + 14 : 54}px` }} value={text} placeholder={t.directorLayerEmpty} onChange={(event) => onTextChange(event.target.value)} />
    <div className="first-frame-reference-inline" aria-label={t.firstFrameReferenceImages}>
      {references.map((source, index) => <div className="first-frame-reference-inline-item" key={`${source}-${index}`}>
        <button type="button" className="first-frame-reference-trigger has-image" onClick={() => setPickerOpen((open) => !open)} title={t.replaceReference}>
          <img src={resolveImageDisplayUrl(source)} alt={`${t.firstFrameReferenceImages} ${index + 1}`} />
          <span>[image{index + 1}]</span>
        </button>
        <button type="button" className="first-frame-reference-remove" onClick={() => removeReference(source)} title={t.deleteAsset}><X size={10} /></button>
      </div>)}
      <button type="button" className="first-frame-reference-trigger" onClick={() => setPickerOpen((open) => !open)} title={t.addFirstFrameReference}>
        <Plus size={17} />
      </button>
    </div>
    {pickerOpen && <div className="first-frame-reference-picker">
      <div className="first-frame-reference-tabs">
        <button type="button" className={pickerSource === "library" ? "active" : ""} onClick={() => setPickerSource("library")}>{t.assetLibrary}</button>
        <button type="button" className={pickerSource === "canvas" ? "active" : ""} onClick={() => setPickerSource("canvas")}>{t.canvasImages}</button>
        <label className="first-frame-upload-button">
          {uploadBusy ? <span className="spin-dot" /> : <Upload size={13} />} {t.uploadImage}
          <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
        </label>
      </div>
      <div className="first-frame-reference-options">
        {options.length === 0
          ? <span className="hint-text">{pickerSource === "library" ? t.noImageReferences : t.noCanvasImages}</span>
          : options.map((item) => <button type="button" key={item.source} disabled={references.includes(item.source)} onClick={() => addReference(item.source)}>
            <img src={resolveImageDisplayUrl(item.source)} alt={item.label} />
            <span>{item.label}</span>
          </button>)}
      </div>
    </div>}
  </div>;
}

export default function DirectorLayersCard({ project, scene, t, locale, canvasImageSources, setNotice, onUpdateScene }: DirectorLayersCardProps) {
  const [openKey, setOpenKey] = useState<DirectorLayerKey | null>(null);
  const layers = scene.directorLayers ?? {};
  const locked = new Set(scene.lockedDirectorLayers ?? []);

  const toggleLock = (key: DirectorLayerKey) => {
    const next = new Set(locked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onUpdateScene({ lockedDirectorLayers: [...next] });
  };

  const updateLayer = (key: DirectorLayerKey, text: string) => {
    onUpdateScene({ directorLayers: { ...layers, [key]: text } });
  };

  return <section className="card director-layers-card">
    <div className="card-head">
      <div className="card-head-title"><span className="eyebrow">{t.directorDocument}</span></div>
    </div>
    <p className="hint-text">{t.directorLayersHint}</p>
    <div className="director-layers">
      {DIRECTOR_LAYERS.map((layer) => {
        const isLocked = locked.has(layer.key);
        const text = layers[layer.key] ?? "";
        const isOpen = openKey === layer.key;
        const label = locale === "zh" ? layer.zh : layer.en;
        return <div key={layer.key} className={`director-layer${isLocked ? " locked" : ""}`}>
          <div className="director-layer-head" onClick={() => setOpenKey(isOpen ? null : layer.key)}>
            <button className={`layer-lock${isLocked ? " active" : ""}`} title={isLocked ? t.unlockLayer : t.lockLayer} onClick={(event) => { event.stopPropagation(); toggleLock(layer.key); }}>
              {isLocked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
            <span className="director-layer-label">{label}</span>
            {!text && <em className="layer-empty-mark">{t.directorLayerEmpty}</em>}
            <ChevronDown size={15} className={`director-layer-caret${isOpen ? "" : " collapsed"}`} />
          </div>
          {isOpen && layer.key === "firstFrame" && <FirstFrameReferenceSlots project={project} scene={scene} t={t} canvasImageSources={canvasImageSources} setNotice={setNotice} onUpdateScene={onUpdateScene} text={text} onTextChange={(value) => updateLayer(layer.key, value)} />}
          {isOpen && layer.key !== "firstFrame" && <textarea className="modal-textarea director-layer-textarea" value={text} placeholder={t.directorLayerEmpty} onChange={(event) => updateLayer(layer.key, event.target.value)} />}
        </div>;
      })}
    </div>
  </section>;
}
