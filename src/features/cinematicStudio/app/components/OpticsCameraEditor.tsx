/**
 * 镜头检查器 · 光学 / 相机 / 物理锚点（P1.1 / P1.2 / P1.7）
 * 把「光学」与「相机操作员行为」从平铺表单升级为分组编辑，并提供镜头决策树：
 * 按内容类别推荐视场角（仅提示，不强制）。物理锚点按动作类别勾选。
 */
import { useState } from "react";
import type { LensCharacter, PhysicsAnchorKind, ShotV2 } from "../../shared-types";
import { LENS_BANK, PHYSICS_ANCHORS, lensById } from "../../engine";
import { ChevronDown, Sparkles } from "lucide-react";
import type { Locale } from "../i18n";

interface OpticsCameraEditorProps {
  shot: ShotV2;
  locale: Locale;
  onUpdate(updates: Partial<ShotV2>): void;
}

/** 内容类别 → 推荐镜头语言（仅提示，不强制） */
const DECISION_TREE = [
  { key: "face-portrait", lens: "29-short-tele" as LensCharacter },
  { key: "environment-action", lens: "84-wide" as LensCharacter },
  { key: "detail-closeup", lens: "18-tele" as LensCharacter },
  { key: "distant-observation", lens: "8-supertele" as LensCharacter },
] as const;

const DECISION_LABELS: Record<Locale, Record<(typeof DECISION_TREE)[number]["key"], string>> = {
  zh: {
    "face-portrait": "人物特写",
    "environment-action": "环境动作",
    "detail-closeup": "细节特写",
    "distant-observation": "远处观察",
  },
  en: {
    "face-portrait": "Face portrait",
    "environment-action": "Environment action",
    "detail-closeup": "Detail close-up",
    "distant-observation": "Distant observation",
  },
};

const CAMERA_FIELDS: { key: keyof NonNullable<ShotV2["cameraBehavior"]>; zh: string; en: string }[] = [
  { key: "height", zh: "机位高度", en: "Height" },
  { key: "distance", zh: "距离", en: "Distance" },
  { key: "angle", zh: "角度", en: "Angle" },
  { key: "side", zh: "机位边", en: "Side" },
  { key: "subjectSize", zh: "画面大小", en: "Subject size" },
  { key: "screenPlacement", zh: "画面位置", en: "Screen placement" },
  { key: "focusBehavior", zh: "对焦", en: "Focus" },
  { key: "depthOfField", zh: "景深", en: "Depth of field" },
  { key: "handheldQuality", zh: "手持质感", en: "Handheld quality" },
];

const PHYSICS_KINDS: PhysicsAnchorKind[] = ["walk", "run", "weapon", "liquid", "particle"];

const T = {
  zh: {
    title: "光学 · 相机",
    decisionTree: "镜头决策树",
    decisionTreeHint: "按内容类别推荐视场角（仅提示，不强制）",
    lensCharacter: "镜头语言",
    lensCharacterHint: "优先可观测结果，其次才是焦距 / 品牌",
    fov: "视场角",
    recommended: "推荐",
    apply: "应用",
    current: "当前",
    cameraBehavior: "相机行为（物理操作员）",
    handheldHint: "只写物理操作员描述（呼吸 / 微调 / 重量转移），不要 digital jitter / gimbal",
    physics: "物理锚点",
    physicsHint: "按动作类别勾选，编译输出可观测锚点",
  },
  en: {
    title: "Optics · Camera",
    decisionTree: "Lens decision tree",
    decisionTreeHint: "Recommend FOV by content class (hint only, not enforced)",
    lensCharacter: "Lens character",
    lensCharacterHint: "Prefer observable outcome over focal length / brand",
    fov: "FOV",
    recommended: "Recommended",
    apply: "Apply",
    current: "Current",
    cameraBehavior: "Camera behavior (physical operator)",
    handheldHint: "Physical operator behavior only (breath / micro-settling / weight shift), no digital jitter / gimbal",
    physics: "Physics anchors",
    physicsHint: "Check by action kind; compiler renders observable anchors",
  },
} as const;

