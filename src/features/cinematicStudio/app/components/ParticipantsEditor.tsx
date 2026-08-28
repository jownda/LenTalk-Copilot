/**
 * 镜头参与角色编辑器（P0.2）
 * 镜头检查器新增「参与角色」区域：+ 从资产库选人、可删除、拖拽排序（更新 layout.characterOrder，
 * 不影响 participants 添加顺序 → 身份编号稳定）、每个参与者设置职责/前中后景/入画/朝向/视线、
 * 「使用场景站位」开关、故意越轴标记、镜头级锚点覆写。
 */
import { useState } from "react";
import type { ProjectV2, SceneV2, ShotParticipant, ShotV2 } from "../../shared-types";
import { resolveCharacterOrder } from "../../engine";
import { ChevronDown, ChevronLeft, ChevronRight, GripVertical, X } from "lucide-react";
import type { CopyZh } from "../i18n";

interface ParticipantsEditorProps {
  project: ProjectV2;
  scene: SceneV2;
  shot: ShotV2;
  t: CopyZh;
  onUpdate(patch: Partial<ShotV2>): void;
}

const ROLE_KEYS = [["primary", "rolePrimary"], ["supporting", "roleSupporting"], ["target", "roleTarget"], ["background", "roleBackground"]] as const;
const POSITION_KEYS = [["foreground-left", "positionForegroundLeft"], ["center-left", "positionCenterLeft"], ["center", "positionCenter"], ["center-right", "positionCenterRight"], ["background-right", "positionBackgroundRight"]] as const;
const ENTRANCE_KEYS = [["already-in-frame", "entranceAlready"], ["enters-left", "entranceLeft"], ["enters-right", "entranceRight"]] as const;
const FACING_KEYS = [["toward-camera", "facingCamera"], ["profile-left", "facingProfileLeft"], ["profile-right", "facingProfileRight"], ["toward-center", "facingCenter"]] as const;

