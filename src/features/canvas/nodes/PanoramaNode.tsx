import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import * as THREE from 'three';
import { Camera, Orbit, RotateCcw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type PanoramaNodeData,
  type PanoramaOutputAspect,
} from '@/features/canvas/domain/canvasNodes';
import { graphImageResolver } from '@/features/canvas/application/canvasServices';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NODE_CONTROL_ICON_CLASS, NODE_CONTROL_PRIMARY_BUTTON_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import {
  prepareNodeImage,
  prepareNodeImageFromFile,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { useCanvasStore } from '@/stores/canvasStore';

type PanoramaNodeProps = NodeProps & {
  id: string;
  data: PanoramaNodeData;
  selected?: boolean;
};

const SPHERE_RADIUS = 500;
const MIN_FOV = 35;
const MAX_FOV = 100;
const MAX_PITCH = 85;
const OUTPUT_MAX_DIMENSION = 2048;

const ASPECT_OPTIONS: Array<{ value: PanoramaOutputAspect; label: string }> = [
  { value: '16:9', label: '16:9' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: '4:3', label: '4:3' },
];

function parseAspectToRatio(value: string): number {
  const [w, h] = value.split(':').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 16 / 9;
  }
  return w / h;
}

/** 计算取景窗口(遮罩)在节点显示区内的 contain 尺寸 */
function resolveFrameWindow(
  containerWidth: number,
  containerHeight: number,
  aspect: string
): { width: number; height: number } {
  const ratio = parseAspectToRatio(aspect);
  const safeWidth = Math.max(1, containerWidth);
  const safeHeight = Math.max(1, containerHeight);
  const containerRatio = safeWidth / safeHeight;
  if (containerRatio > ratio) {
    return {
      width: Math.max(1, Math.round(safeHeight * ratio)),
      height: safeHeight,
    };
  }
  return {
    width: safeWidth,
    height: Math.max(1, Math.round(safeWidth / ratio)),
  };
}

interface DragState {
  clientX: number;
  clientY: number;
  yaw: number;
  pitch: number;
}

interface PanoramaScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture | null;
  dispose: () => void;
}

function createPanoramaScene(canvas: HTMLCanvasElement): PanoramaScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 1, 1200);
  const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 64);
  geometry.scale(-1, 1, 1); // inner surface
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const sphere = new THREE.Mesh(geometry, material);
  scene.add(sphere);

  return {
    renderer,
    scene,
    camera,
    material,
    texture: null,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

function renderPanoramaView(
  scene: PanoramaScene,
  canvas: HTMLCanvasElement,
  yaw: number,
  pitch: number,
  fov: number
): void {
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
  scene.renderer.setSize(width, height, false);
  scene.camera.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
  scene.camera.aspect = width / height;
  scene.camera.updateProjectionMatrix();

  const safePitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  const phi = THREE.MathUtils.degToRad(90 - safePitch);
  const theta = THREE.MathUtils.degToRad(yaw);
  const target = new THREE.Vector3(
    SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta),
    SPHERE_RADIUS * Math.cos(phi),
    SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
  );
  scene.camera.position.set(0, 0, 0);
  scene.camera.lookAt(target);
  scene.renderer.render(scene.scene, scene.camera);
}

