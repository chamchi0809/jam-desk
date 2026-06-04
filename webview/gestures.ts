// =============================================================================
// gestures — pointer-driven node/region drag & resize.
//
// These are imperative ports of Cate's drag/resize behavior, decoupled from the
// dock/cross-window machinery (which does not apply to a single webview):
//
//  - beginNodeDrag   : move a node (and any co-selected nodes) with live
//                      grid + edge snapping, alignment guides, and drop-into-
//                      region detection.
//  - beginNodeResize : edge/corner resize with shared-border synchronized
//                      resize, min-size clamping, grab-point re-anchoring, and
//                      snap-on-release. Ported from Cate's useNodeResize.ts.
//  - beginRegionDrag : move a region (carrying its contained nodes).
//  - beginRegionResize : resize a region.
//
// Each begin* function owns its window mousemove/up listeners and cleans up on
// release. They are invoked by nodeView only for primary-button presses under
// the select tool, so right/middle button and hand-tool presses bubble to the
// canvas pan handler untouched (see interaction.ts).
// =============================================================================

import type { CanvasStore } from './store'
import type { Point, Size, Rect, SnapLine, CanvasRegion } from './types'
import {
  snapWithGuides,
  snapToGrid,
  snapResizeDelta,
  findSharedBorders,
  minimumSize,
} from './layout'
import type { ResizeEdge } from './resizeEdge'
import { getCursorForEdge } from './resizeEdge'
import { settings } from './settings'

const REGION_MIN_SIZE: Size = { width: 100, height: 100 }

/** Radial dead-zone before a press becomes a drag (Cate's DEAD_ZONE_PX). */
const DRAG_DEAD_ZONE_PX = 4

// -----------------------------------------------------------------------------
// Node drag
// -----------------------------------------------------------------------------

/** Rect helpers for the snap neighbor set. */
function nodeRect(o: Point, s: Size): Rect {
  return { origin: { ...o }, size: { ...s } }
}

/**
 * The region that "contains" a node box for drop purposes: the first region
 * (in iteration order) whose bbox overlaps the node bbox by more than 50% of the
 * node's area. Mirrors Cate's applyRegionContainment (drag/commit.ts).
 */
function regionContainingBox(origin: Point, size: Size, regions: CanvasRegion[]): string | null {
  const nodeArea = size.width * size.height
  if (nodeArea <= 0) return null
  for (const r of regions) {
    const overlapX = Math.max(
      0,
      Math.min(origin.x + size.width, r.origin.x + r.size.width) - Math.max(origin.x, r.origin.x),
    )
    const overlapY = Math.max(
      0,
      Math.min(origin.y + size.height, r.origin.y + r.size.height) - Math.max(origin.y, r.origin.y),
    )
    if ((overlapX * overlapY) / nodeArea > 0.5) return r.id
  }
  return null
}

/**
 * Begin dragging a node. The primary node snaps to the grid and to neighbor
 * edges (with live alignment guides); any other co-selected nodes translate by
 * the same applied delta. On release, each dragged node is (re)assigned to the
 * region whose body contains its center, matching Cate's containment model.
 */
