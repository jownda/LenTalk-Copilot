import { v4 as uuidv4 } from "uuid";

import type { CanvasNodeType } from "@/features/canvas/domain/canvasNodes";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type MosaicLayerItem,
  type SeamlessMosaicNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  fitCanvasToSingleLayer,
  initialLayerBox,
} from "@/features/canvas/application/mosaicFit";
import { loadImageElement, reduceAspectRatio } from "@/features/canvas/application/imageData";
import { useCanvasStore } from "@/stores/canvasStore";

import { canvasEventBus, graphImageResolver } from "./canvasServices";

/** 画幅尺寸边界，与 `mosaicFit` 的 CANVAS_MIN_EDGE / CANVAS_MAX_EDGE 一致。 */
const CANVAS_MIN_EDGE = 64;
const CANVAS_MAX_EDGE = 8192;

/**
 * 把画幅与唯一图层改成图片的**真实像素尺寸**。
 *
 * 转换是同步的（必须立刻切类型 + 开编辑器），但这时拿不到图片的 naturalWidth/Height，
 * 只能先用 512 基准的占位框。等图片解码完再校正一次：画幅 = 原图分辨率，
 * 导出、裁剪都按真实像素来，而不是一张 512 宽的小图。
 *
 * 校正带三重保护，绝不覆盖用户已经做过的编辑：
 * - 图层 id 必须还是我们写进去的那一个；
 * - 图层尺寸必须还是占位值；
 * - 画幅必须还是占位值。
 */
function refineCanvasToNaturalSize(
  nodeId: string,
  layerId: string,
  imageUrl: string,
  placeholderWidth: number,
  placeholderCanvasWidth: number,
): void {
  void (async () => {
    let image: HTMLImageElement;
    try {
      image = await loadImageElement(imageUrl);
    } catch {
      // 远程图可能被 CORS 挡住；拿不到就用占位画幅，功能不受影响。
      return;
    }
    const width = Math.min(CANVAS_MAX_EDGE, Math.max(CANVAS_MIN_EDGE, Math.round(image.naturalWidth)));
    const height = Math.min(CANVAS_MAX_EDGE, Math.max(CANVAS_MIN_EDGE, Math.round(image.naturalHeight)));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }

    const state = useCanvasStore.getState();
    const node = state.nodes.find((item) => item.id === nodeId);
    if (!node || node.type !== CANVAS_NODE_TYPES.seamlessMosaic) {
      return;
    }
    const data = node.data as SeamlessMosaicNodeData;
    const layers = data.layers ?? [];
    if (layers.length !== 1 || layers[0].id !== layerId) {
      return;
    }
    if (
      Math.round(layers[0].width) !== Math.round(placeholderWidth) ||
      Math.round(data.canvasWidth) !== Math.round(placeholderCanvasWidth)
    ) {
      return;
    }

    const imageAspect = reduceAspectRatio(width, height);
    state.updateNodeData(nodeId, {
      layers: [
        {
          ...layers[0],
          x: 0,
          y: 0,
          width,
          height,
          aspectRatio: imageAspect,
          crop: null,
        },
      ],
      canvasWidth: width,
      canvasHeight: height,
      canvasFitted: true,
    });
    // 注意：这里**不改节点框尺寸**。节点框尺寸一旦被改，`findNodePosition` 用它算
    // 「应用」生成的下游节点水平位置就会跑偏，且还原时还得再改回来。
    // 画幅/图层是编辑器的临时数据，节点框尺寸保持原值，对齐才始终正确。
  })();
}

/**
 * 图片工具栏里的「图片编辑」入口：**就地**把当前图片节点变成「图片编辑」节点并展开全屏编辑器。
 *
 * 不做下游节点：用户点的是「编辑这张图」，不是「再复制一张继续处理」。新建会多出一对
 * 节点与连线，原图还占着位置，画布越用越乱。
 *
 * 连线不受影响：`replaceNodeType` 只换 `type` 与 `data`，边的 source/target 仍是同一个 id，
 * 下游引用原图的地方继续有效（取的是节点的输出图）。
 */
/**
 * 「临时编辑会话」快照：点了图片编辑之后，这个节点原本是什么类型、什么数据。
 *
 * 编辑期间节点会临时变成 `seamlessMosaic`（编辑器的数据格式要求如此），
 * 关掉编辑器就按这份快照还回去 —— 用户要的是「编辑这张图」，不是「把节点换成图片编辑节点」。
 */
interface MosaicEditSnapshot {
  type: CanvasNodeType;
  data: Record<string, unknown>;
}

