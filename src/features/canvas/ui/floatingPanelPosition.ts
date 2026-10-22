export interface FloatingPanelPosition {
  left: number;
  top: number;
}

interface FloatingPanelPositionOptions {
  align?: "start" | "center";
  preferredSide?: "above" | "below";
  fallbackSize: { width: number; height: number };
}

const VIEWPORT_MARGIN = 16;
const TRIGGER_GAP = 8;

/** Positions a document-level panel beside its trigger without leaving the viewport. */
export function getFloatingPanelPosition(
  triggerElement: HTMLElement | null,
  panelElement: HTMLElement | null,
  { align = "start", preferredSide = "below", fallbackSize }: FloatingPanelPositionOptions,
): FloatingPanelPosition | null {
  if (!triggerElement || typeof window === "undefined") {
    return null;
  }

  const triggerRect = triggerElement.getBoundingClientRect();
  const panelWidth = panelElement?.offsetWidth || fallbackSize.width;
  const panelHeight = panelElement?.offsetHeight || fallbackSize.height;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - panelWidth - VIEWPORT_MARGIN);
  const desiredLeft = align === "center" ? triggerRect.left + triggerRect.width / 2 - panelWidth / 2 : triggerRect.left;
  const left = Math.min(Math.max(VIEWPORT_MARGIN, desiredLeft), maxLeft);
  const spaceAbove = triggerRect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
  const spaceBelow = viewportHeight - triggerRect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
  const shouldOpenAbove =
    preferredSide === "above"
      ? spaceAbove >= panelHeight || spaceAbove >= spaceBelow
      : spaceAbove > spaceBelow && spaceBelow < panelHeight;
  const desiredTop = shouldOpenAbove ? triggerRect.top - TRIGGER_GAP - panelHeight : triggerRect.bottom + TRIGGER_GAP;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - panelHeight - VIEWPORT_MARGIN);

  return {
    left,
    top: Math.min(Math.max(VIEWPORT_MARGIN, desiredTop), maxTop),
  };
}