export function beginNodeDrag(store: CanvasStore, nodeId: string, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()

  const state0 = store.getState()
  const primary = state0.nodes[nodeId]
  if (!primary || primary.isPinned) return

  const startClientX = e.clientX
  const startClientY = e.clientY
  const startOrigin: Point = { ...primary.origin }

  // Group drag: if the dragged node is part of a multi-node selection, move the
  // whole selection by the same delta. Otherwise just this node.
  const sel = state0.selectedNodeIds
  const groupIds =
    sel.has(nodeId) && sel.size > 1 ? Array.from(sel).filter((id) => state0.nodes[id]) : [nodeId]
  const starts = new Map<string, Point>()
  for (const id of groupIds) starts.set(id, { ...state0.nodes[id].origin })

  let moved = false
  let rafId = 0
  let pending: { applied: Point; lines: SnapLine[]; dropRegionId: string | null } | null = null

  const flush = () => {
    rafId = 0
    if (!pending) return
    const { applied, lines, dropRegionId } = pending
    pending = null
    for (const id of groupIds) {
      const s = starts.get(id)!
      store.moveNode(id, { x: s.x + applied.x, y: s.y + applied.y })
    }
    store.setSnapGuides({ lines })
    store.setDropTargetRegion(dropRegionId)
  }

  const onMove = (ev: MouseEvent) => {
    const z = store.getState().zoomLevel
    const dx = (ev.clientX - startClientX) / z
    const dy = (ev.clientY - startClientY) / z
    if (!moved) {
      if (Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) < DRAG_DEAD_ZONE_PX) return
      moved = true
      store.pushHistory()
    }

    const raw: Point = { x: startOrigin.x + dx, y: startOrigin.y + dy }
    let origin = raw
    let lines: SnapLine[] = []

    if (settings.snapToGrid && !ev.altKey) {
      const st = store.getState()
      const groupSet = new Set(groupIds)
      const neighbors: Rect[] = []
      for (const n of Object.values(st.nodes)) {
        if (groupSet.has(n.id) || n.animationState === 'exiting') continue
        neighbors.push(nodeRect(n.origin, n.size))
      }
      for (const r of Object.values(st.regions)) neighbors.push(nodeRect(r.origin, r.size))
      const res = snapWithGuides({ origin: raw, size: primary.size }, neighbors)
      origin = res.origin
      lines = res.lines
    }

    const applied: Point = { x: origin.x - startOrigin.x, y: origin.y - startOrigin.y }

    // Drop-target: which region the primary node's (snapped) box overlaps by >50%.
    const dropRegionId = regionContainingBox(
      origin,
      primary.size,
      Object.values(store.getState().regions),
    )

    pending = { applied, lines, dropRegionId }
    if (!rafId) rafId = requestAnimationFrame(flush)
  }

  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onUp)
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (pending) flush()
    store.clearSnapGuides()
    store.setDropTargetRegion(null)

    if (moved) {
      // Re-evaluate region containment per dragged node (drop-in / drop-out),
      // using the same >50%-overlap rule as the live drop-target highlight.
      const st = store.getState()
      const regions = Object.values(st.regions)
      for (const id of groupIds) {
        const n = st.nodes[id]
        if (!n) continue
        const containing = regionContainingBox(n.origin, n.size, regions) ?? undefined
        if (n.regionId !== containing) store.setNodeRegion(id, containing)
      }
    }
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onUp)
}

// -----------------------------------------------------------------------------
// Node resize (shared-border synchronized) — ported from Cate useNodeResize.ts
// -----------------------------------------------------------------------------

function isCardinalEdge(edge: ResizeEdge): edge is 'top' | 'bottom' | 'left' | 'right' {
  return edge === 'top' || edge === 'bottom' || edge === 'left' || edge === 'right'
}

interface NeighborStartState {
  id: string
  startOrigin: Point
  startSize: Size
  minSize: Size
}

