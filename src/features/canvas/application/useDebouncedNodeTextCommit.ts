import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import type { CanvasNodeData } from "@/features/canvas/domain/canvasNodes";

type UpdateNodeData = (nodeId: string, data: Partial<CanvasNodeData>) => void;

interface UseDebouncedNodeTextCommitOptions {
  nodeId: string;
  field: "prompt" | "purpose" | "content" | "optimizedPrompt";
  valueRef: MutableRefObject<string>;
  updateNodeData: UpdateNodeData;
  delayMs?: number;
}

/**
 * A canvas update snapshots history and triggers persistence. Keep the text
 * local during an active typing burst, then commit it once after a short pause.
 */
export function useDebouncedNodeTextCommit({
  nodeId,
  field,
  valueRef,
  updateNodeData,
  delayMs = 480,
}: UseDebouncedNodeTextCommitOptions) {
  const timeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const hasPendingCommitRef = useRef(false);

  const cancelCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    hasPendingCommitRef.current = false;
  }, []);

  const flushCommit = useCallback(() => {
    if (!hasPendingCommitRef.current) {
      return;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    hasPendingCommitRef.current = false;
    updateNodeData(nodeId, { [field]: valueRef.current } as Partial<CanvasNodeData>);
  }, [field, nodeId, updateNodeData, valueRef]);

  const scheduleCommit = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    hasPendingCommitRef.current = true;
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      flushCommit();
    }, delayMs);
  }, [delayMs, flushCommit]);

  useEffect(() => () => flushCommit(), [flushCommit]);

  return { cancelCommit, flushCommit, scheduleCommit };
}
