// =============================================================================
// Canvas store — a framework-free reactive state container.
//
// Ported from the upstream IDE's Zustand store (renderer/stores/canvasStore.ts). The
// reactive primitive mimics Zustand's shallow-merge semantics: each set()
// produces a NEW top-level state object while preserving the identity of nested
// values that did not change. That lets subscribers cheaply diff which slice
// moved — `next.nodes !== prev.nodes` means a node mutated; `next.viewportOffset
// !== prev.viewportOffset` means the camera panned — and update only the DOM
// that the change touches.
// =============================================================================

import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  CANVAS_GRID_SIZE,
  ACCENT_COLORS,
  NODE_MINIMUM_SIZES,
} from './types'
import type {
  Point,
  Size,
  Rect,
  NodeKind,
  CanvasNodeId,
  CanvasNodeState,
  CanvasRegion,
  CanvasDocument,
  CanvasTool,
  SnapGuides,
  AgentKind,
  AgentActivity,
  TerminalAgentState,
} from './types'
import { viewToCanvas as viewToCanvasCoords } from './coordinates'
import { findFreePosition, defaultSize, autoLayoutAll } from './layout'
import { t } from './i18n'

/** Screen-space top margin (in px) that the floating toolbar occupies (top:12 +
 * ~38px button height + breathing room). Tile/maximize layouts reserve this much
 * at the top of the viewport so tiled nodes' title bars aren't hidden behind it. */
const TOOLBAR_TOP_RESERVE = 56

// -----------------------------------------------------------------------------
// State shape (data only — actions live as methods on the store object)
// -----------------------------------------------------------------------------

export interface CanvasData {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  /** Increments on every focus action — lets views re-run focus side effects
   *  even when focusedNodeId itself does not change. */
  focusEpoch: number
  nextZOrder: number
  nextCreationIndex: number
  containerSize: Size
  snapGuides: SnapGuides
  selectedNodeIds: Set<string>
  selectedRegionIds: Set<string>
  /** Region currently hovered as a drop target during a node drag. */
  dropTargetRegionId: string | null
  /** Active tool (select | hand). Pan-everywhere with the hand tool. */
  tool: CanvasTool
  /** Per-terminal coding-agent status (Claude Code / Codex). Ephemeral —
   *  excluded from toDocument() and reset on load. */
  agents: Record<CanvasNodeId, TerminalAgentState>
  history: CanvasHistoryEntry[]
  future: CanvasHistoryEntry[]
}

export interface CanvasHistoryEntry {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  focusedNodeId: CanvasNodeId | null
}

export type Listener = (data: CanvasData, prev: CanvasData) => void

/** Props supplied when creating a node (kind-specific content). */
export interface NewNodeProps {
  title?: string
  text?: string
  filePath?: string
  cwd?: string
  color?: string
  /** Initial URL for a `browser` node. */
  url?: string
  /** A command auto-run in a new terminal once its shell settles (agent launchers). */
  initialCommand?: string
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID.
  return 'id-' + Math.abs(Math.floor(Math.random() * 1e9)).toString(36) + '-' + Math.abs(Math.floor(Math.random() * 1e9)).toString(36)
}

function defaultTitle(kind: NodeKind): string {
  switch (kind) {
    case 'note':
      return t('defaultNote')
    case 'terminal':
      return t('defaultTerminal')
    case 'browser':
      return t('defaultBrowser')
    default:
      return t('defaultFile')
  }
}

