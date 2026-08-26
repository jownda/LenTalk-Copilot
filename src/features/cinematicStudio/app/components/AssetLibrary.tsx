/**
 * 资产库卡片（P0.1）
 * 角色 / 地点 / 道具三个分类 Tab。
 * 每条资产：名称、英文 canonical 描述（可从中文一键翻译草稿）、用途/忽略复选框、
 * 锁定级别（未锁定/建议锁定/强锁定）、独特标记与始终可见 token。
 * 参考图压缩后存入 Asset.referencePaths（P3 SQLite 前暂存 localStorage）。
 */
import { createPortal } from "react-dom";
import { useState } from "react";
import type { Asset, AssetActingProfile, AssetKind, LockLevel, ProjectV2, SceneV2 } from "../../shared-types";
import { ImagePlus, Lock, LockKeyhole, Mic, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { ProjectAction } from "../store/projectReducer";
import type { Locale } from "../i18n";
import { classifyError, fillAssetDetails } from "../providers/ai";
import { isRemoteConfigured } from "../providers/aiSettings";

const TABS: { kind: AssetKind; labelKey: "assetTabCharacter" | "assetTabLocation" | "assetTabProp" }[] = [
  { kind: "character", labelKey: "assetTabCharacter" },
  { kind: "location", labelKey: "assetTabLocation" },
  { kind: "prop", labelKey: "assetTabProp" },
];

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
  scene: SceneV2;
  dispatch: (action: ProjectAction) => void;
  locale: Locale;
  t: Copy;
  setNotice: (message: string) => void;
}

function sceneUsesAsset(scene: SceneV2, assetId: string): boolean {
  if (scene.staging?.locationAssetId === assetId || (scene.staging?.characterOrder ?? []).includes(assetId)) return true;
  return scene.shots.some((shot) => (
    shot.characterId === assetId ||
    (shot.participants ?? []).some((participant) => participant.characterId === assetId) ||
    (shot.layout?.characterOrder ?? []).includes(assetId) ||
    [...(shot.propStatesAtStart ?? []), ...(shot.propStatesAtEnd ?? [])].some((state) => state.propId === assetId) ||
    (shot.beats ?? []).some((beat) => (
      beat.actorId === assetId || beat.targetCharacterId === assetId || beat.targetPropId === assetId ||
      [...(beat.stateBefore ?? []), ...(beat.stateAfter ?? [])].some((state) => state.propId === assetId)
    ))
  ));
}

function projectUsageCount(project: ProjectV2, assetId: string): number {
  return project.scenes.filter((scene) => sceneUsesAsset(scene, assetId)).length;
}

export default function AssetLibrary({ project, scene, dispatch, locale, t, setNotice }: AssetLibraryProps) {
  const [tab, setTab] = useState<AssetKind>("character");
  const [editingId, setEditingId] = useState<string | null>(null);
  const assets = (project.assets ?? []).filter((asset) => asset.kind === tab);
  const editing = (project.assets ?? []).find((asset) => asset.id === editingId);

  const addAsset = (kind: AssetKind) => {
    dispatch({ type: "ADD_ASSET", kind });
    setNotice(t.assetAdded);
  };

  return <section className="card asset-card">
    <div className="asset-card-heading">
      <div className="card-head-title">
        <span className="eyebrow">{t.assetLibrary}</span>
        <strong>{assets.length}</strong>
      </div>
      <button className="outline-button" onClick={() => addAsset(tab)}><Plus size={15} /> {t.addAsset}</button>
    </div>
    <div className="asset-tabs" role="tablist" aria-label={t.assetLibrary}>
      {TABS.map((item) => <button key={item.kind} role="tab" aria-selected={tab === item.kind} className={`asset-tab ${tab === item.kind ? "active" : ""}`} onClick={() => setTab(item.kind)}>{t[item.labelKey]}</button>)}
    </div>
    {assets.length === 0 ? <div className="empty assets-empty">{t.emptyAssets}</div> : <div className="asset-grid">
      {assets.map((asset) => <AssetTile key={asset.id} asset={asset} locale={locale} t={t} activeInCurrentScene={sceneUsesAsset(scene, asset.id)} projectUsageCount={projectUsageCount(project, asset.id)} onClick={() => setEditingId(asset.id)} onDelete={() => { dispatch({ type: "DELETE_ASSET", id: asset.id }); setNotice(t.assetDeleted); }} />)}
    </div>}
    {editing && typeof document !== "undefined" && (() => {
      const host = document.querySelector<HTMLElement>("[data-cinematic-studio]");
      return host ? createPortal(
        <AssetEditor scene={scene} asset={editing} locale={locale} t={t} dispatch={dispatch} setNotice={setNotice} onCreateVariant={(id) => setEditingId(id)} onClose={() => setEditingId(null)} />,
        host,
      ) : null;
    })()}
  </section>;
}

