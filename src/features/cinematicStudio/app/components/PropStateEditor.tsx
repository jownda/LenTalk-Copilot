/**
 * 镜头状态编辑器（P0.3）
 * 每个 Shot 的「状态」区域：开始状态（自动继承上一镜头结束，可覆写）+ 结束状态。
 * 每条状态：资产（道具/角色/地点）+ 状态标签（内置 + 自定义）+ 持有者 + 位置。
 */
import { useState } from "react";
import type { ProjectV2, PropState, ShotV2 } from "../../shared-types";
import { STATE_LABELS, stateLabelZh } from "../../engine";
import { ChevronDown, Plus, X } from "lucide-react";
import type { CopyZh } from "../i18n";

interface PropStateEditorProps {
  project: ProjectV2;
  shot: ShotV2;
  t: CopyZh;
  onUpdate(patch: Partial<ShotV2>): void;
}

type Draft = { assetId: string; state: string; holderId: string; position: string };

export default function PropStateEditor({ project, shot, t, onUpdate }: PropStateEditorProps) {
  const [draft, setDraft] = useState<Draft>({ assetId: "", state: "", holderId: "", position: "" });
  const [adding, setAdding] = useState<"start" | "end" | null>(null);
  const startStates = shot.propStatesAtStart ?? [];
  const endStates = shot.propStatesAtEnd ?? [];
  const stateableAssets = (project.assets ?? []).filter((asset) => ["prop", "character", "location"].includes(asset.kind));
  const characterAssets = (project.assets ?? []).filter((asset) => asset.kind === "character");

  const commitDraft = (target: "start" | "end") => {
    if (!draft.assetId || !draft.state.trim()) return;
    const state: PropState = {
      propId: draft.assetId,
      state: draft.state.trim(),
      holderCharacterId: draft.holderId || undefined,
      position: draft.position.trim() || undefined,
    };
    const key = target === "start" ? "propStatesAtStart" : "propStatesAtEnd";
    onUpdate({ [key]: [...(shot[key] ?? []), state] } as Partial<ShotV2>);
    setDraft({ assetId: "", state: "", holderId: "", position: "" });
    setAdding(null);
  };

  const updateState = (target: "start" | "end", index: number, patch: Partial<PropState>) => {
    const key = target === "start" ? "propStatesAtStart" : "propStatesAtEnd";
    const list = shot[key] ?? [];
    onUpdate({ [key]: list.map((s, i) => i === index ? { ...s, ...patch } : s) } as Partial<ShotV2>);
  };

  const removeState = (target: "start" | "end", index: number) => {
    const key = target === "start" ? "propStatesAtStart" : "propStatesAtEnd";
    const list = shot[key] ?? [];
    onUpdate({ [key]: list.filter((_, i) => i !== index) } as Partial<ShotV2>);
  };

  const renderList = (target: "start" | "end") => {
    const list = target === "start" ? startStates : endStates;
    return <div className="prop-state-list">
      {list.length === 0 && <span className="hint-text">{target === "start" ? (t.stateInheritedHint) : t.noDesc}</span>}
      {list.map((state, index) => (
        <div className="prop-state-row" key={index}>
          <span className="select-wrap small state-asset">
            <select value={state.propId} onChange={(event) => updateState(target, index, { propId: event.target.value })}>
              {stateableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select><ChevronDown size={12} />
          </span>
          <span className="select-wrap small state-value">
            <select value={STATE_LABELS.some((label) => label.id === state.state) ? state.state : "__custom__"} onChange={(event) => updateState(target, index, { state: event.target.value })}>
              {STATE_LABELS.map((label) => <option key={label.id} value={label.id}>{label.id} · {label.zh}</option>)}
              <option value="__custom__">{t.stateCustom}</option>
            </select><ChevronDown size={12} />
          </span>
          {!STATE_LABELS.some((label) => label.id === state.state) && <input className="mini-input state-custom" value={state.state} placeholder={t.stateCustom} onChange={(event) => updateState(target, index, { state: event.target.value })} />}
          <span className="select-wrap small state-holder">
            <select value={state.holderCharacterId ?? ""} onChange={(event) => updateState(target, index, { holderCharacterId: event.target.value || undefined })}>
              <option value="">{t.holder}: —</option>
              {characterAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select><ChevronDown size={12} />
          </span>
          <input className="mini-input state-position" value={state.position ?? ""} placeholder={t.statePosition} onChange={(event) => updateState(target, index, { position: event.target.value || undefined })} />
          <button className="mini-del" title={t.deleteShot} onClick={() => removeState(target, index)}><X size={11} /></button>
        </div>
      ))}
      {adding === target ? <div className="prop-state-row add-row">
        <span className="select-wrap small state-asset">
          <select value={draft.assetId} onChange={(event) => setDraft((d) => ({ ...d, assetId: event.target.value }))}>
            <option value="">{t.stateAssetPlaceholder}</option>
            {stateableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select><ChevronDown size={12} />
        </span>
        <input className="mini-input state-custom" value={draft.state} placeholder={t.stateLabel} onChange={(event) => setDraft((d) => ({ ...d, state: event.target.value }))} list="state-label-options" />
        <datalist id="state-label-options">{STATE_LABELS.map((label) => <option key={label.id} value={label.id}>{label.zh}</option>)}</datalist>
        <span className="select-wrap small state-holder">
          <select value={draft.holderId} onChange={(event) => setDraft((d) => ({ ...d, holderId: event.target.value }))}>
            <option value="">{t.holder}: —</option>
            {characterAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select><ChevronDown size={12} />
        </span>
        <input className="mini-input state-position" value={draft.position} placeholder={t.statePosition} onChange={(event) => setDraft((d) => ({ ...d, position: event.target.value }))} />
        <button className="mini-confirm" onClick={() => commitDraft(target)}><Plus size={11} /></button>
        <button className="mini-del" onClick={() => setAdding(null)}><X size={11} /></button>
      </div> : <button className="mini-add" onClick={() => setAdding(target)}><Plus size={11} /> {t.addState}</button>}
    </div>;
  };

  return <div className="prop-state-editor">
    <div className="prop-state-block">
      <span className="state-block-title">{t.startStates}</span>
      {renderList("start")}
    </div>
    <div className="prop-state-block">
      <span className="state-block-title">{t.endStates}</span>
      {renderList("end")}
    </div>
  </div>;
}

export { stateLabelZh };