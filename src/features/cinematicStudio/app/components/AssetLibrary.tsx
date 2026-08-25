/**
 * 资产库卡片（P0.1）
 * 角色 / 地点 / 道具 / 风格·声音参考 四个 Tab。
 * 每条资产：名称、英文 canonical 描述（可从中文一键翻译草稿）、用途/忽略复选框、
 * 锁定级别（未锁定/建议锁定/强锁定）、独特标记与始终可见 token。
 * 参考图压缩后存入 Asset.referencePaths（P3 SQLite 前暂存 localStorage）。
 */
import { useState } from "react";
import type { Asset, AssetActingProfile, AssetKind, LockLevel, ProjectV2 } from "../../shared-types";
import { ImagePlus, Lock, LockKeyhole, Mic, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { ProjectAction } from "../store/projectReducer";
import type { Locale } from "../i18n";
import { classifyError, fillAssetDetails } from "../providers/ai";
import { isRemoteConfigured } from "../providers/aiSettings";

const TABS: { kind: AssetKind; labelKey: "assetTabCharacter" | "assetTabLocation" | "assetTabProp" | "assetTabReference" }[] = [
  { kind: "character", labelKey: "assetTabCharacter" },
  { kind: "location", labelKey: "assetTabLocation" },
  { kind: "prop", labelKey: "assetTabProp" },
  { kind: "style-reference", labelKey: "assetTabReference" },
];

/** 按资产类型显示用途选项（value → i18n key） */
const USE_FOR_OPTIONS: Record<AssetKind, [string, keyof import("../i18n").CopyZh][]> = {
  character: [["face", "useForFace"], ["body", "useForBody"], ["wardrobe", "useForWardrobe"], ["appearance", "useForAppearanceOnly"]],
  location: [["environment", "useForEnvironment"], ["appearance", "useForAppearanceOnly"]],
  prop: [["appearance", "useForPropAppearance"]],
  "style-reference": [["appearance", "useForAppearanceOnly"]],
  "audio-reference": [["appearance", "useForAppearanceOnly"]],
};

/** 按资产类型只展示有意义的「忽略」选项（地点/道具不再出现表情、姿势等无关项） */
const IGNORE_OPTIONS: Record<AssetKind, [string, keyof import("../i18n").CopyZh][]> = {
  character: [["pose", "ignorePose"], ["background", "ignoreBackground"], ["lighting", "ignoreLighting"], ["composition", "ignoreComposition"], ["expression", "ignoreExpression"]],
  location: [["lighting", "ignoreLighting"], ["composition", "ignoreComposition"]],
  prop: [["pose", "ignorePose"], ["background", "ignoreBackground"], ["lighting", "ignoreLighting"], ["composition", "ignoreComposition"]],
  "style-reference": [["lighting", "ignoreLighting"], ["composition", "ignoreComposition"]],
  "audio-reference": [["lighting", "ignoreLighting"], ["composition", "ignoreComposition"]],
};

/** 压缩上传图片到最长边 maxEdge，返回 JPEG data URL */
function compressImage(file: File, maxEdge = 720, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type === "image/svg+xml") {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (error) { URL.revokeObjectURL(url); reject(error); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

type Copy = import("../i18n").CopyZh;

interface AssetLibraryProps {
  project: ProjectV2;
  dispatch: (action: ProjectAction) => void;
  locale: Locale;
  t: Copy;
  setNotice: (message: string) => void;
}

export default function AssetLibrary({ project, dispatch, locale, t, setNotice }: AssetLibraryProps) {
  const [tab, setTab] = useState<AssetKind>("character");
  const [editingId, setEditingId] = useState<string | null>(null);
  const assets = (project.assets ?? []).filter((asset) => asset.kind === tab || (tab === "style-reference" && (asset.kind === "style-reference" || asset.kind === "audio-reference")));
  const editing = (project.assets ?? []).find((asset) => asset.id === editingId);

  const addAsset = (kind: AssetKind) => {
    dispatch({ type: "ADD_ASSET", kind });
    setNotice(t.assetAdded);
  };

  return <section className="card asset-card">
    <div className="card-head">
      <div className="card-head-title">
        <span className="eyebrow">{t.assetLibrary}</span>
        <strong>{assets.length}</strong>
      </div>
      <div className="asset-tabs">
        {TABS.map((item) => <button key={item.kind} className={`asset-tab ${tab === item.kind ? "active" : ""}`} onClick={() => setTab(item.kind)}>{t[item.labelKey]}</button>)}
      </div>
      <button className="outline-button" onClick={() => addAsset(tab)}><Plus size={15} /> {t.addAsset}</button>
    </div>
    {assets.length === 0 ? <div className="empty assets-empty">{t.emptyAssets}</div> : <div className="asset-grid">
      {assets.map((asset) => <AssetTile key={asset.id} asset={asset} locale={locale} t={t} onClick={() => setEditingId(asset.id)} onDelete={() => { dispatch({ type: "DELETE_ASSET", id: asset.id }); setNotice(t.assetDeleted); }} />)}
    </div>}
    {editing && <AssetEditor asset={editing} locale={locale} t={t} dispatch={dispatch} setNotice={setNotice} onClose={() => setEditingId(null)} />}
  </section>;
}

function AssetTile({ asset, locale, t, onClick, onDelete }: { asset: Asset; locale: Locale; t: Copy; onClick(): void; onDelete(): void }) {
  const thumb = asset.referencePaths?.[0];
  const desc = locale === "zh" ? (asset.descriptionZh?.trim() || asset.description.trim()) : (asset.description.trim() || asset.descriptionZh?.trim());
  const lockBadge = asset.lockLevel === "strict" ? <span className="lock-badge strict" title={t.lockStrict}><LockKeyhole size={9} /></span>
    : asset.lockLevel === "soft" ? <span className="lock-badge soft" title={t.lockSoft}><Lock size={9} /></span>
    : null;
  return <div className="asset-tile" onClick={onClick} title={t.editDetails}>
    <button className="char-delete" title={t.deleteAsset} onClick={(event) => { event.stopPropagation(); onDelete(); }}><X size={12} /></button>
    <div className="tile-thumb">{thumb ? <img src={thumb} alt={asset.name} /> : <span className="tile-avatar">{asset.name.slice(0, 1)}</span>}</div>
    <div className="tile-info">
      <div className="tile-row">
        <div className="tile-name">{asset.name || "…"}</div>
        {lockBadge}
      </div>
      <span className="asset-tile-desc">{desc || t.noDesc}</span>
    </div>
  </div>;
}

function AssetEditor({ asset, locale, t, dispatch, setNotice, onClose }: { asset: Asset; locale: Locale; t: Copy; dispatch: (action: ProjectAction) => void; setNotice: (message: string) => void; onClose(): void }) {
  const [imageBusy, setImageBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [markerDraft, setMarkerDraft] = useState("");
  const [alwaysDraft, setAlwaysDraft] = useState("");
  const update = (patch: Partial<Asset>) => dispatch({ type: "UPDATE_ASSET", id: asset.id, patch });
  const acting = asset.actingProfile ?? {};
  const updateActing = (patch: Partial<AssetActingProfile>) => update({ actingProfile: { ...acting, ...patch } });
  const perfKeys = ["perf0", "perf1", "perf2", "perf3", "perf4", "perf5"] as const;
  const perfTipKeys = ["perf0Tip", "perf1Tip", "perf2Tip", "perf3Tip", "perf4Tip", "perf5Tip"] as const;

  const uploadReference = async (file?: File) => {
    if (!file) return;
    setImageBusy(true);
    try {
      const dataUrl = await compressImage(file);
      update({ referencePaths: [...(asset.referencePaths ?? []), dataUrl] });
      setNotice(t.imageUploaded);
    } catch { setNotice(t.uploadFailed); } finally { setImageBusy(false); }
  };
  const removeReference = (index: number) => update({ referencePaths: (asset.referencePaths ?? []).filter((_, i) => i !== index) });

  /** 声音音色上传：音频文件 → dataURL（角色配音/音色参考） */
  const uploadVoice = (file?: File) => {
    if (!file) return;
    setVoiceBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      update({ voiceClip: String(reader.result) });
      setVoiceBusy(false);
      setNotice(t.voiceUploaded);
    };
    reader.onerror = () => { setVoiceBusy(false); setNotice(t.voiceUploadFailed); };
    reader.readAsDataURL(file);
  };

  const toggleUseFor = (value: string) => {
    const current = asset.useFor ?? [];
    update({ useFor: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  };
  const toggleIgnore = (value: string) => {
    const current = asset.ignore ?? [];
    update({ ignore: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  };

  const commitMarker = () => {
    const value = markerDraft.trim();
    if (!value) return;
    update({ uniqueMarkers: [...(asset.uniqueMarkers ?? []), value] });
    setMarkerDraft("");
  };
  const commitAlways = () => {
    const value = alwaysDraft.trim();
    if (!value) return;
    update({ alwaysVisible: [...(asset.alwaysVisible ?? []), value] });
    setAlwaysDraft("");
  };
  const onMarkerKey = (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commitMarker(); } };
  const onAlwaysKey = (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commitAlways(); } };

  /** AI 填写详细：按接入的参考图把描述类字段一次填完整 */
  const aiFillDetails = async () => {
    if (aiBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    if (!(asset.referencePaths ?? []).length) { setNotice(t.aiFillNeedsImage); return; }
    setAiBusy(true);
    try {
      const patch = await fillAssetDetails(asset, locale);
      update(patch);
      setNotice(t.aiFillDone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "timeout" || classified.kind === "network"
        ? t.aiRequestInterrupted
        : message;
      setNotice(`${t.aiFillFailed}${friendly}`);
    } finally {
      setAiBusy(false);
    }
  };

  const lockLevels: [LockLevel, keyof Copy][] = [["none", "lockNone"], ["soft", "lockSoft"], ["strict", "lockStrict"]];
  const useForOptions = USE_FOR_OPTIONS[asset.kind];
  const ignoreOptions = IGNORE_OPTIONS[asset.kind];

  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal asset-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <span className="eyebrow">{t.assetLibrary} · {t[assetKindKey(asset.kind)]}</span>
        <button className="modal-close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className="asset-modal-grid">
        <div className="asset-section-title">{t.identityAppearance}</div>
        {/* 左列：参考图 + 名称 + 锁定级别 */}
        <div className="asset-modal-left">
          <div className="asset-refs">
            {(asset.referencePaths ?? []).map((src, index) => <span className="asset-ref" key={index}><img src={src} alt={asset.name} /><button title={t.deleteAsset} onClick={() => removeReference(index)}><X size={10} /></button></span>)}
            <label className="asset-ref-add" title={t.referenceImage}>
              {imageBusy ? <span className="spin-dot" /> : <ImagePlus size={18} />}
              <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
            </label>
          </div>
          <label className="field-label">{t.assetName}<input className="modal-input" value={asset.name} placeholder={t.assetNamePlaceholder} onChange={(event) => update({ name: event.target.value })} /></label>
          {/* 声音音色（角色）：点击上传音频，可试听/删除 */}
          {asset.kind === "character" && <div className="field-label">{t.voiceClip}
            {asset.voiceClip ? (
              <div className="voice-clip">
                <audio controls src={asset.voiceClip} preload="none" />
                <button className="icon-button" title={t.deleteAsset} onClick={() => update({ voiceClip: undefined })}><X size={13} /></button>
              </div>
            ) : (
              <label className="voice-upload" title={t.voiceClip}>
                {voiceBusy ? <span className="spin-dot" /> : <Mic size={15} />}
                <span>{t.voiceUploadHint}</span>
                <input className="hidden" type="file" accept="audio/*" onChange={(event) => void uploadVoice(event.target.files?.[0])} />
              </label>
            )}
          </div>}
          <div className="field-label">{t.lockLevel}<div className="lock-options">
            {lockLevels.map(([level, key]) => <button key={level} className={`lock-option ${asset.lockLevel === level ? "active" : ""}`} onClick={() => update({ lockLevel: level })}>{t[key]}</button>)}
          </div></div>
          {asset.lockLevel === "strict" && <p className="hint-text">{t.strictIdentityHint}</p>}
        </div>

        {/* 右列：描述 + 用途 + 忽略 + 标记 */}
        <div className="asset-modal-right">
          <div className="asset-desc-row">
            {locale === "zh" ? (
              <label className="field-label">{t.assetDescriptionZh}<textarea className="modal-textarea" value={asset.descriptionZh ?? ""} placeholder={t.assetDescriptionZhPlaceholder} onChange={(event) => update({ descriptionZh: event.target.value })} /></label>
            ) : (
              <label className="field-label">{t.assetDescription}<textarea className="modal-textarea" value={asset.description} placeholder={t.assetDescriptionPlaceholder} spellCheck={false} onChange={(event) => update({ description: event.target.value })} /></label>
            )}
            <button className="outline-button translate-btn" disabled={aiBusy} onClick={() => void aiFillDetails()}>{aiBusy ? <span className="spin-dot" /> : <Sparkles size={13} />} {t.aiFillDetails}</button>
          </div>

          <div className="field-label">{t.useFor}<div className="check-chips">
            {useForOptions.map(([value, key]) => <button key={value} className={`check-chip ${(asset.useFor ?? []).includes(value) ? "active" : ""}`} onClick={() => toggleUseFor(value)}>{t[key]}</button>)}
          </div></div>
          <div className="field-label">{t.ignoreLabel}<div className="check-chips">
            {ignoreOptions.map(([value, key]) => <button key={value} className={`check-chip ${(asset.ignore ?? []).includes(value) ? "active" : ""}`} onClick={() => toggleIgnore(value)}>{t[key]}</button>)}
          </div></div>

          {asset.lockLevel === "strict" && <>
            <TokenEditor label={t.uniqueMarkers} placeholder={t.uniqueMarkerPlaceholder} tokens={asset.uniqueMarkers ?? []} draft={markerDraft} setDraft={setMarkerDraft} onCommit={commitMarker} onKey={onMarkerKey} onRemove={(token) => update({ uniqueMarkers: (asset.uniqueMarkers ?? []).filter((item) => item !== token) })} />
            <TokenEditor label={t.alwaysVisible} placeholder={t.alwaysVisiblePlaceholder} tokens={asset.alwaysVisible ?? []} draft={alwaysDraft} setDraft={setAlwaysDraft} onCommit={commitAlways} onKey={onAlwaysKey} onRemove={(token) => update({ alwaysVisible: (asset.alwaysVisible ?? []).filter((item) => item !== token) })} />
          </>}
        </div>

        {asset.kind === "character" && <div className="asset-modal-full">
          <div className="asset-section-title">{t.actingMasterProfile}</div>
          <textarea className="modal-textarea profile-textarea" value={locale === "zh" ? (acting.masterProfileZh ?? "") : (acting.masterProfile ?? "")} placeholder={t.actingMasterPlaceholder} spellCheck={false} aria-label={t.actingMasterProfile} onChange={(event) => updateActing(locale === "zh" ? { masterProfileZh: event.target.value } : { masterProfile: event.target.value })} />
          <div className="field-label">{t.voicePromptLabel}
            <textarea className="modal-textarea" value={locale === "zh" ? (acting.voicePromptZh ?? "") : (acting.voicePrompt ?? "")} placeholder={t.voicePromptPlaceholder} spellCheck={false} onChange={(event) => updateActing(locale === "zh" ? { voicePromptZh: event.target.value } : { voicePrompt: event.target.value })} />
          </div>
          <div className="field-label">{t.performanceTarget}
            <div className="perf-options">
              {[0, 1, 2, 3, 4, 5].map((n) => <button key={n} className={`perf-option ${acting.performanceTarget === n ? "active" : ""}`} title={t[perfTipKeys[n]]} onClick={() => updateActing({ performanceTarget: n })}>{t[perfKeys[n]]}</button>)}
            </div>
            <p className="hint-text">{t.performanceTargetHint}</p>
          </div>
        </div>}
      </div>

      <div className="modal-actions">
        <button className="danger-button" onClick={() => { dispatch({ type: "DELETE_ASSET", id: asset.id }); setNotice(t.assetDeleted); onClose(); }}><Trash2 size={14} /> {t.deleteAsset}</button>
        <span className="flex-spacer" />
        <button className="outline-button" onClick={onClose}>{t.cancel}</button>
        <button className="primary-button" onClick={onClose}>{t.save}</button>
      </div>
    </div>
  </div>;
}

function TokenEditor({ label, placeholder, tokens, draft, setDraft, onCommit, onKey, onRemove }: {
  label: string; placeholder: string; tokens: string[]; draft: string; setDraft(value: string): void; onCommit(): void; onKey(event: React.KeyboardEvent): void; onRemove(token: string): void;
}) {
  return <div className="field-label">{label}
    <div className="token-editor">
      {tokens.map((token) => <span className="token-chip" key={token}>{token}<button onClick={() => onRemove(token)}><X size={10} /></button></span>)}
      <input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} onBlur={onCommit} />
    </div>
  </div>;
}

function assetKindKey(kind: AssetKind): keyof Copy {
  const map: Record<AssetKind, keyof Copy> = { character: "assetKindCharacter", location: "assetKindLocation", prop: "assetKindProp", "style-reference": "assetKindStyleRef", "audio-reference": "assetKindAudioRef" };
  return map[kind];
}
