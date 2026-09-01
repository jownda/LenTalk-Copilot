/**
 * Shot Beat 编辑器（P0.4）
 * Shot 展开为按时间排列的 Beat 列表。每行：序号 / 执行者（当前镜头参与角色）/
 * 动作（动词库+自定义）/ 目标 / 强制。展开详情：目标细化、前置/后置状态、
 * 对白、禁止目标 chips、剪切规则、焦段覆写。
 * 上移/下移重排 beats 并重算 order（时长由用户维护，编译器按 order 输出）。
 * 自动拆镜建议：镜头内焦段切换 ≥3 次时提示。
 */
import { useState } from "react";
import type { ActionBeat, ProjectV2, ShotV2 } from "../../shared-types";
import { BEAT_VERBS, beatVerbZh } from "../../engine";
import { getAssistant } from "../providers/ai";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Sparkles, X } from "lucide-react";
import type { CopyZh } from "../i18n";

interface BeatEditorProps {
  project: ProjectV2;
  shot: ShotV2;
  t: CopyZh;
  onUpdate(patch: Partial<ShotV2>): void;
}

export default function BeatEditor({ project, shot, t, onUpdate }: BeatEditorProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const beats = shot.beats ?? [];
  const participants = (shot.participants ?? []).map((p) => p.characterId);
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");
  const stateableAssets = (project.assets ?? []).filter((asset) => ["prop", "character", "location"].includes(asset.kind));
  const nameOf = (id?: string) => (project.assets ?? []).find((a) => a.id === id)?.name ?? id ?? "?";

  const updateBeat = (id: string, patch: Partial<ActionBeat>) => {
    onUpdate({ beats: beats.map((b) => b.id === id ? { ...b, ...patch } : b) });
  };
  const addBeat = () => {
    const created: ActionBeat = { id: crypto.randomUUID(), order: beats.length + 1, actorId: participants[0], verb: "pauses", duration: 2 };
    onUpdate({ beats: [...beats, created] });
    setExpanded(created.id);
  };
  const removeBeat = (id: string) => {
    const remaining = beats.filter((b) => b.id !== id).map((b, i) => ({ ...b, order: i + 1 }));
    onUpdate({ beats: remaining });
    if (expanded === id) setExpanded(null);
  };
  /** 上移/下移：重排并重算 order（验收：Beat 顺序变更必须重新计算状态与时长顺序） */
  const moveBeat = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= beats.length) return;
    const next = [...beats];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onUpdate({ beats: next.map((b, i) => ({ ...b, order: i + 1 })) });
  };
  /** P3：AI 生成 Beats（结构化 schema 建议，追加到现有列表） */
  const aiGenerateBeats = async () => {
    const props = (project.assets ?? []).filter((a) => a.kind === "prop").map((a) => a.id);
    const suggestions = await getAssistant().generateBeats({ logline: "", scene: shot as never, participants, props });
    const created: ActionBeat[] = suggestions.map((s, i) => ({
      id: crypto.randomUUID(),
      order: beats.length + i + 1,
      verb: s.verb,
      actorId: s.actorId,
      targetCharacterId: s.targetCharacterId,
      targetPropId: s.targetPropId,
      targetBodyPart: s.targetBodyPart,
      actionText: s.actionText,
      required: s.required,
      forbiddenTargets: s.forbiddenTargets,
      duration: 2,
    }));
    onUpdate({ beats: [...beats, ...created] });
  };

  const actorOptions = characterAssets.filter((asset) => participants.includes(asset.id));

  return <div className="beat-editor">
    <div className="beat-list">
      {beats.length === 0 && <span className="hint-text">{t.noDesc}</span>}
      {[...beats].sort((a, b) => a.order - b.order).map((beat, index) => {
        const open = expanded === beat.id;
        return <div key={beat.id} className={`beat-row ${open ? "active" : ""}`}>
          <div className="beat-row-head">
            <span className="beat-order">{String(beat.order).padStart(2, "0")}</span>
            <span className="select-wrap small beat-actor">
              <select value={beat.actorId ?? ""} disabled={actorOptions.length === 0} onChange={(event) => updateBeat(beat.id, { actorId: event.target.value || undefined })}>
                <option value="">{t.actor}: —</option>
                {actorOptions.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select><ChevronDown size={12} />
            </span>
            <span className="select-wrap small beat-verb">
              <select value={BEAT_VERBS.some((v) => v.id === beat.verb) ? beat.verb : "__custom__"} onChange={(event) => updateBeat(beat.id, { verb: event.target.value })}>
                {BEAT_VERBS.map((verb) => <option key={verb.id} value={verb.id}>{verb.zh} · {verb.id}</option>)}
                <option value="__custom__">{t.stateCustom}</option>
              </select><ChevronDown size={12} />
            </span>
            {!BEAT_VERBS.some((v) => v.id === beat.verb) && <input className="mini-input beat-verb-custom" value={beat.verb} placeholder={t.stateCustom} onChange={(event) => updateBeat(beat.id, { verb: event.target.value })} />}
            <span className="beat-target">{nameOf(beat.targetCharacterId ?? beat.targetPropId) || t.targetNone}</span>
            {beat.required && <span className="beat-required" title={t.requiredBeat}>MUST</span>}
            {beat.cutRule && <span className="beat-cut" title={t.cutRule}>✂</span>}
            <button className="mini-del" title={t.deleteBeat} onClick={() => removeBeat(beat.id)}><X size={11} /></button>
            <button className="mini-move" title={t.moveUp} disabled={index === 0} onClick={() => moveBeat(index, -1)}><ChevronLeft size={11} /></button>
            <button className="mini-move" title={t.moveDown} disabled={index === beats.length - 1} onClick={() => moveBeat(index, 1)}><ChevronRight size={11} /></button>
            <button className={`beat-expand ${open ? "open" : ""}`} onClick={() => setExpanded(open ? null : beat.id)}><ChevronDown size={12} /></button>
          </div>
          {open && <div className="beat-detail">
            <div className="fields-grid three">
              <label className="field-label">{t.beatStart}<input className="modal-input" type="number" min={0} max={3600} step={0.1} placeholder={t.beatStartPlaceholder} value={beat.startSeconds ?? ""} onChange={(event) => updateBeat(beat.id, { startSeconds: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })} /></label>
              <label className="field-label">{t.beatDuration}<input className="modal-input" type="number" min={0.1} max={30} step={0.1} value={beat.duration ?? 2} onChange={(event) => updateBeat(beat.id, { duration: Number(event.target.value) || 2 })} /></label>
              <label className="field-label">{t.target}<span className="select-wrap">
                <select value={beat.targetCharacterId ? "character" : beat.targetPropId ? "prop" : ""} onChange={(event) => {
                  const kind = event.target.value;
                  updateBeat(beat.id, kind === "character" ? { targetCharacterId: actorOptions[0]?.id, targetPropId: undefined } : kind === "prop" ? { targetPropId: stateableAssets.find((a) => a.kind === "prop")?.id, targetCharacterId: undefined } : { targetCharacterId: undefined, targetPropId: undefined });
                }}>
                  <option value="">{t.targetNone}</option>
                  <option value="character">{t.targetCharacter}</option>
                  <option value="prop">{t.targetProp}</option>
                </select><ChevronDown size={13} /></span></label>
              {beat.targetCharacterId ? <label className="field-label">{t.targetCharacter}<span className="select-wrap">
                <select value={beat.targetCharacterId} onChange={(event) => updateBeat(beat.id, { targetCharacterId: event.target.value })}>
                  {characterAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select><ChevronDown size={13} /></span></label>
                : beat.targetPropId ? <label className="field-label">{t.targetProp}<span className="select-wrap">
                  <select value={beat.targetPropId} onChange={(event) => updateBeat(beat.id, { targetPropId: event.target.value })}>
                    {stateableAssets.filter((a) => a.kind !== "character").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                  </select><ChevronDown size={13} /></span></label>
                : null}
              <label className="field-label">{t.bodyPart}<input className="modal-input" value={beat.targetBodyPart ?? ""} placeholder={t.bodyPartPlaceholder} onChange={(event) => updateBeat(beat.id, { targetBodyPart: event.target.value || undefined })} /></label>
            </div>

            <label className="field-label">{t.dialogue}<input className="modal-input" value={beat.dialogue ?? ""} placeholder={t.dialogue} onChange={(event) => updateBeat(beat.id, { dialogue: event.target.value || undefined })} /></label>
            <div className="fields-grid two">
              <label className="field-label">{t.beatPropState}<input className="modal-input" value={beat.propState ?? ""} placeholder={t.beatPropStatePlaceholder} onChange={(event) => updateBeat(beat.id, { propState: event.target.value || undefined })} /></label>
              <label className="field-label">{t.beatAudio}<input className="modal-input" value={beat.audio ?? ""} placeholder={t.beatAudioPlaceholder} onChange={(event) => updateBeat(beat.id, { audio: event.target.value || undefined })} /></label>
            </div>

            <div className="fields-grid two beat-p2">
              <label className="field-label">{t.beatTactic}<input className="modal-input" value={beat.tactic ?? ""} placeholder={t.beatTacticPlaceholder} onChange={(event) => updateBeat(beat.id, { tactic: event.target.value || undefined })} /></label>
              <label className="field-label">{t.beatSubtext}<input className="modal-input" value={beat.subtext ?? ""} placeholder={t.beatSubtextPlaceholder} onChange={(event) => updateBeat(beat.id, { subtext: event.target.value || undefined })} /></label>
              <label className="field-label">{t.beatBeatChange}<input className="modal-input" value={beat.beatChange ?? ""} placeholder={t.beatBeatChangePlaceholder} onChange={(event) => updateBeat(beat.id, { beatChange: event.target.value || undefined })} /></label>
              <label className="field-label">{t.beatReaction}<input className="modal-input" value={beat.reactionBeforeLine ?? ""} placeholder={t.beatReactionPlaceholder} onChange={(event) => updateBeat(beat.id, { reactionBeforeLine: event.target.value || undefined })} /></label>
            </div>

            <div className="beat-extras">
              <label className="check-chip-axis"><input type="checkbox" checked={beat.required ?? false} onChange={(event) => updateBeat(beat.id, { required: event.target.checked })} /> {t.requiredBeat}</label>
              <label className="field-label">{t.forbiddenTargets}<span className="select-wrap">
                <select value="" onChange={(event) => { if (event.target.value) { updateBeat(beat.id, { forbiddenTargets: [...(beat.forbiddenTargets ?? []), event.target.value] }); event.target.value = ""; } }}>
                  <option value="">+ {t.forbiddenTargets}</option>
                  {characterAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                  {stateableAssets.filter((a) => a.kind !== "character").map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select><ChevronDown size={13} /></span></label>
              <div className="token-editor">
                {(beat.forbiddenTargets ?? []).map((id) => <span className="token-chip" key={id}>{nameOf(id)}<button onClick={() => updateBeat(beat.id, { forbiddenTargets: (beat.forbiddenTargets ?? []).filter((f) => f !== id) })}><X size={10} /></button></span>)}
              </div>
            </div>

            <label className="field-label">{t.cutRule}<input className="modal-input" value={beat.cutRule ?? ""} placeholder={t.cutRulePlaceholder} onChange={(event) => updateBeat(beat.id, { cutRule: event.target.value || undefined })} /></label>
          </div>}
        </div>;
      })}
    </div>
    <div className="beat-actions">
      <button className="mini-add" onClick={addBeat}><Plus size={11} /> {t.addBeat}</button>
      <button className="mini-add ai" onClick={aiGenerateBeats}><Sparkles size={11} /> {t.aiGenerateBeats}</button>
    </div>
  </div>;
}

export { beatVerbZh };
