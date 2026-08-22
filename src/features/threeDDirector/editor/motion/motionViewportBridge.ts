import type { CameraShotSnapshot } from "../store/directorStore";
import { useSyncExternalStore } from "react";

export interface MotionViewportBridge {
  getSnapshot: () => CameraShotSnapshot;
  loadSnapshot: (snapshot: CameraShotSnapshot) => void;
  startPilot: (editKeyframeId?: string | null) => void;
}

let activeBridge: MotionViewportBridge | null = null;
const listeners = new Set<() => void>();

export function setMotionViewportBridge(bridge: MotionViewportBridge | null) {
  activeBridge = bridge;
  listeners.forEach((listener) => listener());
}

export function getMotionViewportBridge() {
  return activeBridge;
}

export function useMotionViewportBridge() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activeBridge,
    () => null
  );
}
