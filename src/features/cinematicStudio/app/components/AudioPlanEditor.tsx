/**
 * 音频计划编辑器（P1.3 / 双语）
 * 画内音乐 与 环境音效 并排两列；配乐 / 字幕 并排一行。
 * 已去掉预置 chips（用户要求），只保留自填 token 输入。
 * 画内音乐额外带「来源道具」下拉（从资产库道具选择）。
 */
import { useState } from "react";
import type { AudioPlan, ProjectV2 } from "../../shared-types";
import { ChevronDown, Plus, X } from "lucide-react";
import type { CopyZh } from "../i18n";

interface AudioPlanEditorProps {
  project: ProjectV2;
  t: CopyZh;
  onChange(plan: AudioPlan): void;
}

export default function AudioPlanEditor({ project, t, onChange }: AudioPlanEditorProps) {
  const [musicDraft, setMusicDraft] = useState("");
  const [sfxDraft, setSfxDraft] = useState("");
  const audio = project.audioPlan ?? { score: "none" as const, subtitles: false };
  const propAssets = (project.assets ?? []).filter((asset) => asset.kind === "prop");

  const patch = (updates: Partial<AudioPlan>) => onChange({ ...audio, ...updates });

  const addMusic = (value: string) => {
    const item = value.trim();
    if (!item || (audio.diegeticMusic ?? []).includes(item)) return;
    patch({ diegeticMusic: [...(audio.diegeticMusic ?? []), item] });
    setMusicDraft("");
  };
  const addSfx = (value: string) => {
    const item = value.trim();
    if (!item || (audio.sfx ?? []).includes(item)) return;
    patch({ sfx: [...(audio.sfx ?? []), item] });
    setSfxDraft("");
  };

  return <div className="audio-editor">
    <span className="hint-text audio-hint">{t.audioHint}</span>

    {/* 画内音乐 + 环境音效：并排两列 */}
    <div className="audio-cols">
      <div className="audio-col">
        <span className="audio-col-label">{t.diegeticMusic}</span>
        {(audio.diegeticMusic ?? []).length > 0 && (
          <div className="token-editor">
            {(audio.diegeticMusic ?? []).map((item) => (
              <span className="token-chip" key={item}>{item}<button onClick={() => patch({ diegeticMusic: (audio.diegeticMusic ?? []).filter((x) => x !== item) })}><X size={10} /></button></span>
            ))}
          </div>
        )}
        <div className="token-input-row">
          <input className="modal-input" value={musicDraft} placeholder={t.addItem} onChange={(event) => setMusicDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addMusic(musicDraft); }} />
          <button className="mini-confirm" onClick={() => addMusic(musicDraft)}><Plus size={12} /></button>
        </div>
        <label className="field-label audio-source">{t.musicSource}<span className="select-wrap">
          <select value={audio.musicSourcePropId ?? ""} onChange={(event) => patch({ musicSourcePropId: event.target.value || undefined })}>
            <option value="">—</option>
            {propAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select><ChevronDown size={13} />
        </span></label>
      </div>

      <div className="audio-col">
        <span className="audio-col-label">{t.sfx}</span>
        {(audio.sfx ?? []).length > 0 && (
          <div className="token-editor">
            {(audio.sfx ?? []).map((item) => (
              <span className="token-chip" key={item}>{item}<button onClick={() => patch({ sfx: (audio.sfx ?? []).filter((x) => x !== item) })}><X size={10} /></button></span>
            ))}
          </div>
        )}
        <div className="token-input-row">
          <input className="modal-input" value={sfxDraft} placeholder={t.addItem} onChange={(event) => setSfxDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSfx(sfxDraft); }} />
          <button className="mini-confirm" onClick={() => addSfx(sfxDraft)}><Plus size={12} /></button>
        </div>
      </div>
    </div>

    {/* 配乐 + 字幕（并排，省纵向空间） */}
    <div className="fields-grid two audio-meta-row">
      <label className="field-label">{t.score}<span className="select-wrap audio-score-select">
        <select value={audio.score ?? "none"} onChange={(event) => patch({ score: event.target.value as AudioPlan["score"] })}>
          <option value="none">{t.scoreNone}</option>
          <option value="original-score">{t.scoreOriginal}</option>
        </select><ChevronDown size={13} />
      </span></label>
      <label className="field-label">{t.subtitles}<span className="select-wrap audio-score-select">
        <select value={audio.subtitles ? "on" : "off"} onChange={(event) => patch({ subtitles: event.target.value === "on" })}>
          <option value="off">{t.subtitlesNone}</option>
          <option value="on">{t.subtitlesBurned}</option>
        </select><ChevronDown size={13} />
      </span></label>
    </div>
  </div>;
}
