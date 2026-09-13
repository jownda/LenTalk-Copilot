/**
 * Shot Beat 编辑器（单输入框版）
 * 每个节拍是一张卡片：顶部紧凑工具条（序号 / 执行者 / 起止时间 / MUST / 排序 / 删除），
 * 主体只有一个自动增高的文字描述框（actionText，最终提示词的节拍正文）。
 */
import { useEffect, useRef } from "react";
import type { ActionBeat, ProjectV2, ShotV2 } from "../../shared-types";
import { getAssistant } from "../providers/ai";
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Sparkles, X } from "lucide-react";
import type { CopyZh } from "../i18n";

interface BeatEditorProps {
  project: ProjectV2;
  shot: ShotV2;
  t: CopyZh;
  onUpdate(patch: Partial<ShotV2>): void;
}

/** 自动增高文本框：内容变化时把高度撑到内容实际高度 */
function NarrativeTextarea({ value, placeholder, onValue }: { value: string; placeholder: string; onValue(value: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="beat-narrative"
      placeholder={placeholder}
      rows={1}
      value={value}
      onChange={(event) => onValue(event.target.value)}
    />
  );
}

export default function BeatEditor({ project, shot, t, onUpdate }: BeatEditorProps) {
  const beats = shot.beats ?? [];
  const participants = (shot.participants ?? []).map((p) => p.characterId);
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");

  const updateBeat = (id: string, patch: Partial<ActionBeat>) => {
    onUpdate({ beats: beats.map((b) => b.id === id ? { ...b, ...patch } : b) });
  };
  const addBeat = () => {
    const created: ActionBeat = { id: crypto.randomUUID(), order: beats.length + 1, actorId: participants[0], verb: "pauses", duration: 2 };
    onUpdate({ beats: [...beats, created] });
  };
  const removeBeat = (id: string) => {
    const remaining = beats.filter((b) => b.id !== id).map((b, i) => ({ ...b, order: i + 1 }));
    onUpdate({ beats: remaining });
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
  /** AI 生成 Beats（自然语言正文，追加到现有列表） */
  const aiGenerateBeats = async () => {
    const props = (project.assets ?? []).filter((a) => a.kind === "prop").map((a) => a.id);
    const suggestions = await getAssistant().generateBeats({ logline: "", scene: shot as never, participants, props });
    const created: ActionBeat[] = suggestions.map((s, i) => ({
      id: crypto.randomUUID(),
      order: beats.length + i + 1,
      actorId: s.actorId,
      verb: "pauses",
      actionText: s.actionText?.trim() ? s.actionText : undefined,
      required: s.required,
      duration: 2,
    }));
    onUpdate({ beats: [...beats, ...created] });
  };

  const actorOptions = characterAssets.filter((asset) => participants.includes(asset.id));

  return <div className="beat-editor">
    <p className="hint-text">节拍只补充镜头总述中的时间、执行角色、对白和新的可见变化；不要重复整段动作、表演与眼神描述。 / Beats add timing, actor, dialogue, and new visible changes only; do not repeat the full shot description.</p>
    <div className="beat-list">
      {beats.length === 0 && <span className="hint-text">{t.noDesc}</span>}
      {[...beats].sort((a, b) => a.order - b.order).map((beat, index) => (
        <div key={beat.id} className="beat-row">
          <div className="beat-row-head">
            <span className="beat-order">{String(beat.order).padStart(2, "0")}</span>
            <span className="select-wrap small beat-actor">
              <select value={beat.actorId ?? ""} disabled={actorOptions.length === 0} onChange={(event) => updateBeat(beat.id, { actorId: event.target.value || undefined })}>
                <option value="">{t.actor}: —</option>
                {actorOptions.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select><ChevronDown size={12} />
            </span>
            <label className="beat-time" title={t.beatStart}>
              <input className="mini-input" type="number" min={0} max={3600} step={0.1} placeholder={t.beatStartPlaceholder} value={beat.startSeconds ?? ""} onChange={(event) => updateBeat(beat.id, { startSeconds: event.target.value === "" ? undefined : Math.max(0, Number(event.target.value)) })} />
            </label>
            <label className="beat-time" title={t.beatDuration}>
              <input className="mini-input" type="number" min={0.1} max={30} step={0.1} value={beat.duration ?? 2} onChange={(event) => updateBeat(beat.id, { duration: Number(event.target.value) || 2 })} />
            </label>
            <button
              type="button"
              className={`beat-required ${beat.required ? "on" : "off"}`}
              title={t.requiredBeat}
              onClick={() => updateBeat(beat.id, { required: !beat.required })}
            >MUST</button>
            <button className="mini-move" type="button" title={t.moveUp} disabled={index === 0} onClick={() => moveBeat(index, -1)}><ChevronLeft size={11} /></button>
            <button className="mini-move" type="button" title={t.moveDown} disabled={index === beats.length - 1} onClick={() => moveBeat(index, 1)}><ChevronRight size={11} /></button>
            <button className="mini-del" type="button" title={t.deleteBeat} onClick={() => removeBeat(beat.id)}><X size={11} /></button>
          </div>
          <div className="beat-narrative-wrap">
            <NarrativeTextarea
              value={beat.actionText ?? ""}
              placeholder={t.beatNarrativePlaceholder}
              onValue={(value) => updateBeat(beat.id, { actionText: value || undefined })}
            />
          </div>
        </div>
      ))}
    </div>
    <div className="beat-actions">
      <button className="mini-add" type="button" onClick={addBeat}><Plus size={11} /> {t.addBeat}</button>
      <button className="mini-add ai" type="button" onClick={aiGenerateBeats}><Sparkles size={11} /> {t.aiGenerateBeats}</button>
    </div>
  </div>;
}