export default function OpticsCameraEditor({ shot, locale, onUpdate }: OpticsCameraEditorProps) {
  const [recommended, setRecommended] = useState<LensCharacter | null>(null);
  const zh = locale === "zh";
  const L = T[locale];
  const optics = shot.optics ?? {};
  const activeLens = lensById(optics.lensCharacter);
  const behavior = shot.cameraBehavior ?? {};
  const anchors = shot.physicsAnchors ?? [];

  const applyLens = (lens: LensCharacter) => {
    const preset = lensById(lens);
    onUpdate({ optics: { ...optics, lensCharacter: lens, fieldOfViewDegrees: preset?.fov } });
    setRecommended(null);
  };

  const setBehavior = (key: keyof typeof behavior, value: string) => {
    onUpdate({ cameraBehavior: { ...behavior, [key]: value.trim() || undefined } });
  };

  const toggleAnchor = (kind: PhysicsAnchorKind) => {
    const has = anchors.some((a) => a.kind === kind);
    onUpdate({ physicsAnchors: has ? anchors.filter((a) => a.kind !== kind) : [...anchors, { kind }] });
  };

  return <section className="inspector-section optics-camera-editor">
    <h3>{L.title}</h3>

    <div className="lens-decision-tree">
      <span className="sub-label">{L.decisionTree}</span>
      <div className="decision-tree-row">
        {DECISION_TREE.map((item) => {
          const preset = lensById(item.lens);
          const active = recommended === item.lens;
          return <button key={item.key} className={`decision-chip${active ? " active" : ""}`} onClick={() => setRecommended(item.lens)}>
            <b>{DECISION_LABELS[locale][item.key]}</b>
            <small>{preset?.fov}°</small>
          </button>;
        })}
      </div>
      <p className="hint-text">{L.decisionTreeHint}</p>
      {recommended && (() => {
        const preset = lensById(recommended);
        const name = zh ? preset?.zh : preset?.en;
        return <div className="decision-recommend">
          <Sparkles size={13} />
          <span>{L.recommended}: <b>{name}</b> · {preset?.fov}°</span>
          <button className="outline-button" onClick={() => applyLens(recommended)}>{L.apply}</button>
        </div>;
      })()}
    </div>

    <label className="field-label">{L.lensCharacter}<span className="select-wrap">
      <select value={optics.lensCharacter ?? ""} onChange={(event) => {
        const value = event.target.value as LensCharacter | "";
        if (value) applyLens(value);
        else onUpdate({ optics: { ...optics, lensCharacter: undefined, fieldOfViewDegrees: undefined } });
      }}>
        <option value="">—</option>
        {LENS_BANK.map((lens) => <option key={lens.id} value={lens.id}>{zh ? lens.zh : lens.en} · {lens.fov}°</option>)}
      </select>
      <ChevronDown size={14} />
    </span></label>
    <p className="hint-text">{L.lensCharacterHint}</p>
    {activeLens && <div className="lens-outcome">
      <span className="sub-label">{L.current} · {zh ? activeLens.zh : activeLens.en} · {activeLens.fov}°</span>
      {(zh ? activeLens.outcomeZh : activeLens.outcome).slice(0, 3).map((line) => <em key={line}>{line}</em>)}
    </div>}

    <div className="sub-label">{L.cameraBehavior}</div>
    <div className="fields-grid two optics-grid">
      {CAMERA_FIELDS.map((field) => <label className="field-label" key={field.key}>
        {zh ? field.zh : field.en}
        <input className="modal-input" value={behavior[field.key] ?? ""} placeholder={zh ? field.zh : field.en} onChange={(event) => setBehavior(field.key, event.target.value)} />
      </label>)}
    </div>
    {behavior.handheldQuality && <p className="hint-text">{L.handheldHint}</p>}

    <div className="sub-label">{L.physics}</div>
    <div className="physics-anchor-row">
      {PHYSICS_KINDS.map((kind) => {
        const preset = PHYSICS_ANCHORS[kind];
        const active = anchors.some((a) => a.kind === kind);
        return <button key={kind} className={`physics-chip${active ? " active" : ""}`} onClick={() => toggleAnchor(kind)}>
          {zh ? preset.zh : preset.en}
        </button>;
      })}
    </div>
    <p className="hint-text">{L.physicsHint}</p>
  </section>;
}
