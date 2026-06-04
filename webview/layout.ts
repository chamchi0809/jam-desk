// =============================================================================
// Canvas layout engine — pure layout/snapping functions.
// Ported faithfully from Cate (renderer/canvas/layoutEngine.ts), with panel
// types collapsed to the webview's NodeKind.
// =============================================================================

import {
  CANVAS_GRID_SIZE,
  NODE_DEFAULT_SIZES,
  NODE_MINIMUM_SIZES,
} from './types'
import type {
  Point,
  Size,
  Rect,
  NodeKind,
  CanvasNodeState,
  CanvasRegion,
  SnapLine,
} from './types'

// ---- Grid snapping -----------------------------------------------------------

/** Round a point to the nearest grid intersection. */
export function snapToGrid(point: Point, gridSize = CANVAS_GRID_SIZE): Point {
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  }
}

/** Snap a size so the bottom-right corner lands on a grid line (min one cell). */
export function snapSize(size: Size, origin: Point, gridSize = CANVAS_GRID_SIZE): Size {
  const bottomRight: Point = { x: origin.x + size.width, y: origin.y + size.height }
  const snappedBR = snapToGrid(bottomRight, gridSize)
  return {
    width: Math.max(snappedBR.x - origin.x, gridSize),
    height: Math.max(snappedBR.y - origin.y, gridSize),
  }
}

