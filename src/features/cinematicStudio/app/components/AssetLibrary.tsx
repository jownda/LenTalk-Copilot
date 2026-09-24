/**
 * 资产库卡片（P0.1）
 * 角色 / 地点 / 道具 / 音频四个分类 Tab。
 * 每条资产：名称、英文 canonical 描述（可从中文一键翻译草稿）、用途/忽略复选框、
 * 锁定级别（未锁定/建议锁定/强锁定）、独特标记与始终可见 token。
 * 参考图压缩后存入 Asset.referencePaths（P3 SQLite 前暂存 localStorage）。
 */
import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import type { Asset, AssetActingProfile, AssetKind, LockLevel, ProjectV2, SceneV2 } from "../../shared-types";
import { AudioLines, FolderOpen, CheckCircle2, AlertCircle, ChevronDown, Cpu, ImagePlus, Lock, LockKeyhole, Plus, Sparkles, Trash2, X, Zap } from "lucide-react";
import type { ProjectAction } from "../store/projectReducer";
import type { Locale } from "../i18n";
import { classifyError, fillAssetDetails, testAIConnection } from "../providers/ai";
import { isRemoteConfigured, listLenTalkChatModels, loadAISettings, resolveLenTalkChatModel, saveAISettings, type LenTalkChatModelOption } from "../providers/aiSettings";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useAssetLibraryStore } from "@/features/library/assetStore";
import { isCinematicMirrorAsset, pickableAudioAssets } from "@/features/library/cinematicMirror";
import type { LibraryAsset } from "@/features/library/types";

const TABS: { kind: AssetKind; labelKey: "assetTabCharacter" | "assetTabLocation" | "assetTabProp" | "assetTabAudio" }[] = [
  { kind: "character", labelKey: "assetTabCharacter" },
  { kind: "location", labelKey: "assetTabLocation" },
  { kind: "prop", labelKey: "assetTabProp" },
  { kind: "audio-reference", labelKey: "assetTabAudio" },
];

const REFERENCE_MATCH_LINE = "与参考图 100% 一致。";

function appendReferenceMatchLine(value?: string): string | undefined {
  const text = value?.trim() ?? "";
  if (!text) return value;

  const withoutExistingLine = text
    .replace(/(?:\r?\n|\s)*与参考图\s*100%\s*一致。?\s*$/u, "")
    .trimEnd();

  return withoutExistingLine
    ? `${withoutExistingLine}\n${REFERENCE_MATCH_LINE}`
    : REFERENCE_MATCH_LINE;
}

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
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
  canvasAudioSources: CanvasAudioSource[];
}

export interface CanvasAudioSource {
  source: string;
  label: string;
}