export function beginNodeResize(
  store: CanvasStore,
  nodeId: string,
  edge: ResizeEdge,
  e: MouseEvent,
): void {
  e.preventDefault()
  e.stopPropagation()

  const state = store.getState()
  const node = state.nodes[nodeId]
  if (!node || node.isPinned) return

  store.pushHistory()

  const rs = {
    edge,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startOrigin: { ...node.origin },
    startSize: { ...node.size },
  }
  const minSize = minimumSize(node.kind)

  // Lock the resize cursor document-wide so it stays put even when the pointer
  // drifts off the narrow edge band (easy when zoomed out).
  const previousBodyCursor = document.body.style.cursor
  const resizeCursor = getCursorForEdge(edge)
  document.body.style.cursor = resizeCursor
  document.body.classList.add('canvas-interacting')
  const cursorStyleEl = document.createElement('style')
  cursorStyleEl.textContent = `*, *::before, *::after { cursor: ${resizeCursor} !important; }`
  document.head.appendChild(cursorStyleEl)

  // Detect shared borders (cardinal edges only) and snapshot neighbor state.
  let neighborStarts: NeighborStartState[] = []
  if (isCardinalEdge(edge)) {
    const borders = findSharedBorders(nodeId, edge, state.nodes)
    neighborStarts = borders.map((b) => {
      const neighbor = state.nodes[b.neighborId]
      return {
        id: b.neighborId,
        startOrigin: { ...neighbor.origin },
        startSize: { ...neighbor.size },
        minSize: minimumSize(neighbor.kind),
      }
    })
  }

  let pending: {
    origin: Point
    size: Size
    neighbors: Array<{ id: string; origin: Point; size: Size }>
  } | null = null
  let rafId = 0

  const computeResize = (clientX: number, clientY: number, snap: boolean) => {
    const zoom = store.getState().zoomLevel
    let deltaX = (clientX - rs.startClientX) / zoom
    let deltaY = (clientY - rs.startClientY) / zoom

    const movesRightEdge = rs.edge === 'right' || rs.edge === 'topRight' || rs.edge === 'bottomRight'
    const movesLeftEdge = rs.edge === 'left' || rs.edge === 'topLeft' || rs.edge === 'bottomLeft'
    const movesBottomEdge =
      rs.edge === 'bottom' || rs.edge === 'bottomLeft' || rs.edge === 'bottomRight'
    const movesTopEdge = rs.edge === 'top' || rs.edge === 'topLeft' || rs.edge === 'topRight'

    if (!movesRightEdge && !movesLeftEdge) deltaX = 0
    if (!movesBottomEdge && !movesTopEdge) deltaY = 0

    if (snap) {
      const snapped = snapResizeDelta(
        { left: movesLeftEdge, right: movesRightEdge, top: movesTopEdge, bottom: movesBottomEdge },
        rs.startOrigin,
        rs.startSize,
        { x: deltaX, y: deltaY },
      )
      deltaX = snapped.x
      deltaY = snapped.y
    }

    let newOriginX = rs.startOrigin.x
    let newOriginY = rs.startOrigin.y
    let newWidth = rs.startSize.width
    let newHeight = rs.startSize.height

    if (movesRightEdge) newWidth += deltaX
    if (movesLeftEdge) {
      newOriginX += deltaX
      newWidth -= deltaX
    }
    if (movesBottomEdge) newHeight += deltaY
    if (movesTopEdge) {
      newOriginY += deltaY
      newHeight -= deltaY
    }

    const effMinW = minSize.width
    const effMinH = minSize.height
    if (newWidth < effMinW) {
      const excess = effMinW - newWidth
      newWidth = effMinW
      if (movesLeftEdge) newOriginX -= excess
    }
    if (newHeight < effMinH) {
      const excess = effMinH - newHeight
      newHeight = effMinH
      if (movesTopEdge) newOriginY -= excess
    }

    const neighbors: Array<{ id: string; origin: Point; size: Size }> = []
    if (neighborStarts.length > 0) {
      const isHorizontal = rs.edge === 'left' || rs.edge === 'right'
      let clampedDelta = isHorizontal ? deltaX : deltaY

      for (const ns of neighborStarts) {
        const available = isHorizontal
          ? ns.startSize.width - ns.minSize.width
          : ns.startSize.height - ns.minSize.height
        if (rs.edge === 'right' || rs.edge === 'bottom') {
          clampedDelta = Math.min(clampedDelta, available)
        } else {
          clampedDelta = Math.max(clampedDelta, -available)
        }
      }

      if (isHorizontal) {
        if (rs.edge === 'right') {
          newWidth = rs.startSize.width + clampedDelta
        } else {
          newOriginX = rs.startOrigin.x + clampedDelta
          newWidth = rs.startSize.width - clampedDelta
        }
        if (newWidth < effMinW) {
          newWidth = effMinW
          if (rs.edge === 'left') newOriginX = rs.startOrigin.x + rs.startSize.width - effMinW
        }
      } else {
        if (rs.edge === 'bottom') {
          newHeight = rs.startSize.height + clampedDelta
        } else {
          newOriginY = rs.startOrigin.y + clampedDelta
          newHeight = rs.startSize.height - clampedDelta
        }
        if (newHeight < effMinH) {
          newHeight = effMinH
          if (rs.edge === 'top') newOriginY = rs.startOrigin.y + rs.startSize.height - effMinH
        }
      }

      for (const ns of neighborStarts) {
        let nOriginX = ns.startOrigin.x
        let nOriginY = ns.startOrigin.y
        let nWidth = ns.startSize.width
        let nHeight = ns.startSize.height
        if (rs.edge === 'right') {
          nOriginX += clampedDelta
          nWidth -= clampedDelta
        } else if (rs.edge === 'left') {
          nWidth += clampedDelta
        } else if (rs.edge === 'bottom') {
          nOriginY += clampedDelta
          nHeight -= clampedDelta
        } else if (rs.edge === 'top') {
          nHeight += clampedDelta
        }
        neighbors.push({
          id: ns.id,
          origin: { x: nOriginX, y: nOriginY },
          size: {
            width: Math.max(nWidth, ns.minSize.width),
            height: Math.max(nHeight, ns.minSize.height),
          },
        })
      }
    }

    // Re-anchor the grab point to the size actually applied, so reversing
    // direction immediately tracks the cursor after a clamp.
    const appliedDeltaX = movesRightEdge
      ? newWidth - rs.startSize.width
      : movesLeftEdge
        ? newOriginX - rs.startOrigin.x
        : 0
    const appliedDeltaY = movesBottomEdge
      ? newHeight - rs.startSize.height
      : movesTopEdge
        ? newOriginY - rs.startOrigin.y
        : 0
    if (movesRightEdge || movesLeftEdge) rs.startClientX = clientX - appliedDeltaX * zoom
    if (movesBottomEdge || movesTopEdge) rs.startClientY = clientY - appliedDeltaY * zoom

    pending = {
      origin: { x: newOriginX, y: newOriginY },
      size: { width: newWidth, height: newHeight },
      neighbors,
    }
  }

  const commit = () => {
    if (!pending) return
    store.resizeNode(nodeId, pending.size, pending.origin)
    for (const n of pending.neighbors) store.resizeNode(n.id, n.size, n.origin)
    pending = null
  }

  let moved = false

  const onMove = (ev: MouseEvent) => {
    moved = true
    computeResize(ev.clientX, ev.clientY, false)
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0
        commit()
      })
    }
  }

  const onUp = (ev: MouseEvent) => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)

    if (moved) {
      computeResize(ev.clientX, ev.clientY, settings.snapToGrid && !ev.altKey)
    }

    document.body.style.cursor = previousBodyCursor
    document.body.classList.remove('canvas-interacting')
    cursorStyleEl.remove()

    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    commit()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// -----------------------------------------------------------------------------