export interface MovingEdges {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/**
 * Adjust a resize delta so the moving edge(s) land on the nearest grid line,
 * keeping the opposite (fixed) edge put. Snapping the delta (rather than the
 * final rect) keeps shared-border neighbor math — derived from the same delta —
 * consistent with the primary node.
 */
export function snapResizeDelta(
  moving: MovingEdges,
  startOrigin: Point,
  startSize: Size,
  delta: Point,
  gridSize = CANVAS_GRID_SIZE,
): Point {
  let dx = delta.x
  let dy = delta.y
  const round = (v: number) => Math.round(v / gridSize) * gridSize

  if (moving.right) {
    const right = startOrigin.x + startSize.width + dx
    dx = round(right) - (startOrigin.x + startSize.width)
  } else if (moving.left) {
    dx = round(startOrigin.x + dx) - startOrigin.x
  }

  if (moving.bottom) {
    const bottom = startOrigin.y + startSize.height + dy
    dy = round(bottom) - (startOrigin.y + startSize.height)
  } else if (moving.top) {
    dy = round(startOrigin.y + dy) - startOrigin.y
  }

  return { x: dx, y: dy }
}

// ---- Edge snapping (alignment guides) ---------------------------------------

export interface SnapResult {
  snappedOrigin: Point
  lines: SnapLine[]
}

/**
 * Snap a rect's origin to nearby edges (and center lines) of neighbor rects.
 * Returns the closest snapped origin per axis plus every alignment line within
 * `threshold` for guide rendering.
 */
export function snapToEdges(rect: Rect, neighbors: Rect[], threshold = 8): SnapResult {
  let bestSnapX: number | null = null
  let bestSnapY: number | null = null
  let bestDX = Infinity
  let bestDY = Infinity

  const lines: SnapLine[] = []

  const rLeft = rect.origin.x
  const rRight = rect.origin.x + rect.size.width
  const rCenterX = rect.origin.x + rect.size.width / 2
  const rTop = rect.origin.y
  const rBottom = rect.origin.y + rect.size.height
  const rCenterY = rect.origin.y + rect.size.height / 2

  for (const neighbor of neighbors) {
    const nLeft = neighbor.origin.x
    const nRight = neighbor.origin.x + neighbor.size.width
    const nCenterX = neighbor.origin.x + neighbor.size.width / 2
    const nTop = neighbor.origin.y
    const nBottom = neighbor.origin.y + neighbor.size.height
    const nCenterY = neighbor.origin.y + neighbor.size.height / 2

    const xCandidates: [number, number, number, 'edge' | 'center'][] = [
      [Math.abs(rLeft - nLeft), nLeft, nLeft, 'edge'],
      [Math.abs(rLeft - nRight), nRight, nRight, 'edge'],
      [Math.abs(rRight - nLeft), nLeft - rect.size.width, nLeft, 'edge'],
      [Math.abs(rRight - nRight), nRight - rect.size.width, nRight, 'edge'],
      [Math.abs(rCenterX - nCenterX), nCenterX - rect.size.width / 2, nCenterX, 'center'],
    ]

    for (const [dist, snappedOriginX, guideX, type] of xCandidates) {
      if (dist < threshold) {
        if (!lines.some((l) => l.axis === 'x' && l.position === guideX && l.type === type)) {
          lines.push({ axis: 'x', position: guideX, type })
        }
        if (dist < bestDX) {
          bestDX = dist
          bestSnapX = snappedOriginX
        }
      }
    }

    const yCandidates: [number, number, number, 'edge' | 'center'][] = [
      [Math.abs(rTop - nTop), nTop, nTop, 'edge'],
      [Math.abs(rTop - nBottom), nBottom, nBottom, 'edge'],
      [Math.abs(rBottom - nTop), nTop - rect.size.height, nTop, 'edge'],
      [Math.abs(rBottom - nBottom), nBottom - rect.size.height, nBottom, 'edge'],
      [Math.abs(rCenterY - nCenterY), nCenterY - rect.size.height / 2, nCenterY, 'center'],
    ]

    for (const [dist, snappedOriginY, guideY, type] of yCandidates) {
      if (dist < threshold) {
        if (!lines.some((l) => l.axis === 'y' && l.position === guideY && l.type === type)) {
          lines.push({ axis: 'y', position: guideY, type })
        }
        if (dist < bestDY) {
          bestDY = dist
          bestSnapY = snappedOriginY
        }
      }
    }
  }

  const snappedOrigin: Point = {
    x: bestSnapX !== null ? bestSnapX : rect.origin.x,
    y: bestSnapY !== null ? bestSnapY : rect.origin.y,
  }
  return { snappedOrigin, lines }
}

/**
 * Snap a rect using both grid and edge snapping; per axis the smaller
 * displacement wins. Returns both the chosen origin and the alignment lines so
 * the caller can render guides for whichever axes actually snapped to an edge.
 */
export function snapWithGuides(
  rect: Rect,
  neighbors: Rect[],
  gridSize = CANVAS_GRID_SIZE,
  edgeThreshold = 8,
): { origin: Point; lines: SnapLine[] } {
  const gridOrigin = snapToGrid(rect.origin, gridSize)
  const gridRect: Rect = { origin: gridOrigin, size: rect.size }
  const edgeResult = snapToEdges(gridRect, neighbors, edgeThreshold)
  const edgeSnappedOrigin = edgeResult.snappedOrigin

  let x = gridOrigin.x
  let usedEdgeX = false
  {
    const edgeDist = Math.abs(edgeSnappedOrigin.x - rect.origin.x)
    const gridDist = Math.abs(gridOrigin.x - rect.origin.x)
    if (edgeResult.lines.some((l) => l.axis === 'x') && edgeDist < gridDist) {
      x = edgeSnappedOrigin.x
      usedEdgeX = true
    }
  }

  let y = gridOrigin.y
  let usedEdgeY = false
  {
    const edgeDist = Math.abs(edgeSnappedOrigin.y - rect.origin.y)
    const gridDist = Math.abs(gridOrigin.y - rect.origin.y)
    if (edgeResult.lines.some((l) => l.axis === 'y') && edgeDist < gridDist) {
      y = edgeSnappedOrigin.y
      usedEdgeY = true
    }
  }

  // Only surface guides for axes that actually won an edge snap.
  const lines = edgeResult.lines.filter(
    (l) => (l.axis === 'x' && usedEdgeX) || (l.axis === 'y' && usedEdgeY),
  )
  return { origin: { x, y }, lines }
}

// ---- Overlap + free position ------------------------------------------------

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.origin.x + a.size.width <= b.origin.x ||
    b.origin.x + b.size.width <= a.origin.x ||
    a.origin.y + a.size.height <= b.origin.y ||
    b.origin.y + b.size.height <= a.origin.y
  )
}