function renderFramedOutput(
  scene: PanoramaScene,
  yaw: number,
  pitch: number,
  fov: number,
  aspect: string,
  frameWindow: { width: number; height: number },
  containerHeight: number
): string {
  const ratio = parseAspectToRatio(aspect);
  let width = OUTPUT_MAX_DIMENSION;
  let height = Math.max(1, Math.round(OUTPUT_MAX_DIMENSION / ratio));
  if (height > OUTPUT_MAX_DIMENSION) {
    height = OUTPUT_MAX_DIMENSION;
    width = Math.max(1, Math.round(OUTPUT_MAX_DIMENSION * ratio));
  }

  // 相机垂直视野 = 遮罩窗口在节点显示区中的垂直占比 × 当前 FOV,
  // 保证取景输出的画面与遮罩窗口内看到的画面严格一致(所见即所得)。
  const safeContainerHeight = Math.max(1, containerHeight);
  const verticalRatio = Math.min(
    1,
    Math.max(0.05, frameWindow.height / safeContainerHeight)
  );
  const baseFovDeg = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
  const baseFovRad = THREE.MathUtils.degToRad(baseFovDeg);
  const framedFovRad = 2 * Math.atan(verticalRatio * Math.tan(baseFovRad / 2));
  const framedFovDeg = THREE.MathUtils.radToDeg(framedFovRad);

  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offscreenRenderer = new THREE.WebGLRenderer({
    canvas: offscreen,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  offscreenRenderer.setPixelRatio(1);
  offscreenRenderer.outputColorSpace = THREE.SRGBColorSpace;

  const camera = new THREE.PerspectiveCamera(framedFovDeg, width / height, 1, 1200);
  const safePitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  const phi = THREE.MathUtils.degToRad(90 - safePitch);
  const theta = THREE.MathUtils.degToRad(yaw);
  const target = new THREE.Vector3(
    SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta),
    SPHERE_RADIUS * Math.cos(phi),
    SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
  );
  camera.position.set(0, 0, 0);
  camera.lookAt(target);

  offscreenRenderer.render(scene.scene, camera);
  const dataUrl = offscreen.toDataURL('image/png');
  offscreenRenderer.dispose();
  return dataUrl;
}

export const PanoramaNode = memo(({ id, data, selected, width, height }: PanoramaNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<PanoramaScene | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const animationRef = useRef<number | null>(null);
  const isFramingRef = useRef(false);

  const [isFraming, setIsFraming] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const inputImages = useMemo(
    () => graphImageResolver.collectInputImages(id, nodes, edges),
    [id, nodes, edges]
  );
  const inputImageUrl = data.inputImageUrl || inputImages[0] || null;

  const resolvedWidth = typeof width === 'number' && width > 1 ? Math.round(width) : 320;
  const resolvedHeight = typeof height === 'number' && height > 1 ? Math.round(height) : 220;
  const frameWindow = useMemo(
    () => resolveFrameWindow(resolvedWidth, resolvedHeight, data.outputAspect),
    [data.outputAspect, resolvedWidth, resolvedHeight]
  );
  const displayName = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.panorama, data),
    [data]
  );

  // ----- renderer lifecycle -----
  const stopLoop = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const renderLoop = useCallback(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    if (!scene || !canvas) return;
    renderPanoramaView(scene, canvas, data.yaw, data.pitch, data.fov);
    animationRef.current = requestAnimationFrame(renderLoop);
  }, [data.yaw, data.pitch, data.fov]);

  // 使用原生 wheel 监听(React 合成事件对 wheel 默认 passive,preventDefault 无效),
  // 确保滚轮缩放 FOV 不被 React Flow 画布缩放或页面滚动拦截。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      if (isFramingRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const nextFov = Math.max(
        MIN_FOV,
        Math.min(MAX_FOV, data.fov + event.deltaY * 0.08)
      );
      updateNodeData(id, { fov: nextFov });
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [data.fov, id, updateNodeData]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!sceneRef.current) {
      sceneRef.current = createPanoramaScene(canvas);
    }
    return () => {
      stopLoop();
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, [stopLoop]);

  // ----- texture loading -----
  useEffect(() => {
    const canvas = canvasRef.current;
    const scene = sceneRef.current;
    if (!inputImageUrl || !canvas || !scene) {
      setIsReady(false);
      return;
    }

    let cancelled = false;
    setLoadError(false);
    setIsReady(false);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      if (scene.texture) {
        scene.texture.dispose();
        scene.texture = null;
      }
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      scene.texture = texture;
      scene.material.map = texture;
      scene.material.needsUpdate = true;
      setIsReady(true);
    };
    image.onerror = () => {
      if (!cancelled) setLoadError(true);
    };
    image.src = resolveImageDisplayUrl(inputImageUrl);
    return () => {
      cancelled = true;
    };
  }, [inputImageUrl]);

  // ----- animation loop (driven by data yaw/pitch/fov) -----
  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    if (!scene || !canvas || !isReady) return;
    stopLoop();
    animationRef.current = requestAnimationFrame(renderLoop);
    return stopLoop;
  }, [isReady, renderLoop, stopLoop]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedWidth, resolvedHeight, updateNodeInternals]);

  // ----- drag interactions (also update node data for persistence) -----
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    setSelectedNode(id);
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      yaw: data.yaw,
      pitch: data.pitch,
    };
    event.preventDefault();
    event.stopPropagation();
  }, [data.yaw, data.pitch, id, setSelectedNode]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || isFramingRef.current) return;
      const dx = event.clientX - drag.clientX;
      const dy = event.clientY - drag.clientY;
      const nextYaw = drag.yaw - dx * 0.18;
      const nextPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, drag.pitch + dy * 0.18));
      updateNodeData(id, { yaw: nextYaw, pitch: nextPitch });
    },
    [id, updateNodeData]
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const resetView = useCallback(() => {
    updateNodeData(id, { yaw: 0, pitch: 0, fov: 75 });
  }, [id, updateNodeData]);

  const handleCapture = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene || isFramingRef.current) return;
    isFramingRef.current = true;
    setIsFraming(true);
    try {
      const dataUrl = renderFramedOutput(
        scene,
        data.yaw,
        data.pitch,
        data.fov,
        data.outputAspect,
        frameWindow,
        resolvedHeight
      );
      const prepared = await prepareNodeImage(dataUrl);
      updateNodeData(id, {
        outputImageUrl: prepared.imageUrl,
        outputPreviewImageUrl: prepared.previewImageUrl,
      });

      // 在节点右侧自动创建一个结果图片节点并连线,展示当前窗口构图
      addDerivedExportNode(
        id,
        prepared.imageUrl,
        data.outputAspect,
        prepared.previewImageUrl,
        {
          defaultTitle: `${displayName} · 取景`,
          resultKind: 'generic',
          aspectRatioStrategy: 'provided',
        }
      );
    } catch (error) {
      console.warn('[panoramaNode] capture failed', error);
    } finally {
      isFramingRef.current = false;
      setIsFraming(false);
    }
  }, [
    addDerivedExportNode,
    data.fov,
    data.outputAspect,
    data.pitch,
    data.yaw,
    displayName,
    frameWindow,
    id,
    resolvedHeight,
    updateNodeData,
  ]);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const file = event.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      const prepared = await prepareNodeImageFromFile(file);
      updateNodeData(id, {
        inputImageUrl: prepared.imageUrl,
        previewInputImageUrl: prepared.previewImageUrl,
      });
    },
    [id, updateNodeData]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file || !file.type.startsWith('image/')) return;
      const prepared = await prepareNodeImageFromFile(file);
      updateNodeData(id, {
        inputImageUrl: prepared.imageUrl,
        previewInputImageUrl: prepared.previewImageUrl,
      });
    },
    [id, updateNodeData]
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border bg-surface-dark/85 p-0 transition-colors duration-150
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Orbit className="h-4 w-4" />}
        titleText={displayName}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="relative h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-bg-dark">
        <canvas
          ref={canvasRef}
          className="nodrag nowheel h-full w-full"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
        />

        {/* 取景构图遮罩:中间留出当前画幅比例的取景窗口,四周暗化 */}
        {inputImageUrl && isReady && (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{
                width: frameWindow.width,
                height: frameWindow.height,
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
                outline: '1px solid rgba(255, 255, 255, 0.45)',
                outlineOffset: '-1px',
              }}
            />
          </div>
        )}

        {!inputImageUrl && (
          <button
            type="button"
            className="nodrag absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted/85 transition-colors hover:text-text-dark"
            onClick={(event) => {
              event.stopPropagation();
              handleUploadClick();
            }}
          >
            <Orbit className="h-8 w-8 opacity-60" />
            <span className="px-4 text-center text-[12px] leading-5">
              {t('node.panorama.uploadHint', '点击上传全景图\n或从上游节点连线')}
            </span>
          </button>
        )}

        {inputImageUrl && !isReady && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/55 px-3 py-1 text-[11px] text-white">
              {t('node.panorama.loading', '加载中…')}
            </span>
          </div>
        )}

        {loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/55 px-3 py-1 text-[11px] text-white">
              {t('node.panorama.loadFailed', '图片加载失败')}
            </span>
          </div>
        )}

        {/* replace image button */}
        {inputImageUrl && (
          <button
            type="button"
            className="nodrag absolute left-2 bottom-2 flex h-7 items-center gap-1 rounded-md bg-black/55 px-2 text-[11px] text-white backdrop-blur-sm transition-colors hover:bg-black/75"
            onClick={(event) => {
              event.stopPropagation();
              handleUploadClick();
            }}
            title={t('node.panorama.replaceImage', '更换全景图')}
          >
            <Upload className="h-3.5 w-3.5" />
            {t('node.panorama.replaceImage', '更换')}
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />

        {/* top controls */}
        {inputImageUrl && (
          <div className="absolute left-2 top-2 flex items-center gap-1">
            <button
              className="nodrag flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
              onClick={(event) => {
                event.stopPropagation();
                resetView();
              }}
              title={t('node.panorama.reset', '重置视角')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* output aspect selector */}
        {inputImageUrl && (
          <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-1 backdrop-blur-sm">
            {ASPECT_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={`
                  nodrag rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors
                  ${data.outputAspect === option.value
                    ? 'bg-white/25 text-white'
                    : 'text-white/60 hover:text-white'}
                `}
                onClick={(event) => {
                  event.stopPropagation();
                  updateNodeData(id, { outputAspect: option.value });
                }}
                title={t('node.panorama.outputAspect', '输出画幅')}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {/* capture button */}
        {inputImageUrl && (
          <button
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS} absolute bottom-2 left-1/2 -translate-x-1/2`}
            onClick={(event) => {
              event.stopPropagation();
              void handleCapture();
            }}
            disabled={isFraming}
          >
            <Camera className={NODE_CONTROL_ICON_CLASS} />
            {isFraming
              ? t('node.panorama.framing', '取景中…')
              : t('node.panorama.capture', '取景输出')}
          </button>
        )}

        {/* output badge */}
        {data.outputImageUrl && (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-emerald-500/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {t('node.panorama.framed', '已取景')}
          </div>
        )}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle minWidth={240} minHeight={160} maxWidth={1400} maxHeight={1400} />
    </div>
  );
});

PanoramaNode.displayName = 'PanoramaNode';