const clampZoom = (z: number) => Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX)

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export class CanvasStore {
  private data: CanvasData
  private listeners = new Set<Listener>()
  private activeZoomRaf = 0

  constructor() {
    this.data = {
      nodes: {},
      regions: {},
      viewportOffset: { x: 0, y: 0 },
      zoomLevel: ZOOM_DEFAULT,
      focusedNodeId: null,
      focusEpoch: 0,
      nextZOrder: 0,
      nextCreationIndex: 0,
      containerSize: { width: 0, height: 0 },
      snapGuides: { lines: [] },
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      dropTargetRegionId: null,
      tool: 'select',
      agents: {},
      history: [],
      future: [],
    }
  }

  // ---- Reactive core --------------------------------------------------------

  getState(): CanvasData {
    return this.data
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Shallow-merge a partial into state and notify subscribers with (next, prev).
   *  Returning the current data object (===) from a functional updater is a no-op. */
  private set(updater: Partial<CanvasData> | ((s: CanvasData) => Partial<CanvasData>)): void {
    const partial = typeof updater === 'function' ? updater(this.data) : updater
    if (partial == null || partial === (this.data as unknown as Partial<CanvasData>)) return
    const prev = this.data
    this.data = { ...this.data, ...partial }
    for (const l of this.listeners) l(this.data, prev)
  }

  // ---- Undo / redo ----------------------------------------------------------

  /**
   * Snapshot nodes for a history entry, dropping transient animation state the
   * same way `toDocument()` does. Without this a snapshot taken while a node is
   * mid-exit (the 200 ms removal animation) would capture `animationState:
   * 'exiting'`; a later undo would resurrect that node, re-mount it (re-spawning
   * a terminal PTY), then immediately re-run the exit timer and kill it again.
   */
  private snapshotNodes(
    nodes: Record<CanvasNodeId, CanvasNodeState>,
  ): Record<CanvasNodeId, CanvasNodeState> {
    const out: Record<CanvasNodeId, CanvasNodeState> = {}
    for (const [id, node] of Object.entries(nodes)) {
      if (node.animationState === 'exiting') continue
      let n =
        node.animationState && node.animationState !== 'idle'
          ? { ...node, animationState: 'idle' as const }
          : node
      // A one-shot launcher command is already consumed by the live terminal;
      // drop it so a later undo→redo does not re-spawn the agent.
      if (n.initialCommand != null) {
        n = { ...n }
        delete n.initialCommand
      }
      out[id] = n
    }
    return out
  }

  pushHistory(): void {
    const state = this.data
    const entry: CanvasHistoryEntry = {
      nodes: this.snapshotNodes(state.nodes),
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    const MAX = 100
    const history =
      state.history.length >= MAX
        ? [...state.history.slice(1), entry]
        : [...state.history, entry]
    this.set({ history, future: [] })
  }

  undo(): void {
    const state = this.data
    if (state.history.length === 0) return
    const prev = state.history[state.history.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: this.snapshotNodes(state.nodes),
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    this.set({
      nodes: prev.nodes,
      regions: prev.regions,
      // Keep the user's current focus across undo instead of restoring the
      // historical one. Re-focusing (often onto a terminal) would pull DOM focus
      // into xterm, so the next Ctrl+Z gets swallowed by the terminal and undo
      // appears to stop. Clear only if the focused node no longer exists.
      focusedNodeId: this.keepFocusIn(prev.nodes),
      history: state.history.slice(0, -1),
      future: [...state.future, current],
    })
  }

  /** The current focus, retained only if that node survives in `nodes`. */
  private keepFocusIn(nodes: Record<CanvasNodeId, CanvasNodeState>): CanvasNodeId | null {
    const id = this.data.focusedNodeId
    return id && nodes[id] ? id : null
  }

  redo(): void {
    const state = this.data
    if (state.future.length === 0) return
    const next = state.future[state.future.length - 1]
    const current: CanvasHistoryEntry = {
      nodes: this.snapshotNodes(state.nodes),
      regions: state.regions,
      focusedNodeId: state.focusedNodeId,
    }
    this.set({
      nodes: next.nodes,
      regions: next.regions,
      // Preserve current focus across redo too (see undo()).
      focusedNodeId: this.keepFocusIn(next.nodes),
      history: [...state.history, current],
      future: state.future.slice(0, -1),
    })
  }

  clearHistory(): void {
    this.set({ history: [], future: [] })
  }

  // ---- Node mutations -------------------------------------------------------

  addNode(kind: NodeKind, props: NewNodeProps = {}, position?: Point, size?: Size): CanvasNodeId {
    this.pushHistory()
    const state = this.data
    const sz = size ?? defaultSize(kind)
    const origin = findFreePosition(state.nodes, state.focusedNodeId, sz, position)
    const nodeId = generateId()

    const node: CanvasNodeState = {
      id: nodeId,
      kind,
      title: props.title ?? defaultTitle(kind),
      text: props.text,
      filePath: props.filePath,
      cwd: props.cwd,
      url: props.url,
      color: props.color,
      initialCommand: props.initialCommand,
      origin,
      size: sz,
      zOrder: state.nextZOrder,
      creationIndex: state.nextCreationIndex,
      animationState: 'entering',
    }

    this.set({
      nodes: { ...state.nodes, [nodeId]: node },
      nextZOrder: state.nextZOrder + 1,
      nextCreationIndex: state.nextCreationIndex + 1,
      focusedNodeId: nodeId,
      focusEpoch: state.focusEpoch + 1,
    })
    return nodeId
  }

  removeNode(id: CanvasNodeId): void {
    if (this.data.nodes[id]?.isPinned) return // ponytail: pinned panels can't be deleted
    if (this.data.nodes[id]) this.pushHistory()
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [id]: { ...node, animationState: 'exiting' as const } },
        focusedNodeId: state.focusedNodeId === id ? null : state.focusedNodeId,
      }
    })
  }

  finalizeRemoveNode(nodeId: CanvasNodeId): void {
    const { [nodeId]: _omit, ...rest } = this.data.nodes
    const partial: Partial<CanvasData> = { nodes: rest }
    if (this.data.agents[nodeId]) {
      const { [nodeId]: _agent, ...agentsRest } = this.data.agents
      partial.agents = agentsRest
    }
    this.set(partial)
  }

  // ---- Terminal agent status (ephemeral) -------------------------------------

  /** Merge a partial agent-status update for a terminal node. `agent` comes
   * from the host's PTY process scan; `activity` / `oscTitle` from the node's
   * xterm. No-op patches (nothing actually changed) do not notify. */
  updateTerminalAgent(
    id: CanvasNodeId,
    patch: { agent?: AgentKind | null; activity?: AgentActivity; oscTitle?: string },
  ): void {
    const state = this.data
    if (!state.nodes[id]) return
    const prev = state.agents[id] ?? { agent: null, activity: 'idle' as AgentActivity }
    let next = prev
    if (patch.agent !== undefined && patch.agent !== next.agent) {
      next = {
        ...next,
        agent: patch.agent,
        agentSince: patch.agent ? Date.now() : undefined,
        // A vanished agent leaves no meaningful activity behind.
        ...(patch.agent ? {} : { activity: 'idle' as AgentActivity }),
      }
    }
    if (patch.activity !== undefined && patch.activity !== next.activity) {
      next = { ...next, activity: patch.activity }
    }
    if (patch.oscTitle !== undefined && patch.oscTitle !== next.oscTitle) {
      next = { ...next, oscTitle: patch.oscTitle, oscTitleAt: Date.now() }
    }
    if (next === prev) return
    this.set({ agents: { ...state.agents, [id]: next } })
  }

  setNodeAnimationState(nodeId: CanvasNodeId, animationState: 'entering' | 'exiting' | 'idle'): void {
    const node = this.data.nodes[nodeId]
    if (node) {
      this.set({ nodes: { ...this.data.nodes, [nodeId]: { ...node, animationState } } })
    }
  }

  moveNode(id: CanvasNodeId, origin: Point): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return { nodes: { ...state.nodes, [id]: { ...node, origin } } }
    })
  }

  resizeNode(id: CanvasNodeId, size: Size, origin?: Point): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: {
          ...state.nodes,
          [id]: { ...node, size, ...(origin != null ? { origin } : {}) },
        },
      }
    })
  }

  /** Update editable note text (or file title). Does not push history per keystroke. */
  setNodeText(id: CanvasNodeId, text: string): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return { nodes: { ...state.nodes, [id]: { ...node, text } } }
    })
  }

  /** Set a `browser` node's current URL. Navigation is not an undo step (the
   *  iframe keeps its own forward/back), so this does not push history. */
  setNodeUrl(id: CanvasNodeId, url: string): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node || node.url === url) return state
      return { nodes: { ...state.nodes, [id]: { ...node, url } } }
    })
  }

  /** Set a `browser` node's embedded-page zoom (clamped 0.25–3). Not an undo
   *  step — it's a view preference, like the canvas zoom. */
  setNodeBrowserZoom(id: CanvasNodeId, zoom: number): void {
    const clamped = Math.min(3, Math.max(0.25, Math.round(zoom * 100) / 100))
    this.set((state) => {
      const node = state.nodes[id]
      if (!node || node.browserZoom === clamped) return state
      return { nodes: { ...state.nodes, [id]: { ...node, browserZoom: clamped } } }
    })
  }

  setNodeTitle(id: CanvasNodeId, title: string): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return { nodes: { ...state.nodes, [id]: { ...node, title } } }
    })
  }

  setNodeColor(id: CanvasNodeId, color: string | undefined): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return { nodes: { ...state.nodes, [id]: { ...node, color } } }
    })
  }

  focusNode(id: CanvasNodeId): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [id]: { ...node, zOrder: state.nextZOrder } },
        nextZOrder: state.nextZOrder + 1,
        focusedNodeId: id,
        focusEpoch: state.focusEpoch + 1,
      }
    })
  }

  unfocus(): void {
    this.set({ focusedNodeId: null })
  }

  toggleMaximize(id: CanvasNodeId, viewportSize: Size): void {
    const state = this.data
    const node = state.nodes[id]
    if (!node) return

    const isMax = node.preMaximizeOrigin != null
    let updated: CanvasNodeState
    if (isMax) {
      updated = {
        ...node,
        origin: node.preMaximizeOrigin!,
        size: node.preMaximizeSize!,
        preMaximizeOrigin: undefined,
        preMaximizeSize: undefined,
      }
    } else {
      const cs = state.containerSize
      const topLeft = this.viewToCanvas({ x: 0, y: 0 })
      const bottomRight = this.viewToCanvas({
        x: cs.width || viewportSize.width,
        y: cs.height || viewportSize.height,
      })
      const padding = 20 / state.zoomLevel
      // Reserve the toolbar strip at the top so a maximized node's title bar
      // (and its buttons) stay clear of the floating toolbar.
      const topInset = TOOLBAR_TOP_RESERVE / state.zoomLevel
      updated = {
        ...node,
        preMaximizeOrigin: { ...node.origin },
        preMaximizeSize: { ...node.size },
        origin: { x: topLeft.x + padding, y: topLeft.y + topInset },
        size: {
          width: bottomRight.x - topLeft.x - padding * 2,
          height: bottomRight.y - topLeft.y - topInset - padding,
        },
      }
    }
    updated = { ...updated, zOrder: state.nextZOrder }
    this.set({
      nodes: { ...state.nodes, [id]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: id,
      focusEpoch: state.focusEpoch + 1,
    })
  }

  togglePin(id: CanvasNodeId): void {
    this.set((state) => {
      const node = state.nodes[id]
      if (!node) return state
      return { nodes: { ...state.nodes, [id]: { ...node, isPinned: !node.isPinned } } }
    })
  }

  moveToFront(nodeId: CanvasNodeId): void {
    this.set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return {
        nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: state.nextZOrder } },
        nextZOrder: state.nextZOrder + 1,
      }
    })
  }

  moveToBack(nodeId: CanvasNodeId): void {
    this.set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      const minZOrder = Object.values(state.nodes).reduce(
        (min, n) => Math.min(min, n.zOrder),
        Infinity,
      )
      return { nodes: { ...state.nodes, [nodeId]: { ...node, zOrder: minZOrder - 1 } } }
    })
  }

  // ---- Viewport / zoom ------------------------------------------------------

  cancelZoomAnimation(): void {
    if (this.activeZoomRaf) {
      cancelAnimationFrame(this.activeZoomRaf)
      this.activeZoomRaf = 0
    }
  }

  setZoom(level: number): void {
    this.set({ zoomLevel: clampZoom(level) })
  }

  setViewportOffset(offset: Point): void {
    this.set({ viewportOffset: offset })
  }

  setZoomAndOffset(zoom: number, offset: Point): void {
    this.set({ zoomLevel: clampZoom(zoom), viewportOffset: offset })
  }

  setContainerSize(size: Size): void {
    this.set({ containerSize: size })
  }

  setTool(tool: CanvasTool): void {
    this.set({ tool })
  }

  /** Zoom keeping the viewport center anchored. */
  zoomAroundCenter(newZoom: number): void {
    const state = this.data
    const clamped = clampZoom(newZoom)
    if (clamped === state.zoomLevel) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) {
      this.set({ zoomLevel: clamped })
      return
    }
    const centerView = { x: cs.width / 2, y: cs.height / 2 }
    const centerCanvas = {
      x: (centerView.x - state.viewportOffset.x) / state.zoomLevel,
      y: (centerView.y - state.viewportOffset.y) / state.zoomLevel,
    }
    this.set({
      zoomLevel: clamped,
      viewportOffset: {
        x: centerView.x - centerCanvas.x * clamped,
        y: centerView.y - centerCanvas.y * clamped,
      },
    })
  }

  /** Smoothly animate to a target zoom, anchored at the viewport center
   *  (lerp 0.15/frame, matching the upstream IDE). */
  animateZoomTo(targetZoom: number): void {
    this.cancelZoomAnimation()
    const clampedTarget = clampZoom(targetZoom)

    const tick = () => {
      const state = this.data
      const diff = clampedTarget - state.zoomLevel
      const centerX = (state.containerSize.width || window.innerWidth) / 2
      const centerY = (state.containerSize.height || window.innerHeight) / 2

      if (Math.abs(diff) < 0.001) {
        const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
        this.set({
          zoomLevel: clampedTarget,
          viewportOffset: {
            x: centerX - canvasPoint.x * clampedTarget,
            y: centerY - canvasPoint.y * clampedTarget,
          },
        })
        this.activeZoomRaf = 0
        return
      }

      const newZoom = state.zoomLevel + diff * 0.15
      const canvasPoint = viewToCanvasCoords({ x: centerX, y: centerY }, state.zoomLevel, state.viewportOffset)
      this.set({
        zoomLevel: newZoom,
        viewportOffset: {
          x: centerX - canvasPoint.x * newZoom,
          y: centerY - canvasPoint.y * newZoom,
        },
      })
      this.activeZoomRaf = requestAnimationFrame(tick)
    }

    this.activeZoomRaf = requestAnimationFrame(tick)
  }

  resetView(): void {
    this.cancelZoomAnimation()
    this.set({ zoomLevel: ZOOM_DEFAULT, viewportOffset: { x: 0, y: 0 } })
  }

  // ---- Derived getters ------------------------------------------------------

  canvasToView(point: Point): Point {
    const { zoomLevel, viewportOffset } = this.data
    return { x: point.x * zoomLevel + viewportOffset.x, y: point.y * zoomLevel + viewportOffset.y }
  }

  viewToCanvas(point: Point): Point {
    const { zoomLevel, viewportOffset } = this.data
    const safeZoom = Number.isFinite(zoomLevel) && zoomLevel > 0.01 ? zoomLevel : 0.01
    return { x: (point.x - viewportOffset.x) / safeZoom, y: (point.y - viewportOffset.y) / safeZoom }
  }

  viewFrame(nodeId: CanvasNodeId): Rect | null {
    const { nodes, zoomLevel } = this.data
    const node = nodes[nodeId]
    if (!node) return null
    const viewOrigin = this.canvasToView(node.origin)
    return {
      origin: viewOrigin,
      size: { width: node.size.width * zoomLevel, height: node.size.height * zoomLevel },
    }
  }

  sortedNodesByCreationOrder(): CanvasNodeState[] {
    return Object.values(this.data.nodes).sort((a, b) => a.creationIndex - b.creationIndex)
  }

  nextNode(): CanvasNodeId | null {
    const { focusedNodeId } = this.data
    const sorted = this.sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[0].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[0].id
    return sorted[(index + 1) % sorted.length].id
  }

  previousNode(): CanvasNodeId | null {
    const { focusedNodeId } = this.data
    const sorted = this.sortedNodesByCreationOrder()
    if (sorted.length === 0) return null
    if (!focusedNodeId) return sorted[sorted.length - 1].id
    const index = sorted.findIndex((n) => n.id === focusedNodeId)
    if (index === -1) return sorted[sorted.length - 1].id
    return sorted[(index - 1 + sorted.length) % sorted.length].id
  }

  // ---- Focus + navigation ---------------------------------------------------

  focusAndCenter(nodeId: CanvasNodeId): void {
    const state = this.data
    const node = state.nodes[nodeId]
    if (!node) return
    const updated = { ...node, zOrder: state.nextZOrder }
    const cs = state.containerSize
    const zoom = state.zoomLevel
    const next: Partial<CanvasData> = {
      nodes: { ...state.nodes, [nodeId]: updated },
      nextZOrder: state.nextZOrder + 1,
      focusedNodeId: nodeId,
      focusEpoch: state.focusEpoch + 1,
    }
    if (cs.width > 0 && cs.height > 0) {
      next.viewportOffset = {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      }
    }
    this.set(next)
  }

  navigateDirection(dir: 'up' | 'down' | 'left' | 'right'): void {
    const state = this.data
    const nodeList = Object.values(state.nodes)
    if (nodeList.length === 0) return

    const current = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
    let refX: number
    let refY: number
    if (current) {
      refX = current.origin.x + current.size.width / 2
      refY = current.origin.y + current.size.height / 2
    } else {
      const cs = state.containerSize
      const center = this.viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
      refX = center.x
      refY = center.y
    }

    let best: CanvasNodeState | null = null
    let bestScore = Infinity
    for (const n of nodeList) {
      if (current && n.id === current.id) continue
      const dx = n.origin.x + n.size.width / 2 - refX
      const dy = n.origin.y + n.size.height / 2 - refY
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)

      let inCone: boolean
      let score: number
      if (dir === 'left') {
        inCone = dx < 0 && adx >= ady
        score = adx + 2 * ady
      } else if (dir === 'right') {
        inCone = dx > 0 && adx >= ady
        score = adx + 2 * ady
      } else if (dir === 'up') {
        inCone = dy < 0 && ady >= adx
        score = ady + 2 * adx
      } else {
        inCone = dy > 0 && ady >= adx
        score = ady + 2 * adx
      }
      if (!inCone) continue
      if (score < bestScore) {
        bestScore = score
        best = n
      }
    }
    if (best) this.focusAndCenter(best.id)
  }

  // ---- Zoom to fit / selection ----------------------------------------------

  zoomToFit(): void {
    const state = this.data
    const nodeList = Object.values(state.nodes)
    // Frames nodes only, like the upstream IDE: an empty (or regions-only) canvas is a no-op.
    if (nodeList.length === 0) return
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    const xs: number[] = []
    const ys: number[] = []
    const xe: number[] = []
    const ye: number[] = []
    for (const n of nodeList) {
      xs.push(n.origin.x); ys.push(n.origin.y)
      xe.push(n.origin.x + n.size.width); ye.push(n.origin.y + n.size.height)
    }
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xe)
    const maxY = Math.max(...ye)

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    const zoom = clampZoom(Math.min(cs.width / contentW, cs.height / contentH))

    this.set({
      zoomLevel: zoom,
      viewportOffset: {
        x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
        y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
      },
    })
  }

  zoomToSelection(): void {
    const state = this.data
    const cs = state.containerSize
    if (cs.width === 0 || cs.height === 0) return

    let target = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (target.length === 0) {
      const focused = state.focusedNodeId ? state.nodes[state.focusedNodeId] : null
      if (focused) target = [focused]
    }
    if (target.length === 0) {
      this.zoomToFit()
      return
    }

    const minX = Math.min(...target.map((n) => n.origin.x))
    const minY = Math.min(...target.map((n) => n.origin.y))
    const maxX = Math.max(...target.map((n) => n.origin.x + n.size.width))
    const maxY = Math.max(...target.map((n) => n.origin.y + n.size.height))

    const padding = 60
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    const fitZoom = Math.min(cs.width / contentW, cs.height / contentH)
    const maxZoom = target.length === 1 ? Math.min(ZOOM_MAX, 1.5) : ZOOM_MAX
    const zoom = Math.min(Math.max(fitZoom, ZOOM_MIN), maxZoom)

    this.set({
      zoomLevel: zoom,
      viewportOffset: {
        x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
        y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
      },
    })
  }

  // ---- Snap guides ----------------------------------------------------------

  setSnapGuides(guides: SnapGuides): void {
    this.set({ snapGuides: guides })
  }

  clearSnapGuides(): void {
    if (this.data.snapGuides.lines.length === 0) return
    this.set({ snapGuides: { lines: [] } })
  }

  setDropTargetRegion(regionId: string | null): void {
    if (this.data.dropTargetRegionId === regionId) return
    this.set({ dropTargetRegionId: regionId })
  }

  // ---- Selection ------------------------------------------------------------

  selectNodes(ids: string[], additive?: boolean): void {
    this.set((state) => {
      const next = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) next.add(id)
      return { selectedNodeIds: next }
    })
  }

  selectRegions(ids: string[], additive?: boolean): void {
    this.set((state) => {
      const nextRegions = additive ? new Set(state.selectedRegionIds) : new Set<string>()
      const nextNodes = additive ? new Set(state.selectedNodeIds) : new Set<string>()
      for (const id of ids) {
        nextRegions.add(id)
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  }

  clearSelection(): void {
    if (this.data.selectedNodeIds.size === 0 && this.data.selectedRegionIds.size === 0) return
    this.set({ selectedNodeIds: new Set<string>(), selectedRegionIds: new Set<string>() })
  }

  selectAll(): void {
    this.set((state) => ({
      selectedNodeIds: new Set(Object.keys(state.nodes)),
      selectedRegionIds: new Set(Object.keys(state.regions)),
    }))
  }

  toggleNodeSelection(id: string): void {
    this.set((state) => {
      const next = new Set(state.selectedNodeIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedNodeIds: next }
    })
  }

  toggleRegionSelection(id: string): void {
    this.set((state) => {
      const nextRegions = new Set(state.selectedRegionIds)
      const nextNodes = new Set(state.selectedNodeIds)
      if (nextRegions.has(id)) {
        nextRegions.delete(id)
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.delete(node.id)
        }
      } else {
        nextRegions.add(id)
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === id) nextNodes.add(node.id)
        }
      }
      return { selectedRegionIds: nextRegions, selectedNodeIds: nextNodes }
    })
  }

  deleteSelection(includeRegionContents?: boolean): void {
    const state = this.data
    if (state.selectedNodeIds.size > 0 || state.selectedRegionIds.size > 0) {
      this.pushHistory()
    }

    const nodeIdsToRemove = new Set(state.selectedNodeIds)
    for (const id of nodeIdsToRemove) {
      if (state.nodes[id]?.isPinned) nodeIdsToRemove.delete(id) // ponytail: keep pinned panels
    }
    if (!includeRegionContents && state.selectedRegionIds.size > 0) {
      for (const node of Object.values(state.nodes)) {
        if (node.regionId && state.selectedRegionIds.has(node.regionId)) {
          nodeIdsToRemove.delete(node.id)
        }
      }
    }
    for (const regionId of state.selectedRegionIds) {
      if (includeRegionContents) {
        for (const node of Object.values(state.nodes)) {
          if (node.regionId === regionId && !node.isPinned) nodeIdsToRemove.add(node.id)
        }
      }
    }

    // Mark nodes exiting (animation); the view finalizes removal on transition end.
    this.set((s) => {
      const nodes = { ...s.nodes }
      for (const nodeId of nodeIdsToRemove) {
        if (nodes[nodeId]) nodes[nodeId] = { ...nodes[nodeId], animationState: 'exiting' as const }
      }
      return {
        nodes,
        focusedNodeId:
          s.focusedNodeId && nodeIdsToRemove.has(s.focusedNodeId) ? null : s.focusedNodeId,
      }
    })

    this.set((s) => {
      const updatedNodes = { ...s.nodes }
      const updatedRegions = { ...s.regions }
      for (const regionId of state.selectedRegionIds) {
        if (!includeRegionContents) {
          for (const nodeId of Object.keys(updatedNodes)) {
            if (updatedNodes[nodeId].regionId === regionId) {
              updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
            }
          }
        }
        delete updatedRegions[regionId]
      }
      return {
        nodes: updatedNodes,
        regions: updatedRegions,
        selectedNodeIds: new Set<string>(),
        selectedRegionIds: new Set<string>(),
      }
    })
  }

  // ---- Auto layout ----------------------------------------------------------

  autoLayout(): void {
    const state = this.data
    const nodeList = Object.values(state.nodes).sort((a, b) => a.creationIndex - b.creationIndex)
    const regionList = Object.values(state.regions)
    if (nodeList.length === 0 && regionList.length === 0) return

    const containerWidth =
      state.containerSize.width > 0 ? state.containerSize.width / state.zoomLevel : 1600
    const containerHeight =
      state.containerSize.height > 0 ? state.containerSize.height / state.zoomLevel : 1000

    if (regionList.length === 0) {
      const gap = 6
      const n = nodeList.length
      const aspect = containerWidth / Math.max(containerHeight, 1)
      const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
      const rows = Math.ceil(n / cols)
      const cellW = Math.max(240, (containerWidth - gap * (cols + 1)) / cols)
      const maxCellH = cellW * 0.72
      const cellH = Math.min(maxCellH, Math.max(160, (containerHeight - gap * (rows + 1)) / rows))
      this.pushHistory()
      const updatedNodes = { ...state.nodes }
      nodeList.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[node.id] = {
          ...updatedNodes[node.id],
          origin: { x: gap + col * (cellW + gap), y: gap + row * (cellH + gap) },
          size: { width: cellW, height: cellH },
        }
      })
      this.set({ nodes: updatedNodes })
      this.zoomToFit()
      return
    }

    const result = autoLayoutAll({
      nodes: nodeList,
      regions: regionList,
      containerWidth,
      containerHeight,
      gap: 40,
    })

    this.pushHistory()
    const updatedNodes = { ...state.nodes }
    for (const [id, origin] of Object.entries(result.nodeOrigins)) {
      if (updatedNodes[id]) updatedNodes[id] = { ...updatedNodes[id], origin }
    }
    const updatedRegions = { ...state.regions }
    for (const [id, origin] of Object.entries(result.regionOrigins)) {
      if (!updatedRegions[id]) continue
      const size = result.regionSizes[id] ?? updatedRegions[id].size
      updatedRegions[id] = { ...updatedRegions[id], origin, size }
    }
    this.set({ nodes: updatedNodes, regions: updatedRegions })
    this.zoomToFit()
  }

  /**
   * Tile nodes into a fixed `cols × rows` grid that fills the current viewport,
   * like a window manager's split layouts (2-split, 3-split, 2×2). Tiles the
   * current selection if any, otherwise every node. Cells keep their on-screen
   * proportions regardless of zoom; nodes past `cols × rows` wrap into extra rows
   * below (same cell size), so a 2×2 still reads as 2×2 with more than four cards.
   */
  tileLayout(cols: number, rows: number): void {
    const state = this.data
    const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    const pool = selected.length > 0 ? selected : Object.values(state.nodes)
    const targets = pool
      .filter((n) => n.animationState !== 'exiting')
      .sort((a, b) => a.creationIndex - b.creationIndex)
    if (targets.length === 0) return

    // Visible viewport in canvas space (so the tiling fills the screen at any zoom).
    const cs = state.containerSize
    const zoom = state.zoomLevel
    const hasViewport = cs.width > 0 && cs.height > 0
    const tl = hasViewport ? this.viewToCanvas({ x: 0, y: 0 }) : { x: 100, y: 100 }
    const br = hasViewport
      ? this.viewToCanvas({ x: cs.width, y: cs.height })
      : { x: 100 + 1200, y: 100 + 800 }

    // Keep an ~constant on-screen gap by converting it to canvas units.
    const gap = 12 / zoom
    // Reserve room for the floating toolbar at the top so the top row's title
    // bars aren't hidden behind it.
    const topInset = TOOLBAR_TOP_RESERVE / zoom
    const areaX = tl.x + gap
    const areaY = tl.y + topInset
    const areaW = Math.max(br.x - tl.x - gap * 2, 100)
    const areaH = Math.max(br.y - tl.y - topInset - gap, 100)

    const cellW = (areaW - gap * (cols - 1)) / cols
    const cellH = (areaH - gap * (rows - 1)) / rows
    const w = Math.max(cellW, NODE_MINIMUM_SIZES.terminal.width)
    const h = Math.max(cellH, NODE_MINIMUM_SIZES.terminal.height)

    this.pushHistory()
    const updated = { ...state.nodes }
    targets.forEach((node, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      updated[node.id] = {
        ...updated[node.id],
        origin: { x: areaX + col * (cellW + gap), y: areaY + row * (cellH + gap) },
        size: { width: w, height: h },
        // Drop any stale maximize anchor so the maximize toggle stays consistent.
        preMaximizeOrigin: undefined,
        preMaximizeSize: undefined,
      }
    })
    this.set({ nodes: updated })
  }

  // ---- Region management ----------------------------------------------------

  addRegion(label: string, origin: Point, size: Size, color?: string): string {
    const id = generateId()
    const region: CanvasRegion = {
      id,
      origin,
      size,
      label,
      color: color || ACCENT_COLORS[0],
      zOrder: -1000,
    }
    this.set((state) => ({ regions: { ...state.regions, [id]: region } }))
    return id
  }

  removeRegion(id: string): void {
    this.set((state) => {
      const { [id]: _omit, ...rest } = state.regions
      return { regions: rest }
    })
  }

  moveRegion(id: string, origin: Point): void {
    this.set((state) => {
      const region = state.regions[id]
      if (!region) return state
      const dx = origin.x - region.origin.x
      const dy = origin.y - region.origin.y
      const updatedNodes = { ...state.nodes }
      for (const node of Object.values(state.nodes)) {
        if (node.regionId === id) {
          updatedNodes[node.id] = {
            ...node,
            origin: { x: node.origin.x + dx, y: node.origin.y + dy },
          }
        }
      }
      return {
        regions: { ...state.regions, [id]: { ...region, origin } },
        nodes: updatedNodes,
      }
    })
  }

  resizeRegion(id: string, size: Size, origin?: Point): void {
    this.set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return {
        regions: { ...state.regions, [id]: { ...region, size, ...(origin ? { origin } : {}) } },
      }
    })
  }

  /**
   * Translate every selected node and selected region by (dx, dy) in a single
   * update. Used by multi-region drag, where each entity is moved once (no
   * region→child cascade), so a selected region and its individually-selected
   * children both shift by the same delta without double-applying. Matches
   * the upstream IDE's multi-drag branch in CanvasRegionComponent.
   */
  translateSelection(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return
    this.set((state) => {
      const nodes = { ...state.nodes }
      for (const id of state.selectedNodeIds) {
        const n = state.nodes[id]
        if (n) nodes[id] = { ...n, origin: { x: n.origin.x + dx, y: n.origin.y + dy } }
      }
      const regions = { ...state.regions }
      for (const id of state.selectedRegionIds) {
        const r = state.regions[id]
        if (r) regions[id] = { ...r, origin: { x: r.origin.x + dx, y: r.origin.y + dy } }
      }
      return { nodes, regions }
    })
  }

  renameRegion(id: string, label: string): void {
    this.set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return { regions: { ...state.regions, [id]: { ...region, label } } }
    })
  }

  updateRegionColor(id: string, color: string): void {
    this.set((state) => {
      const region = state.regions[id]
      if (!region) return state
      return { regions: { ...state.regions, [id]: { ...region, color } } }
    })
  }

  // ---- Containment ----------------------------------------------------------

  setNodeRegion(nodeId: string, regionId: string | undefined): void {
    this.set((state) => {
      const node = state.nodes[nodeId]
      if (!node) return state
      return { nodes: { ...state.nodes, [nodeId]: { ...node, regionId } } }
    })
  }

  getNodesInRegion(regionId: string): CanvasNodeState[] {
    return Object.values(this.data.nodes).filter((n) => n.regionId === regionId)
  }

  groupSelectedIntoRegion(): string | null {
    const state = this.data
    const selectedNodes = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
    if (selectedNodes.length === 0) return null
    this.pushHistory()

    const padding = 30
    const minX = Math.min(...selectedNodes.map((n) => n.origin.x)) - padding
    const minY = Math.min(...selectedNodes.map((n) => n.origin.y)) - padding
    const maxX = Math.max(...selectedNodes.map((n) => n.origin.x + n.size.width)) + padding
    const maxY = Math.max(...selectedNodes.map((n) => n.origin.y + n.size.height)) + padding

    const regionId = this.addRegion(t('defaultRegion'), { x: minX, y: minY }, { width: maxX - minX, height: maxY - minY })

    this.set((s) => {
      const updatedNodes = { ...s.nodes }
      for (const node of selectedNodes) {
        updatedNodes[node.id] = { ...updatedNodes[node.id], regionId }
      }
      return { nodes: updatedNodes }
    })
    return regionId
  }

  stackSelected(axis: 'row' | 'column', gap = 16): void {
    this.pushHistory()
    this.set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state
      const row = axis === 'row'
      const sorted = [...selected].sort((a, b) =>
        row ? a.origin.x - b.origin.x : a.origin.y - b.origin.y,
      )
      const startX = Math.min(...selected.map((n) => n.origin.x))
      const startY = Math.min(...selected.map((n) => n.origin.y))
      const next = { ...state.nodes }
      let cursor = row ? startX : startY
      for (const n of sorted) {
        const x = row ? cursor : startX
        const y = row ? startY : cursor
        next[n.id] = { ...n, origin: { x, y } }
        cursor += (row ? n.size.width : n.size.height) + gap
      }
      return { nodes: next }
    })
  }

  tidyGridSelected(gap = 16): void {
    this.pushHistory()
    this.set((state) => {
      const selected = Object.values(state.nodes).filter((n) => state.selectedNodeIds.has(n.id))
      if (selected.length < 2) return state
      const n = selected.length
      const cols = Math.ceil(Math.sqrt(n))
      const cellW = Math.max(...selected.map((nd) => nd.size.width))
      const cellH = Math.max(...selected.map((nd) => nd.size.height))
      const startX = Math.min(...selected.map((nd) => nd.origin.x))
      const startY = Math.min(...selected.map((nd) => nd.origin.y))
      const sorted = [...selected].sort(
        (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
      )
      const next = { ...state.nodes }
      sorted.forEach((nd, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        next[nd.id] = {
          ...nd,
          origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
        }
      })
      return { nodes: next }
    })
  }

  dissolveRegion(regionId: string): void {
    this.set((state) => {
      const updatedNodes = { ...state.nodes }
      for (const nodeId of Object.keys(updatedNodes)) {
        if (updatedNodes[nodeId].regionId === regionId) {
          updatedNodes[nodeId] = { ...updatedNodes[nodeId], regionId: undefined }
        }
      }
      const { [regionId]: _omit, ...restRegions } = state.regions
      const nextRegionIds = new Set(state.selectedRegionIds)
      nextRegionIds.delete(regionId)
      return { nodes: updatedNodes, regions: restRegions, selectedRegionIds: nextRegionIds }
    })
  }

  // ---- Document load / serialize --------------------------------------------

  loadDocument(doc: CanvasDocument): void {
    const nodeList = Object.values(doc.nodes ?? {})
    const maxZOrder = nodeList.reduce((max, n) => Math.max(max, n.zOrder), -1)
    const maxCreationIndex = nodeList.reduce((max, n) => Math.max(max, n.creationIndex), -1)

    const idleNodes: Record<string, CanvasNodeState> = {}
    for (const [id, node] of Object.entries(doc.nodes ?? {})) {
      idleNodes[id] = { ...node, animationState: 'idle' }
    }

    this.set({
      nodes: idleNodes,
      regions: doc.regions ?? {},
      viewportOffset: doc.viewportOffset ?? { x: 0, y: 0 },
      zoomLevel: clampZoom(doc.zoomLevel ?? ZOOM_DEFAULT),
      focusedNodeId: doc.focusedNodeId ?? null,
      nextZOrder: doc.nextZOrder ?? maxZOrder + 1,
      nextCreationIndex: doc.nextCreationIndex ?? maxCreationIndex + 1,
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      snapGuides: { lines: [] },
      agents: {},
      history: [],
      future: [],
    })
  }

  toDocument(): CanvasDocument {
    const state = this.data
    // Drop transient animation state so a reload never restores mid-animation.
    const nodes: Record<CanvasNodeId, CanvasNodeState> = {}
    for (const [id, node] of Object.entries(state.nodes)) {
      if (node.animationState === 'exiting') continue
      // `initialCommand` is a one-shot launcher hint — never persist it, or the
      // agent would re-run every time the workspace reloads.
      const { initialCommand: _omit, ...rest } = node
      nodes[id] = { ...rest, animationState: 'idle' }
    }
    return {
      version: 2,
      nodes,
      regions: state.regions,
      viewportOffset: state.viewportOffset,
      zoomLevel: state.zoomLevel,
      focusedNodeId: state.focusedNodeId,
      nextZOrder: state.nextZOrder,
      nextCreationIndex: state.nextCreationIndex,
    }
  }

  clearAll(): void {
    this.pushHistory()
    this.set({
      nodes: {},
      regions: {},
      focusedNodeId: null,
      selectedNodeIds: new Set<string>(),
      selectedRegionIds: new Set<string>(),
      snapGuides: { lines: [] },
      agents: {},
    })
  }
}

export { CANVAS_GRID_SIZE }
