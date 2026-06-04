// =============================================================================
// Live settings mirror. The extension host pushes the user's configuration
// (contributes.configuration) into the webview; modules read these getters so
// behaviour tracks `cateCanvas.*` settings without re-wiring listeners.
// =============================================================================

export type GridStyle = 'dots' | 'lines' | 'none'

export interface CanvasSettings {
  gridStyle: GridStyle
  snapToGrid: boolean
  zoomSpeed: number
  showMinimap: boolean
}

export const settings: CanvasSettings = {
  gridStyle: 'dots',
  snapToGrid: true,
  zoomSpeed: 1,
  showMinimap: true,
}

export function applySettings(partial: Partial<CanvasSettings>): void {
  if (partial.gridStyle != null) settings.gridStyle = partial.gridStyle
  if (partial.snapToGrid != null) settings.snapToGrid = partial.snapToGrid
  if (typeof partial.zoomSpeed === 'number' && partial.zoomSpeed > 0) settings.zoomSpeed = partial.zoomSpeed
  if (partial.showMinimap != null) settings.showMinimap = partial.showMinimap
}