const pendingRestore = new Map<string, MosaicEditSnapshot>();

/**
 * 结束临时编辑会话，把节点还原成点「图片编辑」之前的样子。
 *
 * 编辑期间节点只是**临时**换成 `seamlessMosaic`（编辑器的数据格式要求），
 * 尺寸与位置全程没动；应用/导出动作会新建下游节点，绝不会替换原节点。
 * 所以这里只还原类型与数据 —— 原图片节点始终还是那个图片节点。
 *
 * 对真正的图片编辑节点（不是临时会话）调用这里是空操作。
 */
export function restoreNodeAfterMosaicEdit(nodeId: string): void {
  const snapshot = pendingRestore.get(nodeId);
  if (!snapshot) {
    return;
  }
  pendingRestore.delete(nodeId);

  const state = useCanvasStore.getState();
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return;
  }

  state.replaceNodeType(nodeId, snapshot.type, { ...snapshot.data });
}

export function openMosaicEditorForNode(node: CanvasNode): void {
  const { replaceNodeType } = useCanvasStore.getState();

  if (node.type !== CANVAS_NODE_TYPES.seamlessMosaic) {
    const data = node.data as {
      imageUrl?: string | null;
      previewImageUrl?: string | null;
      aspectRatio?: string;
      displayName?: string;
    };
    const imageUrl = data.imageUrl ?? null;
    if (imageUrl) {
      // 先记下原样：编辑器关闭时按这份快照还原（见 `restoreNodeAfterMosaicEdit`）。
      pendingRestore.set(node.id, {
        type: node.type,
        data: { ...(node.data as Record<string, unknown>) },
      });
      const aspectRatio = data.aspectRatio ?? "1:1";
      const box = initialLayerBox(aspectRatio);
      const layer: MosaicLayerItem = {
        id: uuidv4(),
        imageUrl,
        previewImageUrl: data.previewImageUrl ?? imageUrl,
        sourceName: data.displayName,
        aspectRatio,
        x: 0,
        y: 0,
        width: box.width,
        height: box.height,
        crop: null,
        visible: true,
        order: 0,
        opacity: 1,
      };
      const fitted = fitCanvasToSingleLayer([layer], 1920, 1080);
      // 上游已有的图要先记成「已导入」：否则新节点挂载后会自动再导一次，
      // 同一张图变成两层，用户第一眼就看到重影。
      const state = useCanvasStore.getState();
      const incomingImages = graphImageResolver.collectInputImages(node.id, state.nodes, state.edges);
      const importedSourceKeys = Array.from(new Set([imageUrl, ...incomingImages]));

      replaceNodeType(node.id, CANVAS_NODE_TYPES.seamlessMosaic, {
        // 原图与比例原样带过去，节点标题也保留（多半就是这张图的提示词）。
        imageUrl,
        previewImageUrl: layer.previewImageUrl,
        aspectRatio,
        ...(data.displayName ? { displayName: data.displayName } : {}),
        layers: fitted?.layers ?? [layer],
        importedSourceKeys,
        // 就地转换时，这张图**仍然是本节点的输出**：下游取图只认 `outputImageUrl`，
        // 不补这两个字段的话，转换瞬间所有下游都会变成"没有输入"。用户导出新结果后
        // 会被覆盖成合并图。
        outputImageUrl: imageUrl,
        outputPreviewImageUrl: layer.previewImageUrl ?? imageUrl,
        ...(fitted
          ? { canvasWidth: fitted.width, canvasHeight: fitted.height, canvasFitted: true }
          : {}),
      });

      // 不改节点框尺寸：保持原图片节点的尺寸，这样「应用」生成的下游节点用
      // `findNodePosition` 对齐时读到的就是原始尺寸，不会跑偏。画幅/图层是编辑器的
      // 临时数据，与节点框尺寸无关。

      // 占位画幅是 512 基准的小图；图片解码完再按真实像素校正一次（画幅 = 原图尺寸）。
      refineCanvasToNaturalSize(
        node.id,
        layer.id,
        imageUrl,
        (fitted?.layers[0] ?? layer).width,
        (fitted?.width ?? box.width),
      );
    }
  }

  // 换类型会让节点组件重挂载，订阅要等新组件挂上才收得到 —— 补一次比死等稳。
  // 打开编辑器是幂等的，重复收到同一个 nodeId 只是再 setState(true) 一次。
  const announce = () => canvasEventBus.publish("mosaic-editor/open", { nodeId: node.id });
  announce();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(announce);
  }
  setTimeout(announce, 180);
}
