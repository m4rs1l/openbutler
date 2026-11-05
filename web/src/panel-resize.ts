export const PANEL_DEFAULT_WIDTH = 440;
export const PANEL_MIN_WIDTH = PANEL_DEFAULT_WIDTH;
export const PANEL_CLOSE_THRESHOLD = 96;

export const SIDEBAR_DEFAULT_WIDTH = 252;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 560;
/** The conversation keeps at least this much beside the sidebar, so a drag cannot eat it. */
export const SIDEBAR_CHAT_MIN_WIDTH = 480;
export const SIDEBAR_CLOSE_THRESHOLD = 96;

export interface SnapResizeParams {
  initialWidth: number;
  distance: number;
  minWidth: number;
  maxWidth: number;
  closeThreshold?: number;
}

/**
 * Shared edge resizing and snap-close calculation:
 * - When dragged in shrinking direction (distance < 0) past closeThreshold, snaps to 0.
 * - Otherwise clamps width between minWidth and maxWidth.
 * - An already-closed panel (initialWidth <= 0) cannot be dragged open.
 */
export function resolveSnapResize({ initialWidth, distance, minWidth, maxWidth, closeThreshold = 96 }: SnapResizeParams): {
  size: number;
  snap: boolean;
} {
  if (initialWidth <= 0) return { size: 0, snap: false };
  const size = Math.max(0, Math.min(maxWidth, initialWidth + distance));
  if (distance < 0 && size <= Math.min(closeThreshold, maxWidth)) return { size: 0, snap: true };
  return { size: Math.min(maxWidth, Math.max(minWidth, size)), snap: false };
}

/** Right panel resizing policy: snaps closed below PANEL_CLOSE_THRESHOLD. */
export function resolvePanelResize(initialWidth: number, distance: number, maximum: number) {
  return resolveSnapResize({
    initialWidth,
    distance,
    minWidth: PANEL_MIN_WIDTH,
    maxWidth: maximum,
    closeThreshold: PANEL_CLOSE_THRESHOLD,
  });
}

/** Sidebar resizing policy: snaps closed below SIDEBAR_CLOSE_THRESHOLD. */
export function resolveSidebarResize(initialWidth: number, distance: number, maximum: number): { size: number; snap: boolean } {
  const cap = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, maximum));
  return resolveSnapResize({
    initialWidth,
    distance,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: cap,
    closeThreshold: SIDEBAR_CLOSE_THRESHOLD,
  });
}