export function defaultSize(kind: NodeKind): Size {
  return NODE_DEFAULT_SIZES[kind]
}

export function minimumSize(kind: NodeKind): Size {
  return NODE_MINIMUM_SIZES[kind]
}

/**
 * Find a free position for a new node that does not overlap any existing node.
 * From the reference node (focused, else most recently created) search outward
 * in the four cardinal directions, jumping past obstacles, and return the slot
 * whose center is closest to the reference's center. Ported from Cate's
 * canvasStore.findFreePosition.
 */
export function findFreePosition(
  nodes: Record<string, CanvasNodeState>,
  focusedNodeId: string | null,
  size: Size,
  preferred?: Point,
): Point {
  const nodeList = Object.values(nodes)
  if (nodeList.length === 0) {
    return preferred ?? { x: 100, y: 100 }
  }

  const gap = 40
  const grid = CANVAS_GRID_SIZE
  const snap = (v: number) => Math.round(v / grid) * grid

  const overlaps = (p: Point): CanvasNodeState | undefined => {
    const rect: Rect = { origin: p, size }
    return nodeList.find((n) => rectsOverlap({ origin: n.origin, size: n.size }, rect))
  }

  if (preferred) {
    const snapped = { x: snap(preferred.x), y: snap(preferred.y) }
    if (!overlaps(snapped)) return snapped
  }

  const reference =
    (focusedNodeId && nodes[focusedNodeId]) ||
    nodeList.reduce((a, b) => (b.creationIndex > a.creationIndex ? b : a))
  const ref = { origin: reference.origin, size: reference.size }

  const directions: Array<{ dx: -1 | 0 | 1; dy: -1 | 0 | 1 }> = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ]

  const slotInDirection = (dir: { dx: number; dy: number }): Point | null => {
    let p: Point
    if (dir.dx > 0) p = { x: ref.origin.x + ref.size.width + gap, y: ref.origin.y }
    else if (dir.dx < 0) p = { x: ref.origin.x - size.width - gap, y: ref.origin.y }
    else if (dir.dy > 0) p = { x: ref.origin.x, y: ref.origin.y + ref.size.height + gap }
    else p = { x: ref.origin.x, y: ref.origin.y - size.height - gap }

    for (let i = 0; i < 200; i++) {
      const obstacle = overlaps(p)
      if (!obstacle) return p
      if (dir.dx > 0) p = { x: obstacle.origin.x + obstacle.size.width + gap, y: p.y }
      else if (dir.dx < 0) p = { x: obstacle.origin.x - size.width - gap, y: p.y }
      else if (dir.dy > 0) p = { x: p.x, y: obstacle.origin.y + obstacle.size.height + gap }
      else p = { x: p.x, y: obstacle.origin.y - size.height - gap }
    }
    return null
  }

  const refCenter = {
    x: ref.origin.x + ref.size.width / 2,
    y: ref.origin.y + ref.size.height / 2,
  }
  let best: Point | null = null
  let bestDist = Infinity
  for (const dir of directions) {
    const slot = slotInDirection(dir)
    if (!slot) continue
    const cx = slot.x + size.width / 2
    const cy = slot.y + size.height / 2
    const dist = Math.hypot(cx - refCenter.x, cy - refCenter.y)
    if (dist < bestDist) {
      bestDist = dist
      best = slot
    }
  }

  if (best) return { x: snap(best.x), y: snap(best.y) }

  const maxBottom = nodeList.reduce(
    (acc, n) => Math.max(acc, n.origin.y + n.size.height),
    -Infinity,
  )
  return { x: snap(ref.origin.x), y: snap(maxBottom + gap) }
}

// ---- Shared border detection (synchronized resize) --------------------------

export interface SharedBorder {
  neighborId: string
  neighborEdge: 'left' | 'right' | 'top' | 'bottom'
}

/**
 * Find nodes whose opposite edge aligns with the given node's edge (a shared
 * border) and that actually overlap perpendicularly. Ported from Cate.
 */
