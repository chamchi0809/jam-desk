// =============================================================================
// Live settings mirror. The extension host pushes the user's configuration
// (contributes.configuration) into the webview; modules read these getters so
// behaviour tracks `jamDesk.*` settings without re-wiring listeners.
// =============================================================================

export type GridStyle = 'dots' | 'lines' | 'none'

/** A user-defined toolbar button that opens a terminal running `command`. */
export interface LauncherButton {
  label: string
  command: string
}

export interface CanvasSettings {
  gridStyle: GridStyle
  snapToGrid: boolean
  zoomSpeed: number
  showMinimap: boolean
  // Launcher buttons split by config scope; the toolbar shows both.
  customLaunchersGlobal: LauncherButton[]
  customLaunchersWorkspace: LauncherButton[]
}

export const settings: CanvasSettings = {
  gridStyle: 'dots',
  snapToGrid: true,
  zoomSpeed: 1,
  showMinimap: true,
  customLaunchersGlobal: [],
  customLaunchersWorkspace: [],
}

/** Keep only well-formed, non-empty launcher entries from user-authored config. */
function cleanLaunchers(value: unknown): LauncherButton[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (l): l is LauncherButton =>
      !!l && typeof l.label === 'string' && typeof l.command === 'string' && l.label.trim() !== '',
  )
}

export function applySettings(partial: Partial<CanvasSettings>): void {
  if (partial.gridStyle != null) settings.gridStyle = partial.gridStyle
  if (partial.snapToGrid != null) settings.snapToGrid = partial.snapToGrid
  if (typeof partial.zoomSpeed === 'number' && partial.zoomSpeed > 0) settings.zoomSpeed = partial.zoomSpeed
  if (partial.showMinimap != null) settings.showMinimap = partial.showMinimap
  if ('customLaunchersGlobal' in partial) settings.customLaunchersGlobal = cleanLaunchers(partial.customLaunchersGlobal)
  if ('customLaunchersWorkspace' in partial)
    settings.customLaunchersWorkspace = cleanLaunchers(partial.customLaunchersWorkspace)
}
