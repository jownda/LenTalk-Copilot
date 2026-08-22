import {
  InspectorAxisGroup,
  InspectorPanel,
  InspectorSection,
  InspectorTextField,
  TransformGizmoHeightControl,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";

function replaceAxis(tuple: [number, number, number], axis: 0 | 1 | 2, value: number): [number, number, number] {
  return tuple.map((item, index) => (index === axis ? value : item)) as [number, number, number];
}

/** 立绘卡属性面板:预览 + 名称 + 变换 + 面向相机开关 */
export function BillboardPanel() {
  const billboard = useDirectorStore((state) => {
    const selected = state.project.objects.find((item) => item.id === state.selectedObjectId);
    return selected?.kind === "billboard" ? selected : undefined;
  });
  const updateObjectName = useDirectorStore((state) => state.updateObjectName);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const updateTransformGizmoHeight = useDirectorStore((state) => state.updateTransformGizmoHeight);
  const updateBillboardFaceCamera = useDirectorStore((state) => state.updateBillboardFaceCamera);

  if (!billboard) return null;

  const faceCamera = billboard.billboardFaceCamera !== false;

  return (
    <InspectorPanel title="立绘卡" ariaLabel="立绘卡右侧属性面板" className="billboard-inspector">
      <InspectorSection title="预览">
        <div className="billboard-preview-wrap">
          {billboard.imageUrl ? (
            <img className="billboard-preview" src={billboard.imageUrl} alt={billboard.name} />
          ) : (
            <span className="billboard-preview-empty">无图片</span>
          )}
        </div>
      </InspectorSection>
      <InspectorTextField
        label="名称"
        ariaLabel="立绘卡名称"
        value={billboard.name}
        onChange={(value) => updateObjectName(billboard.id, value)}
      />
      <InspectorAxisGroup
        label="位置"
        axes={[
          {
            axis: "X",
            ariaLabel: "立绘卡位置 X",
            value: billboard.transform.position[0],
            onChange: (value) => updateObjectTransform(billboard.id, { position: replaceAxis(billboard.transform.position, 0, Number(value)) }),
          },
          {
            axis: "Y",
            ariaLabel: "立绘卡位置 Y",
            value: billboard.transform.position[1],
            onChange: (value) => updateObjectTransform(billboard.id, { position: replaceAxis(billboard.transform.position, 1, Number(value)) }),
          },
          {
            axis: "Z",
            ariaLabel: "立绘卡位置 Z",
            value: billboard.transform.position[2],
            onChange: (value) => updateObjectTransform(billboard.id, { position: replaceAxis(billboard.transform.position, 2, Number(value)) }),
          },
        ]}
      />
      <InspectorAxisGroup
        label="旋转"
        axes={[
          {
            axis: "X",
            ariaLabel: "立绘卡旋转 X",
            value: billboard.transform.rotation[0],
            onChange: (value) => updateObjectTransform(billboard.id, { rotation: replaceAxis(billboard.transform.rotation, 0, Number(value)) }),
          },
          {
            axis: "Y",
            ariaLabel: "立绘卡旋转 Y",
            value: billboard.transform.rotation[1],
            onChange: (value) => updateObjectTransform(billboard.id, { rotation: replaceAxis(billboard.transform.rotation, 1, Number(value)) }),
          },
          {
            axis: "Z",
            ariaLabel: "立绘卡旋转 Z",
            value: billboard.transform.rotation[2],
            onChange: (value) => updateObjectTransform(billboard.id, { rotation: replaceAxis(billboard.transform.rotation, 2, Number(value)) }),
          },
        ]}
      />
      <InspectorAxisGroup
        label="缩放"
        axes={[
          {
            axis: "X",
            ariaLabel: "立绘卡缩放 X",
            step: "0.01",
            value: billboard.transform.scale[0],
            onChange: (value) => updateObjectTransform(billboard.id, { scale: replaceAxis(billboard.transform.scale, 0, Number(value)) }),
          },
          {
            axis: "Y",
            ariaLabel: "立绘卡缩放 Y",
            step: "0.01",
            value: billboard.transform.scale[1],
            onChange: (value) => updateObjectTransform(billboard.id, { scale: replaceAxis(billboard.transform.scale, 1, Number(value)) }),
          },
          {
            axis: "Z",
            ariaLabel: "立绘卡缩放 Z",
            step: "0.01",
            value: billboard.transform.scale[2],
            onChange: (value) => updateObjectTransform(billboard.id, { scale: replaceAxis(billboard.transform.scale, 2, Number(value)) }),
          },
        ]}
      />
      <TransformGizmoHeightControl
        ariaLabel="立绘卡控制器高度"
        value={billboard.transformGizmoHeight}
        onChange={(height) => updateTransformGizmoHeight(billboard.id, height)}
      />
      <label className="inspector-field inspector-checkbox-field">
        <input
          type="checkbox"
          checked={faceCamera}
          onChange={(event) => updateBillboardFaceCamera(billboard.id, event.target.checked)}
        />
        <span className="inspector-field-label">面向相机</span>
      </label>
    </InspectorPanel>
  );
}