export function findSharedBorders(
  nodeId: string,
  edge: 'left' | 'right' | 'top' | 'bottom',
  nodes: Record<string, CanvasNodeState>,
  tolerance = 2,
): SharedBorder[] {
  const node = nodes[nodeId]
  if (!node) return []

  const results: SharedBorder[] = []
  const isHorizontal = edge === 'left' || edge === 'right'

  let edgePos: number
  if (edge === 'right') edgePos = node.origin.x + node.size.width
  else if (edge === 'left') edgePos = node.origin.x
  else if (edge === 'bottom') edgePos = node.origin.y + node.size.height
  else edgePos = node.origin.y

  const oppositeEdge: 'left' | 'right' | 'top' | 'bottom' =
    edge === 'right' ? 'left' : edge === 'left' ? 'right' : edge === 'bottom' ? 'top' : 'bottom'

  for (const other of Object.values(nodes)) {
    if (other.id === nodeId) continue

    let neighborEdgePos: number
    if (oppositeEdge === 'left') neighborEdgePos = other.origin.x
    else if (oppositeEdge === 'right') neighborEdgePos = other.origin.x + other.size.width
    else if (oppositeEdge === 'top') neighborEdgePos = other.origin.y
    else neighborEdgePos = other.origin.y + other.size.height

    if (Math.abs(edgePos - neighborEdgePos) > tolerance) continue

    if (isHorizontal) {
      const overlapStart = Math.max(node.origin.y, other.origin.y)
      const overlapEnd = Math.min(
        node.origin.y + node.size.height,
        other.origin.y + other.size.height,
      )
      if (overlapEnd <= overlapStart) continue
    } else {
      const overlapStart = Math.max(node.origin.x, other.origin.x)
      const overlapEnd = Math.min(
        node.origin.x + node.size.width,
        other.origin.x + other.size.width,
      )
      if (overlapEnd <= overlapStart) continue
    }

    results.push({ neighborId: other.id, neighborEdge: oppositeEdge })
  }

  return results
}

// ---- Auto-layout (whole canvas: nodes + regions) ----------------------------

export interface AutoLayoutAllInput {
  nodes: CanvasNodeState[]
  regions: CanvasRegion[]
  containerWidth: number
  containerHeight?: number
  gap?: number
}

export interface AutoLayoutAllResult {
  nodeOrigins: Record<string, Point>
  regionOrigins: Record<string, Point>
  regionSizes: Record<string, Size>
}

/**
 * Choose a target row-wrap width that produces a bbox close to the container's
 * aspect ratio. Falls back to ≈ √(totalArea) (square) when aspect is unknown.
 * Always at least as wide as the widest single item. Ported from Cate.
 */
function chooseTargetWidth(items: { size: Size }[], gap: number, aspect: number): number {
  if (items.length === 0) return 0
  const widest = items.reduce((m, it) => Math.max(m, it.size.width), 0)
  const totalArea = items.reduce(
    (s, it) => s + (it.size.width + gap) * (it.size.height + gap),
    0,
  )
  const ideal = Math.sqrt(Math.max(totalArea, 1) * Math.max(aspect, 0.25))
  return Math.max(widest, ideal)
}

/**
 * Layout everything on the canvas in a tidy masonry grid. Nodes contained in a
 * region are grid-packed inside that region (which is resized to fit), then free
 * nodes and regions (as super-items) are packed into a top-level grid. Existing
 * item sizes are preserved. Ported faithfully from Cate's autoLayoutAll.
 */