function AssetTile({ asset, locale, t, activeInCurrentScene, projectUsageCount, onClick, onDelete }: { asset: Asset; locale: Locale; t: Copy; activeInCurrentScene: boolean; projectUsageCount: number; onClick(): void; onDelete(): void }) {
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
      <span className={`asset-state-badge ${asset.stateName === "base" ? "base" : "variant"}`}>
        {asset.stateName === "base" ? t.assetBaseCard : `${t.assetStateLabel} · ${asset.stateName || t.assetVariantFallback}`}
      </span>
      <span className={`asset-usage-badge ${activeInCurrentScene ? "active" : ""}`}>
        {activeInCurrentScene ? t.assetActiveInCurrentScene : projectUsageCount > 0 ? t.assetActiveElsewhere.replace("{count}", String(projectUsageCount)) : t.assetInactive}
      </span>
      <span className="asset-tile-desc">{desc || t.noDesc}</span>
    </div>
  </div>;
}

function AssetEditor({ scene, asset, locale, t, dispatch, setNotice, onCreateVariant, onClose }: { scene: SceneV2; asset: Asset; locale: Locale; t: Copy; dispatch: (action: ProjectAction) => void; setNotice: (message: string) => void; onCreateVariant(id: string): void; onClose(): void }) {
  const [imageBusy, setImageBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [variantComposerOpen, setVariantComposerOpen] = useState(false);
  const [variantStateName, setVariantStateName] = useState("");
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

  const isBaseCard = (asset.baseAssetId ?? asset.id) === asset.id;
  const activeInCurrentScene = sceneUsesAsset(scene, asset.id);
  const createVariant = () => {
    const stateName = variantStateName.trim();
    if (!stateName) {
      setNotice(t.variantStateRequired);
      return;
    }
    const id = crypto.randomUUID();
    dispatch({ type: "CREATE_ASSET_VARIANT", sourceId: asset.id, id, stateName });
    setVariantComposerOpen(false);
    setVariantStateName("");
    setNotice(t.variantCreated.replace("{state}", stateName));
    onCreateVariant(id);
  };
  const isVehicleInterior = asset.kind === "location" && /(?:车辆|车厢|汽车|巴士|车内|vehicle|car|bus|train).*?(?:内部|内景|interior|inside)?/i.test(asset.name);

  /** AI 填写详细：按接入的参考图把描述类字段一次填完整 */
  const aiFillDetails = async () => {
    if (aiBusy) return;
    if (!isRemoteConfigured()) { setNotice(t.aiNotConfigured); return; }
    if (!(asset.referencePaths ?? []).length) { setNotice(t.aiFillNeedsImage); return; }
    setAiBusy(true);
    setNotice(t.aiFillStarted);
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
  return <div className="modal-overlay" onClick={onClose}>
    <div className="modal asset-modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <span className="eyebrow">{t.assetLibrary} · {t[assetKindKey(asset.kind)]}</span>
        <button className="modal-close" onClick={onClose}><X size={14} /></button>
      </div>

      <div className={`asset-state-status ${activeInCurrentScene ? "active" : ""}`}>
        <span className={`asset-state-badge ${isBaseCard ? "base" : "variant"}`}>{isBaseCard ? t.assetBaseCard : t.assetVariantCard}</span>
        <strong>{activeInCurrentScene ? t.assetActiveInCurrentScene : t.assetInactive}</strong>
      </div>

      <div className="asset-modal-grid">
        {/* 左列：用户填写的基础信息 */}
        <div className="asset-modal-left">
          <div className="asset-refs">
            {(asset.referencePaths ?? []).map((src, index) => <span className="asset-ref" key={index}><img src={src} alt={asset.name} /><button title={t.deleteAsset} onClick={() => removeReference(index)}><X size={10} /></button></span>)}
            <label className="asset-ref-add" title={t.referenceImage}>
              {imageBusy ? <span className="spin-dot" /> : <ImagePlus size={18} />}
              <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
            </label>
          </div>
          <label className="field-label">{t.assetName}<input className="modal-input" value={asset.name} placeholder={t.assetNamePlaceholder} onChange={(event) => update({ name: event.target.value })} /></label>
          <label className="field-label">{t.assetNotes}<textarea className="modal-textarea asset-notes-input" value={locale === "zh" ? (asset.notesZh ?? "") : (asset.notes ?? "")} placeholder={locale === "zh" ? t.assetNotesZhPlaceholder : t.assetNotesPlaceholder} onChange={(event) => update(locale === "zh" ? { notesZh: event.target.value } : { notes: event.target.value })} /></label>
          <label className="field-label">{t.assetReferenceTag}<input className="modal-input" value={`@${asset.referenceTag ?? asset.name}`} readOnly /></label>
          {/* 角色声音参考：不参与最终提示词，只用于音色和配音参考 */}
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
          <div className="field-label">{t.stressTest}<div className="lock-options">
            {(["untested", "passed", "failed"] as const).map((status) => <button key={status} className={`lock-option ${asset.stressTestStatus === status ? "active" : ""}`} onClick={() => update({ stressTestStatus: status })}>{t[status === "untested" ? "stressUntested" : status === "passed" ? "stressPassed" : "stressFailed"]}</button>)}
          </div></div>
          {isVehicleInterior && <button className="outline-button" onClick={() => update({ kind: "prop" })}>{t.moveVehicleToProp}</button>}
        </div>

        {/* 右列：描述 → AI 填写结果 */}
        <div className="asset-modal-right">
          <button type="button" className="primary-button asset-ai-fill-button" disabled={aiBusy} aria-busy={aiBusy} onClick={() => void aiFillDetails()}>{aiBusy ? <span className="spin-dot" /> : <Sparkles size={14} />} {aiBusy ? t.aiFillStarted : t.aiFillDetails}</button>
          <div className="asset-ai-output-label">{t.assetAiOutput}</div>
          {locale === "zh" ? (
            <label className="field-label">{t.assetDescriptionZh}<textarea className="modal-textarea" value={asset.descriptionZh ?? ""} placeholder={t.assetDescriptionZhPlaceholder} onChange={(event) => update({ descriptionZh: event.target.value })} /></label>
          ) : (
            <label className="field-label">{t.assetDescription}<textarea className="modal-textarea" value={asset.description} placeholder={t.assetDescriptionPlaceholder} spellCheck={false} onChange={(event) => update({ description: event.target.value })} /></label>
          )}

          {asset.kind === "character" && <div className="asset-acting-section">
            <div className="asset-section-title">{t.actingMasterProfile}</div>
            <textarea className="modal-textarea profile-textarea" value={locale === "zh" ? (acting.masterProfileZh ?? "") : (acting.masterProfile ?? "")} placeholder={t.actingMasterPlaceholder} spellCheck={false} aria-label={t.actingMasterProfile} onChange={(event) => updateActing(locale === "zh" ? { masterProfileZh: event.target.value } : { masterProfile: event.target.value })} />
            <div className="field-label">{t.voicePromptLabel}
              <textarea className="modal-textarea" value={locale === "zh" ? (acting.voicePromptZh ?? "") : (acting.voicePrompt ?? "")} placeholder={t.voicePromptPlaceholder} spellCheck={false} onChange={(event) => updateActing(locale === "zh" ? { voicePromptZh: event.target.value } : { voicePrompt: event.target.value })} />
            </div>
            <div className="field-label" title={t.performanceTargetHint}>{t.performanceTarget}
              <div className="perf-options">
                {[0, 1, 2, 3, 4, 5].map((n) => <button key={n} className={`perf-option ${acting.performanceTarget === n ? "active" : ""}`} title={t[perfTipKeys[n]]} onClick={() => updateActing({ performanceTarget: n })}>{t[perfKeys[n]]}</button>)}
              </div>
            </div>
          </div>}

        </div>
      </div>

      <div className="asset-state-section asset-state-full">
        <div className="asset-section-title">{t.assetStateArea}</div>
        <div className="asset-state-grid">
          <label className="field-label">{t.assetStateName}<input className="modal-input" value={asset.stateName ?? "base"} placeholder={t.assetStateNamePlaceholder} onChange={(event) => update({ stateName: event.target.value })} /></label>
          <label className="field-label">{t.assetVersion}<input className="modal-input" type="number" min="1" value={asset.version ?? 1} onChange={(event) => update({ version: Math.max(1, Number(event.target.value) || 1) })} /></label>
          <div className="field-label">{t.lockLevel}<div className="lock-options">
            {lockLevels.map(([level, key]) => <button key={level} className={`lock-option ${asset.lockLevel === level ? "active" : ""}`} onClick={() => update({ lockLevel: level })}>{t[key]}</button>)}
          </div></div>
        </div>
        <div className="asset-change-row">
          <label className="field-label">{t.assetChangeLog}<textarea className="modal-textarea asset-notes-input" value={asset.changeLog ?? ""} placeholder={t.assetChangeLogPlaceholder} onChange={(event) => update({ changeLog: event.target.value })} /></label>
          <div className="asset-variant-actions">
            <button className="outline-button" onClick={() => setVariantComposerOpen((open) => !open)}><Plus size={13} /> {t.createVariant}</button>
            {variantComposerOpen && <div className="asset-variant-composer">
              <label className="field-label">{t.variantStatePrompt}<input className="modal-input" autoFocus value={variantStateName} placeholder={t.assetStateNamePlaceholder} onChange={(event) => setVariantStateName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createVariant(); } }} /></label>
              <div className="asset-variant-composer-actions">
                <button className="outline-button" onClick={() => { setVariantComposerOpen(false); setVariantStateName(""); }}>{t.cancel}</button>
                <button className="primary-button" onClick={createVariant}>{t.createVariantConfirm}</button>
              </div>
            </div>}
          </div>
        </div>
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

function assetKindKey(kind: AssetKind): keyof Copy {
  const map: Record<AssetKind, keyof Copy> = { character: "assetKindCharacter", location: "assetKindLocation", prop: "assetKindProp", "style-reference": "assetKindStyleRef", "audio-reference": "assetKindAudioRef" };
  return map[kind];
}