// Region drag
// -----------------------------------------------------------------------------

export function beginRegionDrag(store: CanvasStore, regionId: string, e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()

  const state0 = store.getState()
  const region = state0.regions[regionId]
  if (!region) return

  const startClientX = e.clientX
  const startClientY = e.clientY
  const startOrigin: Point = { ...region.origin }

  // Multi-drag: if other regions are co-selected, or any selected node lives
  // outside this region, drag the whole selection together (matches Cate). The
  // selection is fixed at mousedown (set by the view before this runs).
  const hasOtherRegions = state0.selectedRegionIds.size > 1
  let hasExternalNodes = false
  for (const nid of state0.selectedNodeIds) {
    const n = state0.nodes[nid]
    if (n && n.regionId !== regionId) {
      hasExternalNodes = true
      break
    }
  }
  const isMultiDrag = hasOtherRegions || hasExternalNodes
  let lastClientX = startClientX
  let lastClientY = startClientY

  let moved = false
  let rafId = 0
  let pending: { origin: Point; lines: SnapLine[] } | null = null

  const flush = () => {
    rafId = 0
    if (!pending) return
    const { origin, lines } = pending
    pending = null
    store.moveRegion(regionId, origin)
    store.setSnapGuides({ lines })
  }

  const onMove = (ev: MouseEvent) => {
    const z = store.getState().zoomLevel
    if (!moved) {
      if (Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY) < DRAG_DEAD_ZONE_PX) return
      moved = true
      store.pushHistory()
    }

    // Multi-drag: translate the whole selection by the incremental delta (no
    // snapping, mirroring Cate). Each entity moves once — no region→child cascade.
    if (isMultiDrag) {
      const incrDx = (ev.clientX - lastClientX) / z
      const incrDy = (ev.clientY - lastClientY) / z
      lastClientX = ev.clientX
      lastClientY = ev.clientY
      store.translateSelection(incrDx, incrDy)
      return
    }

    const dx = (ev.clientX - startClientX) / z
    const dy = (ev.clientY - startClientY) / z
    const raw: Point = { x: startOrigin.x + dx, y: startOrigin.y + dy }
    let origin = raw
    let lines: SnapLine[] = []
    if (settings.snapToGrid && !ev.altKey) {
      const st = store.getState()
      const neighbors: Rect[] = []
      for (const r of Object.values(st.regions)) {
        if (r.id === regionId) continue
        neighbors.push(nodeRect(r.origin, r.size))
      }
      // Nodes that are NOT contained in this region act as snap neighbors.
      for (const n of Object.values(st.nodes)) {
        if (n.regionId === regionId) continue
        neighbors.push(nodeRect(n.origin, n.size))
      }
      const res = snapWithGuides({ origin: raw, size: region.size }, neighbors)
      origin = res.origin
      lines = res.lines
    }
    pending = { origin, lines }
    if (!rafId) rafId = requestAnimationFrame(flush)
  }

  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    window.removeEventListener('blur', onUp)
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    if (pending) flush()
    store.clearSnapGuides()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('blur', onUp)
}