export function autoLayoutAll(input: AutoLayoutAllInput): AutoLayoutAllResult {
  const { nodes, regions, containerWidth } = input
  const containerHeight = input.containerHeight ?? Math.round(containerWidth * 0.625)
  const gap = input.gap ?? 40
  const regionPad = 24
  const regionTitleBar = 32
  const aspect = Math.max(0.6, Math.min(2.4, containerWidth / Math.max(containerHeight, 1)))

  const result: AutoLayoutAllResult = {
    nodeOrigins: {},
    regionOrigins: {},
    regionSizes: {},
  }

  const nodesByRegion = new Map<string, CanvasNodeState[]>()
  const freeNodes: CanvasNodeState[] = []
  for (const n of nodes) {
    if (n.regionId && regions.some((r) => r.id === n.regionId)) {
      const list = nodesByRegion.get(n.regionId) ?? []
      list.push(n)
      nodesByRegion.set(n.regionId, list)
    } else {
      freeNodes.push(n)
    }
  }

  function packRelative(items: { id: string; size: Size }[], maxWidth: number) {
    const origins: Record<string, Point> = {}
    if (items.length === 0) return { origins, width: 0, height: 0 }

    const colWidth = items.reduce((m, it) => Math.max(m, it.size.width), 0)
    const colCount = Math.max(1, Math.floor((maxWidth + gap) / (colWidth + gap)))
    const colY: number[] = new Array(colCount).fill(0)
    let bboxW = 0
    let bboxH = 0

    for (const it of items) {
      let col = 0
      for (let i = 1; i < colCount; i++) {
        if (colY[i] < colY[col]) col = i
      }
      const x = col * (colWidth + gap)
      const y = colY[col]
      origins[it.id] = { x, y }
      colY[col] = y + it.size.height + gap
      bboxW = Math.max(bboxW, x + it.size.width)
      bboxH = Math.max(bboxH, colY[col] - gap)
    }
    return { origins, width: bboxW, height: bboxH }
  }

  const regionInternal = new Map<
    string,
    { origins: Record<string, Point>; width: number; height: number }
  >()
  for (const region of regions) {
    const contained = (nodesByRegion.get(region.id) ?? [])
      .slice()
      .sort((a, b) => a.creationIndex - b.creationIndex)
    if (contained.length === 0) {
      regionInternal.set(region.id, { origins: {}, width: 0, height: 0 })
      continue
    }
    const items = contained.map((n) => ({ id: n.id, size: n.size }))
    const target = chooseTargetWidth(items, gap, 1.0)
    const packed = packRelative(items, target)
    regionInternal.set(region.id, packed)
  }

  type SuperItem =
    | { kind: 'node'; id: string; size: Size; rank: number }
    | { kind: 'region'; id: string; size: Size; rank: number }

  const supers: SuperItem[] = []

  for (const n of freeNodes) {
    supers.push({ kind: 'node', id: n.id, size: n.size, rank: n.creationIndex })
  }

  for (const region of regions) {
    const internal = regionInternal.get(region.id)!
    const contained = nodesByRegion.get(region.id) ?? []
    const minRank =
      contained.length > 0
        ? Math.min(...contained.map((n) => n.creationIndex))
        : Number.MAX_SAFE_INTEGER - 1
    const width = Math.max(region.size.width, internal.width + regionPad * 2, 240)
    const height = Math.max(internal.height + regionPad * 2 + regionTitleBar, 120)
    supers.push({ kind: 'region', id: region.id, size: { width, height }, rank: minRank })
    result.regionSizes[region.id] = { width, height }
  }

  supers.sort((a, b) => a.rank - b.rank)

  const topItems = supers.map((s) => ({ id: s.kind + ':' + s.id, size: s.size }))
  const idealTopWidth = chooseTargetWidth(topItems, gap, aspect)
  const topMaxW = Math.max(
    topItems.reduce((m, it) => Math.max(m, it.size.width), 0),
    Math.min(idealTopWidth, Math.max(containerWidth - gap * 2, idealTopWidth)),
  )
  const topPacked = packRelative(topItems, topMaxW)

  const originFor = (kind: string, id: string) => topPacked.origins[kind + ':' + id]

  const baseX = gap
  const baseY = gap

  for (const s of supers) {
    const rel = originFor(s.kind, s.id)
    const abs: Point = { x: baseX + rel.x, y: baseY + rel.y }
    if (s.kind === 'node') {
      result.nodeOrigins[s.id] = abs
    } else {
      result.regionOrigins[s.id] = abs
      const internal = regionInternal.get(s.id)!
      const innerX = abs.x + regionPad
      const innerY = abs.y + regionPad + regionTitleBar
      for (const [nodeId, rel2] of Object.entries(internal.origins)) {
        result.nodeOrigins[nodeId] = { x: innerX + rel2.x, y: innerY + rel2.y }
      }
    }
  }

  return result
}
