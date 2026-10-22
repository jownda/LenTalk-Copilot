/**
 * 镜头检查器 · 光学 / 相机 / 物理锚点（P1.1 / P1.2 / P1.7）
 * 把「光学」与「相机操作员行为」从平铺表单升级为分组编辑，并提供镜头决策树：
 * 按内容类别推荐视场角（仅提示，不强制）。相机行为和物理锚点按镜头执行需要填写。
 */
import { useState } from "react";
import type { LensCharacter, PhysicsAnchorKind, ShotV2 } from "../../shared-types";
import { LENS_BANK, PHYSICS_ANCHORS, lensById } from "../../engine";
import { ChevronDown, Sparkles } from "lucide-react";
import { framingLabels, type Locale } from "../i18n";
import { CAMERA_MOVE_TEMPLATE_GROUPS, CAMERA_MOVE_TEMPLATES } from "../cameraMoveTemplates";

interface OpticsCameraEditorProps {
  shot: ShotV2;
  framing: string;
  locale: Locale;
  onUpdate(updates: Partial<ShotV2>): void;
}

const FRAMING_OPTIONS = [
  "Extreme wide / establishing",
  "Wide",
  "Full shot",
  "Medium full / cowboy",
  "Medium",
  "Medium close-up",
  "Close-up",
  "Big close-up",
  "Extreme close-up",
  "Insert / detail",
  "Two-shot",
  "Tight two-shot",
  "Over-the-shoulder",
  "3/4 medium, behind subject",
  "Extreme close-up, profile",
] as const;
const FRAMING_LENS_DEFAULTS: Record<(typeof FRAMING_OPTIONS)[number], LensCharacter> = {
  "Extreme wide / establishing": "135-immersive",
  Wide: "84-wide",
  "Full shot": "63-moderate-wide",
  "Medium full / cowboy": "47-standard",
  Medium: "47-standard",
  "3/4 medium, behind subject": "47-standard",
  "Medium close-up": "29-short-tele",
  "Close-up": "29-short-tele",
  "Big close-up": "18-tele",
  "Extreme close-up": "18-tele",
  "Insert / detail": "18-tele",
  "Two-shot": "47-standard",
  "Tight two-shot": "12-long-tele",
  "Over-the-shoulder": "29-short-tele",
  "Extreme close-up, profile": "18-tele",
};

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

const LEGACY_CAMERA_FIELDS: { key: keyof NonNullable<ShotV2["cameraBehavior"]>; zh: string; en: string }[] = [
  { key: "height", zh: "高度", en: "height" },
  { key: "distance", zh: "距离", en: "distance" },
  { key: "angle", zh: "角度", en: "angle" },
  { key: "side", zh: "机位边", en: "side" },
  { key: "subjectSize", zh: "画面大小", en: "subject size" },
  { key: "screenPlacement", zh: "画面位置", en: "screen placement" },
  { key: "focusBehavior", zh: "对焦", en: "focus" },
  { key: "depthOfField", zh: "景深", en: "depth of field" },
  { key: "handheldQuality", zh: "手持质感", en: "handheld quality" },
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
    current: "当前",
    cameraBehavior: "相机行为与运镜",
    cameraBehaviorPlaceholder: "描述机位、距离、构图、对焦、运镜触发与结束状态…",
    cameraTemplateHint: "点击模板填入后可继续修改；模板仅作 AI 与人工填写参考，不会自动覆盖相机、光学或镜头运动选择。",
    selectCameraTemplate: "选择运镜模板",
    commonMoves: "常用运镜",
    classicMoves: "经典运镜",
    masterMoves: "大师运镜",
    handheldHint: "手持请写摄影师呼吸、脚步和重心转移，不要 digital jitter / gimbal",
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
    current: "Current",
    cameraBehavior: "Camera behavior & movement",
    cameraBehaviorPlaceholder: "Describe position, framing, focus, movement trigger, and ending state…",
    cameraTemplateHint: "Click a template to fill, then edit it freely. Templates are references for AI and manual planning; they do not overwrite camera, optics, or movement selections.",
    selectCameraTemplate: "Choose a movement template",
    commonMoves: "Common moves",
    classicMoves: "Classic moves",
    masterMoves: "Master moves",
    handheldHint: "For handheld, describe operator breath, footsteps, and weight shift; no digital jitter / gimbal",
    physics: "Physics anchors",
    physicsHint: "Check by action kind; compiler renders observable anchors",
  },
} as const;