// -----------------------------------------------------------------------------
// Region resize (no shared border)
// -----------------------------------------------------------------------------

export function beginRegionResize(
  store: CanvasStore,
  regionId: string,
  edge: ResizeEdge,
  e: MouseEvent,
): void {
  e.preventDefault()
  e.stopPropagation()

  const region = store.getState().regions[regionId]
  if (!region) return

  store.pushHistory()

  const rs = {
    edge,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startOrigin: { ...region.origin },
    startSize: { ...region.size },
  }

  const previousBodyCursor = document.body.style.cursor
  const resizeCursor = getCursorForEdge(edge)
  document.body.style.cursor = resizeCursor
  document.body.classList.add('canvas-interacting')
  const cursorStyleEl = document.createElement('style')
  cursorStyleEl.textContent = `*, *::before, *::after { cursor: ${resizeCursor} !important; }`
  document.head.appendChild(cursorStyleEl)

  let pending: { origin: Point; size: Size } | null = null
  let rafId = 0
  let moved = false

  const compute = (clientX: number, clientY: number, snap: boolean) => {
    const zoom = store.getState().zoomLevel
    let deltaX = (clientX - rs.startClientX) / zoom
    let deltaY = (clientY - rs.startClientY) / zoom

    const movesRight = rs.edge === 'right' || rs.edge === 'topRight' || rs.edge === 'bottomRight'
    const movesLeft = rs.edge === 'left' || rs.edge === 'topLeft' || rs.edge === 'bottomLeft'
    const movesBottom = rs.edge === 'bottom' || rs.edge === 'bottomLeft' || rs.edge === 'bottomRight'
    const movesTop = rs.edge === 'top' || rs.edge === 'topLeft' || rs.edge === 'topRight'

    if (!movesRight && !movesLeft) deltaX = 0
    if (!movesBottom && !movesTop) deltaY = 0

    if (snap) {
      const snapped = snapResizeDelta(
        { left: movesLeft, right: movesRight, top: movesTop, bottom: movesBottom },
        rs.startOrigin,
        rs.startSize,
        { x: deltaX, y: deltaY },
      )
      deltaX = snapped.x
      deltaY = snapped.y
    }

    let ox = rs.startOrigin.x
    let oy = rs.startOrigin.y
    let w = rs.startSize.width
    let h = rs.startSize.height
    if (movesRight) w += deltaX
    if (movesLeft) {
      ox += deltaX
      w -= deltaX
    }
    if (movesBottom) h += deltaY
    if (movesTop) {
      oy += deltaY
      h -= deltaY
    }
    if (w < REGION_MIN_SIZE.width) {
      const excess = REGION_MIN_SIZE.width - w
      w = REGION_MIN_SIZE.width
      if (movesLeft) ox -= excess
    }
    if (h < REGION_MIN_SIZE.height) {
      const excess = REGION_MIN_SIZE.height - h
      h = REGION_MIN_SIZE.height
      if (movesTop) oy -= excess
    }
    pending = { origin: { x: ox, y: oy }, size: { width: w, height: h } }
  }

  const commit = () => {
    if (!pending) return
    store.resizeRegion(regionId, pending.size, pending.origin)
    pending = null
  }

  const onMove = (ev: MouseEvent) => {
    moved = true
    compute(ev.clientX, ev.clientY, false)
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0
        commit()
      })
    }
  }

  const onUp = (ev: MouseEvent) => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (moved) compute(ev.clientX, ev.clientY, settings.snapToGrid && !ev.altKey)
    document.body.style.cursor = previousBodyCursor
    document.body.classList.remove('canvas-interacting')
    cursorStyleEl.remove()
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    commit()
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

export { snapToGrid }
