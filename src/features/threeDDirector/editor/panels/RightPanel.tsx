import { useDirectorStore } from "../store/directorStore";
import { selectRightPanelKind } from "../store/directorSelectors";
import { CameraPanel } from "./CameraPanel";
import { CharacterPanel } from "./CharacterPanel";
import { BillboardPanel } from "./BillboardPanel";
import { PropPanel } from "./PropPanel";
import { ScenePanel } from "./ScenePanel";

export function RightPanel() {
  const panelKind = useDirectorStore(selectRightPanelKind);

  return (
    <div className="right-panel-slot" key={panelKind} data-panel-kind={panelKind}>
      {panelKind === "character" ? <CharacterPanel /> : null}
      {panelKind === "prop" ? <PropPanel /> : null}
      {panelKind === "camera" ? <CameraPanel /> : null}
      {panelKind === "billboard" ? <BillboardPanel /> : null}
      {panelKind === "scene" ? <ScenePanel /> : null}
    </div>
  );
}