export default function OpticsCameraEditor({ shot, framing, locale, onUpdate }: OpticsCameraEditorProps) {
  const [recommended, setRecommended] = useState<LensCharacter | null>(null);
  const [cameraTemplateOpen, setCameraTemplateOpen] = useState(false);
  const zh = locale === "zh";
  const L = T[locale];
  const optics = shot.optics ?? {};
  const activeLens = lensById(optics.lensCharacter);
  const behavior = shot.cameraBehavior ?? {};
  const layout = shot.layout ?? {};
  const anchors = shot.physicsAnchors ?? [];
  const framingOptions = FRAMING_OPTIONS.includes(framing as (typeof FRAMING_OPTIONS)[number])
    ? FRAMING_OPTIONS
    : [framing, ...FRAMING_OPTIONS];

  const applyLens = (lens: LensCharacter) => {
    const preset = lensById(lens);
    onUpdate({ optics: { ...optics, lensCharacter: lens, fieldOfViewDegrees: preset?.fov } });
    setRecommended(null);
  };

  const legacyBehaviorText = LEGACY_CAMERA_FIELDS
    .map((field) => {
      const value = behavior[field.key]?.trim();
      return value ? `${zh ? field.zh : field.en}: ${value}` : "";
    })
    .filter(Boolean)
    .join(zh ? "；" : "; ");
  const behaviorText = behavior.description ?? legacyBehaviorText;
  const selectedCameraTemplate = CAMERA_MOVE_TEMPLATE_GROUPS
    .flatMap((group) => CAMERA_MOVE_TEMPLATES[locale][group])
    .find((template) => template.description === behaviorText);

  const setBehaviorText = (value: string) => {
    onUpdate({ cameraBehavior: { ...behavior, description: value || undefined } });
  };

  const toggleAnchor = (kind: PhysicsAnchorKind) => {
    const has = anchors.some((a) => a.kind === kind);
    onUpdate({ physicsAnchors: has ? anchors.filter((a) => a.kind !== kind) : [...anchors, { kind }] });
  };

  const setFraming = (value: string) => {
    const nextFraming = FRAMING_OPTIONS.includes(value as (typeof FRAMING_OPTIONS)[number])
      ? value as (typeof FRAMING_OPTIONS)[number]
      : "Medium";
    onUpdate({ framing: value });
    // Framing and optics are related controls, never a forced pair. Selecting
    // a framing only exposes the usual lens character as a recommendation.
    setRecommended(FRAMING_LENS_DEFAULTS[nextFraming]);
  };

  return <section className="inspector-section optics-camera-editor">
    <h3>{L.title}</h3>

    <div className="fields-grid two optics-pair-grid">
      <label className="field-label">{zh ? "景别" : "Framing"}<span className="select-wrap">
        <select value={framing} onChange={(event) => setFraming(event.target.value)}>
          {framingOptions.map((value) => <option key={value} value={value}>{framingLabels[locale][value] ?? value}</option>)}
        </select>
        <ChevronDown size={14} />
      </span></label>
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
    </div>
    <p className="hint-text">{zh ? "景别决定主体大小，镜头语言决定透视结果；修改景别只显示推荐镜头语言，不会覆盖当前选择。点击“应用”后才会改变镜头语言。" : "Framing controls subject size; lens character controls perspective. Changing framing only suggests a lens; it never overwrites the current choice unless you click Apply."}</p>

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
        </div>;
      })()}
    </div>

    <p className="hint-text">{L.lensCharacterHint}</p>
    {activeLens && <div className="lens-outcome">
      <span className="sub-label">{L.current} · {zh ? activeLens.zh : activeLens.en} · {activeLens.fov}°</span>
      {(zh ? activeLens.outcomeZh : activeLens.outcome).slice(0, 3).map((line) => <em key={line}>{line}</em>)}
    </div>}

    <div className="sub-label">{L.cameraBehavior}</div>
    <label className="field-label camera-behavior-field">
      <textarea
        className="modal-textarea"
        rows={4}
        value={behaviorText}
        placeholder={L.cameraBehaviorPlaceholder}
        onChange={(event) => setBehaviorText(event.target.value)}
      />
    </label>
    <p className="hint-text">{L.cameraTemplateHint}</p>
    <div className="camera-template-picker">
      <button
        type="button"
        className="outline-button camera-template-button"
        aria-expanded={cameraTemplateOpen}
        onClick={() => setCameraTemplateOpen((open) => !open)}
      >
        {selectedCameraTemplate?.label ?? L.selectCameraTemplate}
        <ChevronDown size={13} className={cameraTemplateOpen ? "open" : ""} />
      </button>
      {cameraTemplateOpen && (
        <div className="camera-template-menu" role="listbox" aria-label={L.selectCameraTemplate}>
          {CAMERA_MOVE_TEMPLATE_GROUPS.map((group) => (
            <div className="camera-template-menu-group" key={group}>
              <span>{group === "common" ? L.commonMoves : group === "classic" ? L.classicMoves : L.masterMoves}</span>
              <div>
                {CAMERA_MOVE_TEMPLATES[locale][group].map((template) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={template.description === behaviorText}
                    className={template.description === behaviorText ? "active" : ""}
                    key={template.id}
                    title={template.description}
                    onClick={() => {
                      setBehaviorText(template.description);
                      setCameraTemplateOpen(false);
                    }}
                  >
                    {template.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    {/(?:handheld|手持)/i.test(behaviorText) && <p className="hint-text">{L.handheldHint}</p>}

    <label className="check-chip-axis">
      <input
        type="checkbox"
        checked={layout.intentionalAxisBreak ?? false}
        onChange={(event) => onUpdate({ layout: { ...layout, intentionalAxisBreak: event.target.checked } })}
      />
      {zh ? "故意越轴" : "Intentional axis break"}
    </label>
    {layout.intentionalAxisBreak && <input
      className="modal-input axis-note-input"
      value={layout.axisNote ?? ""}
      placeholder={zh ? "说明摄影机为何跨过180°轴线…" : "Why the camera crosses the 180-degree line…"}
      onChange={(event) => onUpdate({ layout: { ...layout, axisNote: event.target.value || undefined } })}
    />}
    <p className="hint-text">{zh ? "仅在摄影机有意跨过180°轴线时勾选；该指令会写入最终提示词的 CAMERA 段。" : "Check only when the camera intentionally crosses the 180-degree line; this is compiled into CAMERA."}</p>

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
