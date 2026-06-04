// =============================================================================
// Shared types & constants for the Cate Canvas webview.
// Geometry primitives, node/region models, and zoom/grid constants are ported
// faithfully from the Cate IDE (src/shared/types.ts, layoutEngine.ts).
//
// The Cate node "content" (editor / browser / agent panels) is deeply
// Electron-coupled, so here a node hosts VS Code-friendly content: a free-text
// *note*, a *file card* that opens a workspace file in the editor, or a live
// *terminal* (xterm.js in the webview ⇄ a node-pty shell in the extension host,
// mirroring Cate's terminal architecture).
// =============================================================================

// ---- Geometry primitives (ported verbatim from Cate) ------------------------

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  origin: Point
  size: Size
}

// ---- Node content kinds (VS Code adaptation) --------------------------------

export type NodeKind = 'note' | 'file' | 'terminal'

export type CanvasNodeId = string

export interface CanvasNodeState {
  id: CanvasNodeId
  kind: NodeKind
  /** Note body (markdown-ish plain text) for `note` nodes. */
  text?: string
  /** Workspace-relative path for `file` nodes. */
  filePath?: string
  /** Optional starting working directory for `terminal` nodes (absolute or
   *  workspace-relative). Defaults to the workspace root on the host. */
  cwd?: string
  /** Display title — note heading or file basename. */
  title: string
  /** Optional accent color (CSS color string). */
  color?: string
  origin: Point
  size: Size
  zOrder: number
  creationIndex: number
  preMaximizeOrigin?: Point
  preMaximizeSize?: Size
  isPinned?: boolean
  animationState?: 'entering' | 'exiting' | 'idle'
  regionId?: string
}

/** Mirrors Cate's `isMaximized` computed helper. */
export function isMaximized(node: CanvasNodeState): boolean {
  return node.preMaximizeOrigin != null
}

// ---- Region (group container, ported from Cate) -----------------------------

export interface CanvasRegion {
  id: string
  origin: Point
  size: Size
  label: string
  color: string
  zOrder: number
}

// ---- Snap guide lines --------------------------------------------------------

export interface SnapLine {
  axis: 'x' | 'y'
  position: number
  type: 'edge' | 'center'
}

export interface SnapGuides {
  lines: SnapLine[]
}

// ---- Persisted canvas document ----------------------------------------------

export interface CanvasDocument {
  version: 2
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  nextZOrder: number
  nextCreationIndex: number
}

// ---- Tools -------------------------------------------------------------------

export type CanvasTool = 'select' | 'hand'

// ---- Zoom constants (from Cate CanvasState.swift) ---------------------------

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 3.0
export const ZOOM_DEFAULT = 1.0

// ---- Grid (from Cate layoutEngine.ts) ---------------------------------------

/** Canvas-space spacing of the snap/background grid, in canvas units. */
export const CANVAS_GRID_SIZE = 20

// ---- Per-kind default / minimum sizes ---------------------------------------

export const NODE_DEFAULT_SIZES: Record<NodeKind, Size> = {
  note: { width: 280, height: 200 },
  file: { width: 320, height: 160 },
  terminal: { width: 520, height: 340 },
}

export const NODE_MINIMUM_SIZES: Record<NodeKind, Size> = {
  note: { width: 140, height: 100 },
  file: { width: 200, height: 92 },
  terminal: { width: 240, height: 140 },
}

/** A palette of accent colors offered for notes & regions (RGBA so the minimap
 *  can derive translucent fills, matching Cate's REGION_FILL_COLORS approach). */
export const ACCENT_COLORS: string[] = [
  'rgba(74, 158, 255, 1)',
  'rgba(120, 200, 120, 1)',
  'rgba(240, 180, 90, 1)',
  'rgba(220, 110, 110, 1)',
  'rgba(180, 130, 230, 1)',
  'rgba(120, 200, 220, 1)',
  'rgba(150, 150, 160, 1)',
]
