/** 镜头道具变化编辑器：用一段自然语言描述本镜头中的道具使用与变化。 */
import type { ProjectV2, ShotV2 } from "../../shared-types";
import type { CopyZh } from "../i18n";

interface PropStateEditorProps {
  project: ProjectV2;
  shot: ShotV2;
  t: CopyZh;
  onUpdate(patch: Partial<ShotV2>): void;
}

export default function PropStateEditor({ project, shot, t, onUpdate }: PropStateEditorProps) {
  void project;
  return <div className="prop-state-editor">
    <label className="field-label">
      {t.propChange}
      <textarea
        value={shot.propChangeDescription ?? ""}
        placeholder={t.propChangePlaceholder}
        onChange={(event) => onUpdate({
          propChangeDescription: event.target.value || undefined,
          // 清除旧状态，避免同一镜头同时输出两套道具状态。
          propStatesAtStart: undefined,
          propStatesAtEnd: undefined,
          beats: (shot.beats ?? []).map(({ stateBefore: _stateBefore, stateAfter: _stateAfter, ...beat }) => beat),
        })}
      />
    </label>
    <p className="hint-text">{t.propChangeHint}</p>
  </div>;
}