export default function ParticipantsEditor({ project, scene, shot, t, onUpdate }: ParticipantsEditorProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const participants = shot.participants ?? [];
  const layout = shot.layout ?? {};
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const nameOf = (id: string) => (project.assets ?? []).find((a) => a.id === id)?.name ?? id;
  const order = resolveCharacterOrder(scene, shot);
  const candidatePool = characterAssets.filter((asset) => !participants.some((p) => p.characterId === asset.id));

  /** 以当前有效顺序为基准写自定义 order（拖拽/添加时自动从「继承」进入「自定义」） */
  const commitOrder = (nextOrder: string[]) => onUpdate({ layout: { ...layout, useSceneStaging: false, characterOrder: nextOrder } });

  const addParticipant = (characterId: string) => {
    if (participants.some((p) => p.characterId === characterId)) return;
    const created: ShotParticipant = { characterId, role: "supporting", entrance: "already-in-frame" };
    onUpdate({ participants: [...participants, created], layout: { ...layout, characterOrder: [...order, characterId] } });
  };
  const removeParticipant = (characterId: string) => {
    onUpdate({
      participants: participants.filter((p) => p.characterId !== characterId),
      layout: { ...layout, characterOrder: order.filter((id) => id !== characterId) },
      beats: (shot.beats ?? []).map((beat) => ({
        ...beat,
        ...(beat.actorId === characterId ? { actorId: undefined, dialogue: undefined } : {}),
        ...(beat.targetCharacterId === characterId ? { targetCharacterId: undefined } : {}),
        forbiddenTargets: (beat.forbiddenTargets ?? []).filter((id) => id !== characterId),
      })),
    });
    if (expanded === characterId) setExpanded(null);
  };
  const updateParticipant = (characterId: string, patch: Partial<ShotParticipant>) => {
    onUpdate({ participants: participants.map((p) => p.characterId === characterId ? { ...p, ...patch } : p) });
  };
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commitOrder(next);
  };

  return <div className="participants-editor">
    <div className="participants-head">
      <span className="chip-label">{t.participants} <em>{participants.length}</em></span>
      <div className="participants-actions">
        <span className="switch-label">{t.useSceneStaging}<button className={`switch ${layout.useSceneStaging !== false ? "on" : ""}`} onClick={() => onUpdate({ layout: { ...layout, useSceneStaging: layout.useSceneStaging !== false ? false : true } })}><i /></button></span>
        <span className="select-wrap small">
          <select value="" onChange={(event) => { if (event.target.value) { addParticipant(event.target.value); event.target.value = ""; } }}>
            <option value="">+ {t.addParticipant}</option>
            {candidatePool.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select><ChevronDown size={13} />
        </span>
      </div>
    </div>

    {participants.length === 0 ? <p className="hint-text">{t.emptyParticipantsHint}</p> : <div className="stage-row participants-row">
      {order.map((id, index) => {
        const participant = participants.find((p) => p.characterId === id);
        if (!participant) return null;
        return <span className={`stage-chip participant-chip ${expanded === id ? "active" : ""}`} key={id} draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragIndex(index); }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) reorder(dragIndex, index); setDragIndex(null); }}>
          <GripVertical size={11} className="grip" />
          <span className="avatar small">{nameOf(id).slice(0, 1)}</span>
          <b onClick={() => setExpanded(expanded === id ? null : id)}>{nameOf(id)}</b>
          <small>{t[ROLE_KEYS.find(([v]) => v === participant.role)?.[1] ?? "roleSupporting"]}</small>
          <button title={t.moveLeft} disabled={index === 0} onClick={() => reorder(index, index - 1)}><ChevronLeft size={11} /></button>
          <button title={t.moveRight} disabled={index === order.length - 1} onClick={() => reorder(index, index + 1)}><ChevronRight size={11} /></button>
          <button title={t.deleteParticipant} onClick={() => removeParticipant(id)}><X size={11} /></button>
        </span>;
      })}
      {order.length < participants.length && participants.filter((p) => !order.includes(p.characterId)).map((p) => (
        <span className="stage-chip participant-chip off-order" key={p.characterId}>
          <span className="avatar small">{nameOf(p.characterId).slice(0, 1)}</span>
          <b onClick={() => setExpanded(expanded === p.characterId ? null : p.characterId)}>{nameOf(p.characterId)}</b>
          <button title={t.deleteParticipant} onClick={() => removeParticipant(p.characterId)}><X size={11} /></button>
        </span>
      ))}
    </div>}

    {expanded && participants.some((p) => p.characterId === expanded) && (() => {
      const participant = participants.find((p) => p.characterId === expanded)!;
      return <div className="participant-detail">
        <div className="fields-grid two">
          <LabeledMini label={t.role} value={participant.role} options={ROLE_KEYS.map(([v, k]) => [v, t[k]] as [string, string])} onChange={(value) => updateParticipant(expanded, { role: value as ShotParticipant["role"] })} />
          <LabeledMini label={t.position} value={participant.position ?? ""} options={[["", t.none], ...POSITION_KEYS.map(([v, k]) => [v, t[k]] as [string, string])]} onChange={(value) => updateParticipant(expanded, { position: value || undefined })} />
          <LabeledMini label={t.entrance} value={participant.entrance ?? ""} options={[["", t.none], ...ENTRANCE_KEYS.map(([v, k]) => [v, t[k]] as [string, string])]} onChange={(value) => updateParticipant(expanded, { entrance: (value || undefined) as ShotParticipant["entrance"] })} />
          <LabeledMini label={t.facing} value={participant.facing ?? ""} options={[["", t.none], ...FACING_KEYS.map(([v, k]) => [v, t[k]] as [string, string])]} onChange={(value) => updateParticipant(expanded, { facing: value || undefined })} />
        </div>
        <label className="field-label">{t.eyeline}<input className="modal-input" value={participant.eyeline ?? ""} placeholder={t.none} onChange={(event) => updateParticipant(expanded, { eyeline: event.target.value || undefined })} /></label>
        <div className="fields-grid two">
          <label className="field-label">{t.characterShotActing}<textarea className="modal-textarea" value={participant.acting ?? ""} placeholder={t.characterShotActingPlaceholder} onChange={(event) => updateParticipant(expanded, { acting: event.target.value || undefined })} /></label>
          <label className="field-label">{t.characterShotEyeLife}<textarea className="modal-textarea" value={participant.eyeLife ?? ""} placeholder={t.shotEyeLifePlaceholder} onChange={(event) => updateParticipant(expanded, { eyeLife: event.target.value || undefined })} /></label>
        </div>
      </div>;
    })()}

    <div className="participant-layout-extras">
      <label className="check-chip-axis"><input type="checkbox" checked={layout.intentionalAxisBreak ?? false} onChange={(event) => onUpdate({ layout: { ...layout, intentionalAxisBreak: event.target.checked } })} /> {t.intentionalAxisBreak}</label>
      {layout.intentionalAxisBreak && <input className="modal-input" value={layout.axisNote ?? ""} placeholder={t.axisNotePlaceholder} onChange={(event) => onUpdate({ layout: { ...layout, axisNote: event.target.value || undefined } })} />}
      <label className="field-label">{t.spatialAnchor}<textarea className="modal-textarea" value={layout.anchorDescription ?? ""} placeholder={t.layoutAnchorPlaceholder} onChange={(event) => onUpdate({ layout: { ...layout, anchorDescription: event.target.value || undefined } })} /></label>
    </div>
  </div>;
}

function LabeledMini({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange(value: string): void }) {
  return <label className="field-label">{label}<span className="select-wrap"><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([v, labelText]) => <option key={v} value={v}>{labelText}</option>)}</select><ChevronDown size={13} /></span></label>;
}
