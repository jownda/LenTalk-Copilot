import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';

export interface PanoramaViewerProps {
  imageUrl: string;
  onExit: () => void;
}

interface DragState {
  clientX: number;
  clientY: number;
  yaw: number;
  pitch: number;
}

const MIN_FOV = 35;
const MAX_FOV = 100;
const DEFAULT_FOV = 75;
const SPHERE_RADIUS = 500;
const MAX_PITCH = 85;

interface PanoramaScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sphere: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture | null;
}

export function PanoramaViewer({ imageUrl, onExit }: PanoramaViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PanoramaScene | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const stateRef = useRef({ yaw: 0, pitch: 0, fov: DEFAULT_FOV });
  const animationRef = useRef<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const disposeScene = useCallback(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    const scene = sceneRef.current;
    if (scene) {
      scene.texture?.dispose?.();
      scene.material.dispose?.();
      scene.renderer.dispose?.();
      sceneRef.current = null;
    }
  }, []);

  const renderFrame = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const height = Math.max(1, canvas.clientHeight || canvas.height || 1);

    scene.renderer.setSize(width, height, false);
    scene.camera.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, state.fov));
    scene.camera.aspect = width / height;
    scene.camera.updateProjectionMatrix();

    const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.pitch));
    const phi = THREE.MathUtils.degToRad(90 - pitch);
    const theta = THREE.MathUtils.degToRad(state.yaw);
    const target = new THREE.Vector3(
      SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta),
      SPHERE_RADIUS * Math.cos(phi),
      SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
    );
    scene.camera.position.set(0, 0, 0);
    scene.camera.lookAt(target);

    scene.renderer.render(scene.scene, scene.camera);
    animationRef.current = requestAnimationFrame(renderFrame);
  }, []);

  const ensureScene = useCallback(async () => {
    if (sceneRef.current) {
      return true;
    }

    const canvas = canvasRef.current;
    if (!canvas) return false;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 16 / 9, 1, 1200);
    const geometry = new THREE.SphereGeometry(SPHERE_RADIUS, 96, 64);
    geometry.scale(-1, 1, 1); // flip inside-out so texture renders on inner surface
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    sceneRef.current = { renderer, scene, camera, sphere, material, texture: null };
    return true;
  }, []);

  const loadTexture = useCallback(
    async (src: string) => {
      setLoadError(false);
      setIsReady(false);
      const ready = await ensureScene();
      if (!ready) {
        setLoadError(true);
        return;
      }

      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image load failed'));
        image.src = src;
        if (image.complete && image.naturalWidth) {
          resolve();
        }
      });

      const scene = sceneRef.current;
      if (!scene) return;

      if (scene.texture) {
        scene.texture.dispose?.();
        scene.texture = null;
      }

      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      scene.texture = texture;
      scene.material.map = texture;
      scene.material.needsUpdate = true;

      setIsReady(true);
      renderFrame();
    },
    [ensureScene, renderFrame]
  );

  useEffect(() => {
    void loadTexture(imageUrl);
    return disposeScene;
  }, [imageUrl, loadTexture, disposeScene]);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    dragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      yaw: stateRef.current.yaw,
      pitch: stateRef.current.pitch,
    };
    event.preventDefault();
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    stateRef.current.yaw = drag.yaw - dx * 0.18;
    stateRef.current.pitch = Math.max(
      -MAX_PITCH,
      Math.min(MAX_PITCH, drag.pitch + dy * 0.18)
    );
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stateRef.current.fov = Math.max(
      MIN_FOV,
      Math.min(MAX_FOV, stateRef.current.fov + event.deltaY * 0.08)
    );
  }, []);

  const resetView = useCallback(() => {
    stateRef.current.yaw = 0;
    stateRef.current.pitch = 0;
    stateRef.current.fov = DEFAULT_FOV;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onExit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[100] overflow-hidden bg-black"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />

      {!isReady && !loadError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/60 px-4 py-2 text-sm text-white backdrop-blur-xl">
            {t('viewer.panoramaLoading', '全景加载中…')}
          </span>
        </div>
      )}

      {loadError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-black/60 px-4 py-2 text-sm text-white backdrop-blur-xl">
            {t('viewer.panoramaLoadFailed', '全景加载失败')}
          </span>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between p-4">
        <div className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur-xl">
          {t('viewer.panoramaHint', '拖动旋转 · 滚轮缩放视野')}
        </div>
        <button
          className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full border border-white/20 bg-black/60 px-4 text-sm text-white backdrop-blur-xl transition-colors hover:bg-white/10"
          onClick={resetView}
        >
          <RotateCcw className="h-4 w-4" />
          {t('viewer.reset', '重置视图')}
        </button>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex items-center justify-center gap-3">
        <button
          className="pointer-events-auto inline-flex h-10 items-center rounded-full border border-white/20 bg-black/60 px-4 text-sm text-white backdrop-blur-xl transition-colors hover:bg-white/10"
          onClick={onExit}
        >
          {t('viewer.exitPanorama', '退出全景')}
        </button>
      </div>
    </div>
  );
}