function sceneUsesAsset(scene: SceneV2, assetId: string): boolean {
  if (scene.staging?.locationAssetId === assetId || (scene.staging?.characterRoster ?? []).includes(assetId) || (scene.staging?.characterOrder ?? []).includes(assetId) || (scene.staging?.propRoster ?? []).includes(assetId)) return true;
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

export default function AssetLibrary({ project, scene, dispatch, locale, t, setNotice, canvasAudioSources }: AssetLibraryProps) {
  const [tab, setTab] = useState<AssetKind>("character");
  const [editingId, setEditingId] = useState<string | null>(null);
  const assets = (project.assets ?? []).filter((asset) => asset.kind === tab);
  const editing = (project.assets ?? []).find((asset) => asset.id === editingId);

  const addAsset = (kind: AssetKind) => {
    // 一步到位：建好资产立刻打开编辑页。
    // 旧流程是「新建 → 在网格里找到刚生成的新卡片 → 再点一次才进编辑」，多一次点击。
    const id = crypto.randomUUID();
    dispatch({ type: "ADD_ASSET", kind, id });
    setEditingId(id);
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
      const editor = <AssetEditor project={project} scene={scene} asset={editing} locale={locale} t={t} dispatch={dispatch} setNotice={setNotice} canvasAudioSources={canvasAudioSources} onCreateVariant={(id) => setEditingId(id)} onClose={() => setEditingId(null)} />;
      // 优先挂到工作室工作台（与工作室联动时保持原有布局）；
      // 从画布侧边栏打开且工作台未挂载时回退到 body：包装层 relative + z-200 形成堆叠上下文,
      // 让内部 fixed 弹窗(modal-overlay z-60)盖过素材库侧边栏(z-[140])。
      const host = document.querySelector<HTMLElement>("[data-cinematic-studio]");
      if (host) return createPortal(editor, host);
      return createPortal(
        <div className="cinematic-studio-app" data-cinematic-studio-portal style={{ position: "relative", zIndex: 200 }}>{editor}</div>,
        document.body,
      );
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
    <div className="tile-thumb">{asset.kind === "audio-reference" ? <span className="tile-avatar"><AudioLines size={22} /></span> : thumb ? <img src={resolveImageDisplayUrl(thumb)} alt={asset.name} /> : <span className="tile-avatar">{asset.name.slice(0, 1)}</span>}</div>
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

/** 素材库选择弹窗的条目：名称 + 缩略图 + 点击回调（回调在打开时由调用方绑定）。 */
interface PickerItem {
  key: string;
  name: string;
  /** 缩略图地址；音频条目留空，退化为图标。 */
  thumb?: string;
  isAudio?: boolean;
  /** 分组标题；相邻同名条目会合并到同一组。 */
  group?: string;
  onPick(): void;
}

/**
 * 素材库选择弹窗：大缩略图卡片网格 + 名称搜索。
 * 旧实现是把两列 26px 小图的内联列表直接塞进字段里，既难看清又会一路把编辑弹窗撑长。
 */
function LibraryPickerModal({ items, emptyHint, t, onClose }: {
  items: PickerItem[];
  emptyHint: string;
  t: Copy;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => (item.name || "").toLowerCase().includes(needle));
  }, [items, query]);

  /** 按 group 切块，标题只在分组首条上方渲染一次。 */
  const groups = useMemo(() => visible.reduce<{ label: string; items: PickerItem[] }[]>((acc, item) => {
    const label = item.group ?? "";
    const last = acc[acc.length - 1];
    if (last && last.label === label) last.items.push(item);
    else acc.push({ label, items: [item] });
    return acc;
  }, []), [visible]);

  return <div className="asset-picker-overlay" onClick={(event) => { event.stopPropagation(); onClose(); }}>
    <div
      className="modal asset-picker-modal"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
    >
      <div className="modal-head">
        <span className="asset-picker-title">
          <span className="eyebrow">{t.libraryPickerTitle}</span>
          <span className="asset-picker-count">{t.libraryPickerCount.replace("{count}", String(visible.length))}</span>
        </span>
        <button className="modal-close" onClick={onClose}><X size={14} /></button>
      </div>
      <input
        className="modal-input asset-picker-search"
        value={query}
        spellCheck={false}
        autoFocus
        placeholder={t.libraryPickerSearch}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="asset-picker-body ui-scrollbar">
        {visible.length === 0 ? <div className="asset-picker-empty">{emptyHint}</div> : groups.map((group, index) => <div className="asset-picker-group-block" key={group.label || `group-${index}`}>
          {group.label && <div className="asset-picker-group">{group.label}</div>}
          <div className="asset-picker-grid">
            {group.items.map((item) => <button type="button" key={item.key} className="asset-picker-tile" title={item.name} onClick={item.onPick}>
              <span className="asset-picker-thumb">
                {item.isAudio || !item.thumb ? <AudioLines size={26} /> : <img src={item.thumb} alt={item.name} />}
              </span>
              <b>{item.name || "…"}</b>
            </button>)}
          </div>
        </div>)}
      </div>
    </div>
  </div>;
}

function AssetEditor({ project, scene, asset, locale, t, dispatch, setNotice, canvasAudioSources, onCreateVariant, onClose }: { project: ProjectV2; scene: SceneV2; asset: Asset; locale: Locale; t: Copy; dispatch: (action: ProjectAction) => void; setNotice: (message: string) => void; canvasAudioSources: CanvasAudioSource[]; onCreateVariant(id: string): void; onClose(): void }) {
  const [imageBusy, setImageBusy] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [propImageBusy, setPropImageBusy] = useState(false);
  const [propPickerOpen, setPropPickerOpen] = useState(false);
  const [propPickerMode, setPropPickerMode] = useState<"choices" | "library" | "create">("choices");
  const [aiBusy, setAiBusy] = useState(false);
  /** AI 填写失败的完整诊断信息（含模型 / 接口 host / 错误类型 / 原始信息） */
  const [aiFillError, setAiFillError] = useState("");
  /** AI 填写模型选择：模型来自 LenTalk「设置 → 自定义平台」的 Chat 模型（地址/Key 同源） */
  const [fillModelOpen, setFillModelOpen] = useState(false);
  const [fillModelFilter, setFillModelFilter] = useState("");
  const [fillModelTick, setFillModelTick] = useState(0);
  const [fillModelKey, setFillModelKey] = useState(() => {
    const initial = loadAISettings();
    return initial.provider && initial.model ? `${initial.provider}:${initial.model}` : "";
  });
  const fillModelOptions = useMemo(() => listLenTalkChatModels(), [fillModelTick, fillModelOpen]);
  const fillModelSelected = fillModelOptions.find((option) => `${option.providerId}:${option.model}` === fillModelKey) ?? null;
  const fillModelLabel = fillModelSelected?.model ?? loadAISettings().model ?? "";
  const filteredFillModels = fillModelOptions.filter((option) =>
    `${option.providerName} ${option.model}`.toLowerCase().includes(fillModelFilter.trim().toLowerCase()),
  );
  const [fillTestBusy, setFillTestBusy] = useState(false);
  const [fillTestResult, setFillTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  /** 直接测当前选中模型是否连通（地址/Key 取自 LenTalk 平台配置） */
  const testFillModel = async () => {
    setFillTestBusy(true);
    setFillTestResult(null);
    const result = await testAIConnection(loadAISettings());
    setFillTestBusy(false);
    setFillTestResult(result.ok
      ? { ok: true, text: t.testOk.replace("{model}", result.model ?? fillModelLabel) }
      : {
          ok: false,
          text: t.testFailed.replace("{error}", result.errorKind === "network"
            ? t.networkErrorHint
            : result.errorKind === "gateway-timeout"
              ? t.aiGatewayTimeout
              : result.errorKind === "timeout"
                ? t.aiRequestInterrupted
                : (result.error ?? "unknown")),
        });
  };
  const [variantComposerOpen, setVariantComposerOpen] = useState(false);
  const [variantStateName, setVariantStateName] = useState("");
  /** 素材库选择器：ref = 添加图片；prop = 从图片创建道具；audio = 添加音频资产；voice = 绑定角色声音。 */
  const [libraryPicker, setLibraryPicker] = useState<null | "ref" | "prop" | "audio" | "voice">(null);
  const update = (patch: Partial<Asset>) => dispatch({ type: "UPDATE_ASSET", id: asset.id, patch });
  const refCount = (asset.referencePaths ?? []).length;
  const attachedPropIds = asset.attachedPropIds ?? [];
  const attachedProps = attachedPropIds.map((id) => (project.assets ?? []).find((candidate) => candidate.id === id && candidate.kind === "prop")).filter((candidate): candidate is Asset => Boolean(candidate));
  const attachableProps = (project.assets ?? []).filter((candidate) => candidate.kind === "prop" && !attachedPropIds.includes(candidate.id));
  const characterAssets = (project.assets ?? []).filter((candidate) => candidate.kind === "character");
  const linkedCharacters = characterAssets.filter((character) => (character.attachedPropIds ?? []).includes(asset.id));
  const linkableCharacters = characterAssets.filter((character) => !linkedCharacters.some((linked) => linked.id === character.id));
  const acting = asset.actingProfile ?? {};
  const updateActing = (patch: Partial<AssetActingProfile>) => update({ actingProfile: { ...acting, ...patch } });
  const perfKeys = ["perf0", "perf1", "perf2", "perf3", "perf4", "perf5"] as const;
  const perfTipKeys = ["perf0Tip", "perf1Tip", "perf2Tip", "perf3Tip", "perf4Tip", "perf5Tip"] as const;

  const uploadReference = async (file?: File) => {
    if (!file) return;
    if (asset.kind === "audio-reference") {
      setAudioBusy(true);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        update({ referencePaths: [dataUrl] });
        setNotice(t.audioUploaded);
      } catch { setNotice(t.uploadFailed); } finally { setAudioBusy(false); }
      return;
    }
    setImageBusy(true);
    try {
      const dataUrl = await compressImage(file);
      update({ referencePaths: [...(asset.referencePaths ?? []), dataUrl] });
      setNotice(t.imageUploaded);
    } catch { setNotice(t.uploadFailed); } finally { setImageBusy(false); }
  };
  const removeReference = (index: number) => update({ referencePaths: (asset.referencePaths ?? []).filter((_, i) => i !== index) });
  const attachProp = (id: string) => {
    if (attachedPropIds.includes(id)) return;
    update({ attachedPropIds: [...attachedPropIds, id] });
    setPropPickerOpen(false);
  };
  const detachProp = (id: string) => update({ attachedPropIds: attachedPropIds.filter((propId) => propId !== id) });
  const linkCharacter = (characterId: string) => {
    if (!characterId) return;
    dispatch({ type: "SET_PROP_CHARACTER_LINK", propId: asset.id, characterId, linked: true });
  };
  const unlinkCharacter = (characterId: string) => {
    dispatch({ type: "SET_PROP_CHARACTER_LINK", propId: asset.id, characterId, linked: false });
    if (asset.propHolderCharacterId === characterId) update({ propHolderCharacterId: undefined });
  };

  /** 角色编辑中添加道具：上传后创建独立道具资产，避免混入角色身份参考图。 */
  const uploadPropImage = async (file?: File) => {
    if (!file) return;
    setPropImageBusy(true);
    try {
      const dataUrl = await compressImage(file);
      const id = crypto.randomUUID();
      dispatch({
        type: "ADD_ASSET",
        id,
        kind: "prop",
        name: `${asset.name || t.assetKindCharacter} ${t.assetKindProp}`,
        referencePaths: [dataUrl],
        propHolderCharacterId: asset.id,
      });
      update({ attachedPropIds: [...attachedPropIds, id] });
      setPropPickerOpen(false);
      setPropPickerMode("choices");
      setNotice(t.propImageAdded);
    } catch { setNotice(t.uploadFailed); } finally { setPropImageBusy(false); }
  };

  const replaceVoiceFromCanvas = (source: string) => {
    const selected = canvasAudioSources.find((item) => item.source === source);
    if (!selected) return;
    update({ voiceClip: selected.source, voiceAssetId: undefined, voiceAssetName: selected.label || undefined });
    setNotice(t.voiceCanvasReplaced.replace("{name}", selected.label));
  };

  // ── 素材库选图：参考图与新建道具均可直接从 LenTalk 素材库挑图 ──────────
  const libraryAssets = useAssetLibraryStore((state) => state.assets);
  const hydrateLibrary = useAssetLibraryStore((state) => state.hydrate);
  useEffect(() => {
    if (libraryPicker) void hydrateLibrary();
  }, [libraryPicker, hydrateLibrary]);
  const libraryImages = useMemo(() => {
    const existing = new Set(asset.referencePaths ?? []);
    return libraryAssets
      .filter((item) => item.mediaType === "image" && !isCinematicMirrorAsset(item) && !existing.has(item.sourcePath))
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [asset.referencePaths, libraryAssets]);

  /** 从素材库选一张图追加为该资产的参考图（直接引用素材库路径，不转 dataURL） */
  const pickLibraryReference = (item: LibraryAsset) => {
    update({ referencePaths: [...(asset.referencePaths ?? []), item.sourcePath] });
    setNotice(t.libraryImageAdded);
    setLibraryPicker(null);
  };

  /** 从素材库选一段音频作为角色声音音色（同样直接引用素材库路径，不转 dataURL） */
  const pickLibraryVoice = (item: LibraryAsset) => {
    update({ voiceClip: item.sourcePath, voiceAssetId: undefined, voiceAssetName: item.name || undefined });
    setNotice(t.voiceLibraryAdded.replace("{name}", item.name || t.voiceClip));
    setLibraryPicker(null);
  };

  const pickLibraryAudio = (item: LibraryAsset) => {
    update({ referencePaths: [item.sourcePath] });
    setNotice(t.voiceLibraryAdded.replace("{name}", item.name || t.assetKindAudioRef));
    setLibraryPicker(null);
  };

  const cinematicAudioAssets = useMemo(
    () => (project.assets ?? []).filter((item) => item.kind === "audio-reference" && Boolean(item.referencePaths?.[0]?.trim())),
    [project.assets],
  );

  const pickCinematicVoice = (item: Asset) => {
    const source = item.referencePaths?.[0]?.trim();
    if (!source) return;
    update({ voiceClip: source, voiceAssetId: item.id, voiceAssetName: item.name || undefined });
    setNotice(t.voiceLibraryAdded.replace("{name}", item.name || t.assetKindAudioRef));
    setLibraryPicker(null);
  };

  /** 素材库音频：排除电影资产镜像条目（那些由工程自动同步，手工选择会绕成环）。 */
  const libraryAudio = useMemo(() => pickableAudioAssets(libraryAssets), [libraryAssets]);

  /** 从素材库图片创建独立道具资产并挂到当前角色（与 uploadPropImage 同构，但不转 dataURL） */
  const createPropFromLibraryImage = (item: LibraryAsset) => {
    const id = crypto.randomUUID();
    dispatch({
      type: "ADD_ASSET",
      id,
      kind: "prop",
      name: item.name || `${asset.name || t.assetKindCharacter} ${t.assetKindProp}`,
      referencePaths: [item.sourcePath],
      propHolderCharacterId: asset.id,
    });
    update({ attachedPropIds: [...attachedPropIds, id] });
    setPropPickerOpen(false);
    setPropPickerMode("choices");
    setLibraryPicker(null);
    setNotice(t.propImageAdded);
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
    const hasVoiceReference = asset.kind === "character" && Boolean(asset.voiceClip?.trim());
    if (!(asset.referencePaths ?? []).length && !hasVoiceReference) { setNotice(t.aiFillNeedsReference); return; }
    setAiBusy(true);
    setAiFillError("");
    setNotice(t.aiFillStarted);
    try {
      const patch = await fillAssetDetails(asset, locale);
      // 名称是用户在左侧手工维护的资产标识。即使旧版模型响应里仍带 name，
      // 也绝不允许「AI 填写详细」覆盖它。
      const { name: _ignoredName, ...detailPatch } = patch;
      update({
        ...detailPatch,
        descriptionZh: appendReferenceMatchLine(detailPatch.descriptionZh),
      });
      setNotice(t.aiFillDone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyError(error);
      const friendly = classified.kind === "gateway-timeout"
        ? t.aiGatewayTimeout
        : classified.kind === "timeout" || classified.kind === "network"
          ? t.aiRequestInterrupted
          : message;
      setNotice(`${t.aiFillFailed}${friendly}`);
      // 保留完整诊断信息在卡片内，避免 toast 一闪而过导致「点了没反应 / 没接通」无从排查
      const settings = loadAISettings();
      const host = (() => { try { return new URL(settings.baseUrl).host; } catch { return settings.baseUrl || "—"; } })();
      setAiFillError([`${t.aiFillFailed}${friendly}`, `模型：${settings.model || "—"}`, `接口：${host}`, `错误类型：${classified.kind}`, `原始信息：${message}`].join("\n"));
    } finally {
      setAiBusy(false);
    }
  };

  const copyFillError = async () => {
    try {
      await navigator.clipboard.writeText(aiFillError);
      setNotice(t.aiErrorCopied);
    } catch {
      setNotice(t.aiFillFailed + aiFillError);
    }
  };

  /** 选择 AI 填写所用模型：只改「用哪个 Chat 模型」，地址/Key 仍取 LenTalk 平台配置 */
  const pickFillModel = (option: LenTalkChatModelOption) => {
    const previous = loadAISettings();
    const saved = saveAISettings({
      ...resolveLenTalkChatModel(option.providerId, option.model),
      reasoningEffort: previous.reasoningEffort,
    });
    setFillModelKey(`${option.providerId}:${option.model}`);
    setFillModelOpen(false);
    setFillModelFilter("");
    setFillModelTick((value) => value + 1);
    setNotice(t.modelSwitched.replace("{model}", saved.model || option.model));
  };

  const lockLevels: [LockLevel, keyof Copy][] = [["none", "lockNone"], ["soft", "lockSoft"], ["strict", "lockStrict"]];

  /**
   * 素材库选择弹窗的条目：ref / prop 用图片素材，audio 用音频素材，
   * voice 同时列出「资产库音频」与「素材库音频」两组。回调在此绑定，弹窗保持无状态。
   */
  const pickerItems: PickerItem[] = libraryPicker === "voice"
    ? [
        ...cinematicAudioAssets.map((item) => ({
          key: `asset-${item.id}`,
          name: item.name || t.assetKindAudioRef,
          isAudio: true,
          group: t.assetKindAudioRef,
          onPick: () => pickCinematicVoice(item),
        })),
        ...libraryAudio.map((item) => ({
          key: `library-${item.id}`,
          name: item.name,
          isAudio: true,
          group: t.assetLibraryShort,
          onPick: () => pickLibraryVoice(item),
        })),
      ]
    : libraryPicker === "audio"
      ? libraryAudio.map((item) => ({ key: item.id, name: item.name, isAudio: true, onPick: () => pickLibraryAudio(item) }))
      : libraryImages.map((item) => ({
          key: item.id,
          name: item.name,
          thumb: resolveImageDisplayUrl(item.previewImageUrl || item.sourcePath),
          onPick: () => (libraryPicker === "prop" ? createPropFromLibraryImage(item) : pickLibraryReference(item)),
        }));
  const pickerEmptyHint = libraryPicker === "voice" || libraryPicker === "audio" ? t.voiceLibraryEmpty : t.libraryPickerEmpty;
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
          {asset.kind === "audio-reference" ? <div className="asset-ref-box">
            <div className="asset-ref-head">
              <span className="asset-ref-head-title">{t.assetKindAudioRef}<b>{refCount}</b></span>
              <div className="asset-ref-head-actions">
                <label className="asset-ref-btn" title={t.voiceUploadHint}>
                  {audioBusy ? <span className="spin-dot" /> : <AudioLines size={14} />}
                  <input className="hidden" type="file" accept="audio/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
                </label>
                <button type="button" className="asset-ref-btn" title={t.assetPickFromLibrary} onClick={() => setLibraryPicker("audio")}>
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>
            <div className="asset-refs audio-refs">
              {(asset.referencePaths ?? []).map((src, index) => <span className="asset-ref voice-clip" key={index}>
                <audio controls src={resolveImageDisplayUrl(src)} preload="none" />
                <button title={t.deleteAsset} onClick={() => removeReference(index)}><X size={10} /></button>
              </span>)}
              {refCount === 0 && <span className="asset-ref-empty">{t.assetRefEmpty}</span>}
            </div>
          </div> : asset.kind === "character" ? <div className="asset-media-split">
            <div className="asset-ref-box">
              <div className="asset-ref-head">
                <span className="asset-ref-head-title">{t.referenceImage}<b>{refCount}</b></span>
                <div className="asset-ref-head-actions">
                  <label className="asset-ref-btn" title={t.uploadCharacterImages}>
                    {imageBusy ? <span className="spin-dot" /> : <ImagePlus size={14} />}
                    <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
                  </label>
                  <button type="button" className="asset-ref-btn" title={t.assetPickFromLibrary} onClick={() => setLibraryPicker("ref")}>
                    <FolderOpen size={14} />
                  </button>
                </div>
              </div>
              <div className="asset-refs">
                {(asset.referencePaths ?? []).map((src, index) => <span className="asset-ref" key={index}><img src={resolveImageDisplayUrl(src)} alt={asset.name} /><button title={t.deleteAsset} onClick={() => removeReference(index)}><X size={10} /></button></span>)}
                {refCount === 0 && <span className="asset-ref-empty">{t.assetRefEmpty}</span>}
              </div>
            </div>
            <div className="asset-prop-panel">
              {attachedProps.length > 0 && <div className="asset-prop-linked-list">
                {attachedProps.map((prop) => <span className="asset-ref" key={prop.id} title={prop.name}>
                  {prop.referencePaths?.[0] ? <img src={resolveImageDisplayUrl(prop.referencePaths[0])} alt={prop.name} /> : <span className="asset-prop-fallback">{prop.name.slice(0, 1)}</span>}
                  <button title={t.detachProp} onClick={() => detachProp(prop.id)}><X size={10} /></button>
                </span>)}
              </div>}
              <button type="button" className="asset-prop-add" onClick={() => { setPropPickerOpen((open) => !open); setPropPickerMode("choices"); }}>
                <Plus size={18} /> <span>{t.addProp}</span>
              </button>
              {propPickerOpen && <div className="asset-prop-picker">
                {propPickerMode === "choices" && <>
                  <button type="button" onClick={() => setPropPickerMode("library")}>{t.attachPropFromLibrary}</button>
                  <button type="button" onClick={() => setPropPickerMode("create")}>{t.createNewProp}</button>
                </>}
                {propPickerMode === "library" && <>
                  <button type="button" className="asset-prop-picker-back" onClick={() => setPropPickerMode("choices")}>{t.cancel}</button>
                  {attachableProps.length === 0 ? <span className="hint-text">{t.noPropsToAttach}</span> : <div className="asset-prop-picker-grid">
                    {attachableProps.map((prop) => <button type="button" key={prop.id} onClick={() => attachProp(prop.id)}>
                      {prop.referencePaths?.[0] ? <img src={resolveImageDisplayUrl(prop.referencePaths[0])} alt={prop.name} /> : <span>{prop.name.slice(0, 1)}</span>}
                      <b>{prop.name}</b>
                    </button>)}
                  </div>}
                </>}
                {propPickerMode === "create" && <>
                  <button type="button" className="asset-prop-picker-back" onClick={() => setPropPickerMode("choices")}>{t.cancel}</button>
                  <label className="asset-prop-upload">
                    {propImageBusy ? <span className="spin-dot" /> : <ImagePlus size={16} />}
                    <span>{t.uploadImage}</span>
                    <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadPropImage(event.target.files?.[0])} />
                  </label>
                  <button type="button" onClick={() => setLibraryPicker("prop")}>{t.propFromLibraryCreate}</button>
                </>}
              </div>}
            </div>
          </div> : <div className="asset-ref-box">
            <div className="asset-ref-head">
              <span className="asset-ref-head-title">{t.referenceImage}<b>{refCount}</b></span>
            </div>
            {/* 单图资产（场景 / 道具）：缩略图收成正方框，右侧竖排两个带文字的大按钮。
                原先两个 26px 图标按钮挤在标题行右侧，点击目标过小。 */}
            <div className="asset-ref-row">
              <div className="asset-refs asset-refs-square">
                {(asset.referencePaths ?? []).map((src, index) => <span className="asset-ref" key={index}><img src={resolveImageDisplayUrl(src)} alt={asset.name} /><button title={t.deleteAsset} onClick={() => removeReference(index)}><X size={10} /></button></span>)}
                {refCount === 0 && <span className="asset-ref-empty">{t.assetRefEmpty}</span>}
              </div>
              <div className="asset-ref-action-col">
                <label className="asset-ref-action" title={t.uploadImage}>
                  {imageBusy ? <span className="spin-dot" /> : <ImagePlus size={15} />}
                  <span>{t.uploadImage}</span>
                  <input className="hidden" type="file" accept="image/*" onChange={(event) => void uploadReference(event.target.files?.[0])} />
                </label>
                <button type="button" className="asset-ref-action" title={t.assetPickFromLibrary} onClick={() => setLibraryPicker("ref")}>
                  <FolderOpen size={15} />
                  <span>{t.assetPickFromLibrary}</span>
                </button>
              </div>
            </div>
          </div>}
          <label className="field-label">{t.assetName}<input className="modal-input" value={asset.name} placeholder={t.assetNamePlaceholder} onChange={(event) => update({ name: event.target.value })} /></label>
          <label className="field-label">{t.assetNotes}<textarea className="modal-textarea asset-notes-input" value={locale === "zh" ? (asset.notesZh ?? "") : (asset.notes ?? "")} placeholder={locale === "zh" ? t.assetNotesZhPlaceholder : t.assetNotesPlaceholder} onChange={(event) => update(locale === "zh" ? { notesZh: event.target.value } : { notes: event.target.value })} /></label>
          <label className="field-label">{t.assetReferenceTag}<input className="modal-input" value={`@${asset.referenceTag ?? asset.name}`} readOnly /></label>
          {asset.kind === "prop" && <div className="asset-prop-details">
            <div className="asset-section-title">{t.propDetails}</div>
            <div className="field-label">{t.linkedCharacters}
              <div className="asset-prop-character-links">
                {linkedCharacters.map((character) => <span key={character.id} className="stage-chip order-chip"><span className="avatar small">{character.name.slice(0, 1)}</span><b>{character.name}</b><button title={t.detachProp} onClick={() => unlinkCharacter(character.id)}><X size={11} /></button></span>)}
                {linkableCharacters.length > 0 && <span className="select-wrap small asset-prop-character-select"><select value="" aria-label={t.linkedCharacters} onChange={(event) => linkCharacter(event.target.value)}><option value="">{t.linkCharacter}</option>{linkableCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></span>}
              </div>
            </div>
            <div className="fields-grid two">
              <label className="field-label">{t.propHolder}<span className="select-wrap"><select value={asset.propHolderCharacterId ?? ""} onChange={(event) => { const id = event.target.value || undefined; update({ propHolderCharacterId: id }); if (id) linkCharacter(id); }}><option value="">{t.none}</option>{characterAssets.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></span></label>
              <label className="field-label">{t.propPosition}<input className="modal-input" value={locale === "zh" ? (asset.propPositionZh ?? "") : (asset.propPosition ?? "")} placeholder={t.propPositionPlaceholder} onChange={(event) => update(locale === "zh" ? { propPositionZh: event.target.value } : { propPosition: event.target.value })} /></label>
            </div>
            <label className="field-label">{t.propUsage}<textarea className="modal-textarea asset-notes-input" value={locale === "zh" ? (asset.propUsageZh ?? "") : (asset.propUsage ?? "")} placeholder={t.propUsagePlaceholder} onChange={(event) => update(locale === "zh" ? { propUsageZh: event.target.value } : { propUsage: event.target.value })} /></label>
            <label className="field-label">{t.propDefaultState}<input className="modal-input" value={locale === "zh" ? (asset.propDefaultStateZh ?? "") : (asset.propDefaultState ?? "")} placeholder={t.propDefaultStatePlaceholder} onChange={(event) => update(locale === "zh" ? { propDefaultStateZh: event.target.value } : { propDefaultState: event.target.value })} /></label>
            <span className="hint-text">{t.propDefaultsHint}</span>
          </div>}
          {/* 角色声音参考会在最终提示词的活动引用中按资产名 + @audioN 输出。 */}
          {asset.kind === "character" && <div className="field-label">{t.voiceClip}
            {asset.voiceClip ? (
              <div className="voice-clip">
                <audio controls src={resolveImageDisplayUrl(asset.voiceClip)} preload="none" />
                <button className="icon-button" title={t.deleteAsset} onClick={() => update({ voiceClip: undefined, voiceAssetId: undefined, voiceAssetName: undefined })}><X size={13} /></button>
              </div>
            ) : null}
            <button
              type="button"
              className="outline-button voice-library-trigger"
              title={t.voiceFromLibrary}
              onClick={() => setLibraryPicker("voice")}
            >
              <AudioLines size={13} /> {t.voiceFromLibrary}
            </button>
            {canvasAudioSources.length > 0 ? <div className="voice-canvas-picker">
              <span>{t.voiceCanvasSource}</span>
              <select value="" aria-label={t.voiceCanvasChoose} onChange={(event) => replaceVoiceFromCanvas(event.target.value)}>
                <option value="">{t.voiceCanvasChoose}</option>
                {canvasAudioSources.map((item) => <option key={item.source} value={item.source}>{item.label}</option>)}
              </select>
            </div> : <div className="voice-canvas-empty">{t.voiceCanvasEmpty}</div>}
          </div>}
          <div className="field-label">{t.stressTest}<div className="lock-options">
            {(["untested", "passed", "failed"] as const).map((status) => <button key={status} className={`lock-option ${asset.stressTestStatus === status ? "active" : ""}`} onClick={() => update({ stressTestStatus: status })}>{t[status === "untested" ? "stressUntested" : status === "passed" ? "stressPassed" : "stressFailed"]}</button>)}
          </div></div>
          {isVehicleInterior && <button className="outline-button" onClick={() => update({ kind: "prop" })}>{t.moveVehicleToProp}</button>}
        </div>

        {/* 右列：描述 → AI 填写结果 */}
        <div className="asset-modal-right">
          <div className="asset-ai-fill-row">
            {/* 左：选择用于 AI 填写的模型（来自 LenTalk 已配置的 Chat 模型） */}
            <div className="model-picker">
              <button
                type="button"
                className="outline-button model-picker-btn"
                onClick={() => { setFillModelOpen((value) => !value); setFillModelTick((value) => value + 1); }}
                title={t.pickModel}
                aria-expanded={fillModelOpen}
              >
                <Cpu size={13} />
                <span className="model-picker-name">{fillModelLabel || t.modelNotSet}</span>
                <ChevronDown size={12} />
              </button>
              {fillModelOpen && <div className="model-picker-panel" onClick={(event) => event.stopPropagation()}>
                {fillModelOptions.length === 0 ? (
                  <div className="model-picker-hint">
                    <strong>{t.noChatModels}</strong>
                    <span>{t.noChatModelsHint}</span>
                  </div>
                ) : (
                  <>
                    <div className="model-picker-meta">{t.modelPickerHint}</div>
                    <input
                      className="modal-input model-picker-filter"
                      value={fillModelFilter}
                      placeholder={t.modelsFilterPlaceholder}
                      spellCheck={false}
                      onChange={(event) => setFillModelFilter(event.target.value)}
                    />
                    <div className="model-picker-list">
                      {filteredFillModels.length === 0 ? <div className="model-picker-hint">{t.modelsEmpty}</div>
                        : filteredFillModels.map((option) => {
                          const key = `${option.providerId}:${option.model}`;
                          const active = key === fillModelKey;
                          return <button key={key} type="button" className={`model-picker-item ${active ? "active" : ""}`} onClick={() => pickFillModel(option)} title={t.pickModel}>
                            <span className="model-picker-item-main">
                              <span className="model-picker-item-model">{option.model}</span>
                              <span className="model-picker-item-provider">{option.providerName}</span>
                            </span>
                            {active && <CheckCircle2 size={12} />}
                          </button>;
                        })}
                    </div>
                    <div className="model-picker-test">
                      <button type="button" className="outline-button" disabled={fillTestBusy} onClick={() => void testFillModel()}>
                        <Zap size={12} /> {fillTestBusy ? t.testingConnection : t.testConnection}
                      </button>
                      {fillTestResult && <span className={`model-picker-test-status ${fillTestResult.ok ? "ok" : "error"}`}>
                        {fillTestResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        {fillTestResult.text}
                      </span>}
                    </div>
                  </>
                )}
              </div>}
            </div>
            {/* 右：AI 填写详情 */}
            <button type="button" className="primary-button asset-ai-fill-button" disabled={aiBusy} aria-busy={aiBusy} onClick={() => void aiFillDetails()}>{aiBusy ? <span className="spin-dot" /> : <Sparkles size={14} />} {aiBusy ? t.aiFillStarted : t.aiFillDetails}</button>
          </div>
          {aiFillError && <div className="asset-ai-fill-error" role="alert">
            <pre className="asset-ai-fill-error-text">{aiFillError}</pre>
            <div className="asset-ai-fill-error-actions">
              <button type="button" className="outline-button" onClick={() => void copyFillError()}>{t.copyAiError}</button>
              <button type="button" className="outline-button" onClick={() => setAiFillError("")}>{t.cancel}</button>
            </div>
          </div>}
          <div className="asset-ai-output-label">{t.assetAiOutput}</div>
          {locale === "zh" ? (
            <label className="field-label">{t.assetDescriptionZh}<textarea className="modal-textarea" value={asset.descriptionZh ?? ""} placeholder={t.assetDescriptionZhPlaceholder} onChange={(event) => update({ descriptionZh: event.target.value })} onBlur={() => update({ descriptionZh: appendReferenceMatchLine(asset.descriptionZh) })} /></label>
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

      {/* 素材库选择弹窗：固定定位挂在编辑弹窗内部，随编辑弹窗一起进入同一个层叠上下文，
          不会被 .asset-modal 的 overflow 裁切（其包含块是带 backdrop-filter 的 .modal-overlay）。 */}
      {libraryPicker && <LibraryPickerModal
        items={pickerItems}
        emptyHint={pickerEmptyHint}
        t={t}
        onClose={() => setLibraryPicker(null)}
      />}
    </div>
  </div>;
}

function assetKindKey(kind: AssetKind): keyof Copy {
  const map: Record<AssetKind, keyof Copy> = { character: "assetKindCharacter", location: "assetKindLocation", prop: "assetKindProp", "style-reference": "assetKindStyleRef", "audio-reference": "assetKindAudioRef" };
  return map[kind];
}
