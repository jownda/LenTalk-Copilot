import { useMemo } from "react";

import { useCanvasStore } from "@/stores/canvasStore";

/**
 * Supplies the graph only when connected media/text inputs can have changed.
 * Node movement stays responsive because it does not make every consumer
 * rescan the full node and edge collections.
 */
export function useCanvasInputGraph() {
  const inputGraphRevision = useCanvasStore((state) => state.inputGraphRevision);

  return useMemo(() => {
    void inputGraphRevision;
    const { nodes, edges } = useCanvasStore.getState();
    return { nodes, edges };
  }, [inputGraphRevision]);
}
