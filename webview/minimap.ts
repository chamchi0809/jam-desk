// =============================================================================
// CanvasMinimap — bird's-eye overview of all nodes & regions.
//
// Ported from the upstream IDE's Minimap.tsx. Renders into a corner of the canvas with:
//  - node / region rectangles scaled to fit world bounds (+100 padding)
//  - a viewport indicator rect updated IMPERATIVELY on pan (no full rebuild)
//  - click / drag anywhere → navigate (pan) the camera to that world point
//  - click a node rect → focus & center it
//  - a resize handle (inner corner) and a move handle (outer corner)
// Corner + size persist to localStorage.
// =============================================================================

import type { CanvasStore } from './store'
import type { CanvasData } from './store'
import { AGENT_ACTIVITY_META } from './types'
import { icons } from './icons'
import { t } from './i18n'

const DEFAULT_WIDTH = 200
const DEFAULT_HEIGHT = 150
const MIN_WIDTH = 120
const MIN_HEIGHT = 90
const MAX_WIDTH = 600
const MAX_HEIGHT = 500
const PADDING = 10
const GAP = 12

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
const CORNER_KEY = 'jamDesk.minimap.corner'
const SIZE_KEY = 'jamDesk.minimap.size'

function loadCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY) as Corner | null
    return v || 'bottom-right'
  } catch {
    return 'bottom-right'
  }
}
function loadSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p.w === 'number' && typeof p.h === 'number') return { w: p.w, h: p.h }
    }
  } catch {}
  return { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT }
}

export class CanvasMinimap {
  private root: HTMLDivElement
  private viewportRect: HTMLDivElement
  private content: HTMLDivElement
  private resizeHandle: HTMLDivElement
  private moveHandle: HTMLDivElement
  private unsubscribe: () => void

  private corner: Corner = loadCorner()
  private size = loadSize()

  private layout = {
    worldMinX: 0,
    worldMinY: 0,
    scale: 1,
    zoomLevel: 1,
    containerWidth: 0,
    containerHeight: 0,
  }
  private hasContent = false
  // Whether the user/settings want the minimap shown. Kept separate from
  // hasContent so a content/zoom change (which re-runs rebuild) can't override
  // an explicit hide.
  private wantVisible = true
  private sizeDebounce: ReturnType<typeof setTimeout> | null = null
  private cornerDebounce: ReturnType<typeof setTimeout> | null = null

  constructor(
    parent: HTMLElement,
    private store: CanvasStore,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'minimap'
    this.root.addEventListener('mousedown', (e) => this.onNavigateDown(e))

    this.content = document.createElement('div')
    this.content.className = 'minimap-content'
    this.content.style.position = 'absolute'
    this.content.style.inset = '0'
    this.root.appendChild(this.content)

    this.viewportRect = document.createElement('div')
    this.viewportRect.className = 'minimap-viewport'
    this.root.appendChild(this.viewportRect)

    this.resizeHandle = document.createElement('div')
    this.resizeHandle.className = 'minimap-resize'
    this.resizeHandle.title = t('minimapResize')
    this.resizeHandle.addEventListener('mousedown', (e) => this.onResizeDown(e))
    this.root.appendChild(this.resizeHandle)

    this.moveHandle = document.createElement('div')
    this.moveHandle.className = 'minimap-move'
    this.moveHandle.title = t('minimapMove')
    this.moveHandle.innerHTML = icons.gripVertical
    this.moveHandle.addEventListener('mousedown', (e) => this.onMoveDown(e))
    this.root.appendChild(this.moveHandle)

    parent.appendChild(this.root)

    this.applyCornerAndSize()
    this.rebuild(store.getState())

    this.unsubscribe = store.subscribe((next, prev) => {
      if (
        next.nodes !== prev.nodes ||
        next.regions !== prev.regions ||
        next.zoomLevel !== prev.zoomLevel ||
        next.containerSize !== prev.containerSize ||
        next.agents !== prev.agents
      ) {
        this.rebuild(next)
      } else if (next.viewportOffset !== prev.viewportOffset) {
        this.updateViewportRect(next)
      }
    })
  }

  setVisible(visible: boolean): void {
    this.wantVisible = visible
    this.applyVisibility()
  }

  /** Single source of truth for display: shown only when both wanted and there
   * is content to show. */
  private applyVisibility(): void {
    this.root.style.display = this.wantVisible && this.hasContent ? 'block' : 'none'
  }

  private applyCornerAndSize(): void {
    const s = this.root.style
    s.position = 'absolute'
    s.width = `${this.size.w}px`
    s.height = `${this.size.h}px`
    s.top = s.bottom = s.left = s.right = ''
    if (this.corner.startsWith('bottom')) s.bottom = `${GAP}px`
    else s.top = `${GAP}px`
    if (this.corner.endsWith('right')) s.right = `${GAP}px`
    else s.left = `${GAP}px`

    // Resize handle: inner corner (toward canvas center).
    const rh = this.resizeHandle.style
    rh.top = rh.bottom = rh.left = rh.right = ''
    if (this.corner.startsWith('bottom')) rh.top = '0'
    else rh.bottom = '0'
    if (this.corner.endsWith('right')) rh.left = '0'
    else rh.right = '0'
    rh.cursor =
      this.corner === 'bottom-right' || this.corner === 'top-left' ? 'nwse-resize' : 'nesw-resize'

    // Move handle: outer corner (against screen edge).
    const mh = this.moveHandle.style
    mh.top = mh.bottom = mh.left = mh.right = ''
    if (this.corner.startsWith('bottom')) mh.bottom = '2px'
    else mh.top = '2px'
    if (this.corner.endsWith('right')) mh.right = '2px'
    else mh.left = '2px'
  }

  private rebuild(s: CanvasData): void {
    const nodeList = Object.values(s.nodes)
    const regionList = Object.values(s.regions)
    // Like the upstream IDE, the minimap keys on nodes: a regions-only canvas hides it.
    if (nodeList.length === 0) {
      this.hasContent = false
      this.applyVisibility()
      return
    }
    this.hasContent = true
    this.applyVisibility()

    const xs: number[] = []
    const ys: number[] = []
    const xe: number[] = []
    const ye: number[] = []
    for (const n of nodeList) {
      xs.push(n.origin.x); ys.push(n.origin.y)
      xe.push(n.origin.x + n.size.width); ye.push(n.origin.y + n.size.height)
    }
    for (const r of regionList) {
      xs.push(r.origin.x); ys.push(r.origin.y)
      xe.push(r.origin.x + r.size.width); ye.push(r.origin.y + r.size.height)
    }
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xe)
    const maxY = Math.max(...ye)

    const zoom = s.zoomLevel
    const cw = s.containerSize.width
    const ch = s.containerSize.height
    const off = s.viewportOffset
    const vpL = -off.x / zoom
    const vpT = -off.y / zoom
    const vpR = vpL + cw / zoom
    const vpB = vpT + ch / zoom

    const worldMinX = Math.min(minX, vpL) - 100
    const worldMinY = Math.min(minY, vpT) - 100
    const worldMaxX = Math.max(maxX, vpR) + 100
    const worldMaxY = Math.max(maxY, vpB) + 100
    const worldW = worldMaxX - worldMinX
    const worldH = worldMaxY - worldMinY

    const innerW = this.size.w - PADDING * 2
    const innerH = this.size.h - PADDING * 2
    const scale = Math.min(innerW / worldW, innerH / worldH)

    this.layout = {
      worldMinX,
      worldMinY,
      scale,
      zoomLevel: zoom,
      containerWidth: cw,
      containerHeight: ch,
    }

    const toMiniX = (x: number) => PADDING + (x - worldMinX) * scale
    const toMiniY = (y: number) => PADDING + (y - worldMinY) * scale

    this.content.replaceChildren()

    for (const region of regionList) {
      const d = document.createElement('div')
      d.style.position = 'absolute'
      d.style.left = `${toMiniX(region.origin.x)}px`
      d.style.top = `${toMiniY(region.origin.y)}px`
      d.style.width = `${Math.max(region.size.width * scale, 3)}px`
      d.style.height = `${Math.max(region.size.height * scale, 3)}px`
      d.style.border = `1px solid ${region.color.replace(/[\d.]+\)$/, '0.5)')}`
      d.style.borderRadius = '1px'
      d.style.backgroundColor = region.color.replace(/[\d.]+\)$/, '0.15)')
      this.content.appendChild(d)
    }

    for (const node of nodeList) {
      const d = document.createElement('div')
      const w = Math.max(node.size.width * scale, 2)
      const h = Math.max(node.size.height * scale, 2)
      d.style.position = 'absolute'
      d.style.left = `${toMiniX(node.origin.x)}px`
      d.style.top = `${toMiniY(node.origin.y)}px`
      d.style.width = `${w}px`
      d.style.height = `${h}px`
      d.style.backgroundColor = node.color || 'var(--minimap-node)'
      d.style.borderRadius = '1px'
      d.style.cursor = 'pointer'
      // A terminal hosting a coding agent takes its activity color (+ a tiny
      // animated runner when the rect is large enough to fit one).
      const rec = s.agents[node.id]
      if (rec?.agent) {
        const meta = AGENT_ACTIVITY_META[rec.activity]
        d.classList.add('minimap-agent', `agent-${rec.activity}`)
        d.style.setProperty('--agent-color', meta.color)
        d.style.backgroundColor = meta.color
        if (w >= 16 && h >= 12) {
          const runner = document.createElement('div')
          runner.className = `mm-runner runner-${meta.runner}`
          d.appendChild(runner)
        }
      }
      d.addEventListener('mousedown', (e) => {
        e.stopPropagation()
        e.preventDefault()
        this.store.focusAndCenter(node.id)
      })
      this.content.appendChild(d)
    }

    this.updateViewportRect(s)
  }

  private updateViewportRect(s: CanvasData): void {
    const { worldMinX, worldMinY, scale, zoomLevel, containerWidth, containerHeight } = this.layout
    if (!Number.isFinite(scale) || scale <= 0) return
    const vpL = -s.viewportOffset.x / zoomLevel
    const vpT = -s.viewportOffset.y / zoomLevel
    const el = this.viewportRect.style
    el.left = `${PADDING + (vpL - worldMinX) * scale}px`
    el.top = `${PADDING + (vpT - worldMinY) * scale}px`
    el.width = `${(containerWidth / zoomLevel) * scale}px`
    el.height = `${(containerHeight / zoomLevel) * scale}px`
  }

  // ---- Navigation (click / drag on the map body) ---------------------------

  private onNavigateDown(e: MouseEvent): void {
    e.stopPropagation()
    const rect = this.root.getBoundingClientRect()
    const { worldMinX, worldMinY, scale } = this.layout
    const navigate = (clientX: number, clientY: number) => {
      const st = this.store.getState()
      const canvasX = (clientX - rect.left - PADDING) / scale + worldMinX
      const canvasY = (clientY - rect.top - PADDING) / scale + worldMinY
      this.store.setViewportOffset({
        x: st.containerSize.width / 2 - canvasX * st.zoomLevel,
        y: st.containerSize.height / 2 - canvasY * st.zoomLevel,
      })
    }
    navigate(e.clientX, e.clientY)
    const move = (ev: MouseEvent) => navigate(ev.clientX, ev.clientY)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onResizeDown(e: MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = this.size.w
    const startH = this.size.h
    const signX = this.corner.endsWith('right') ? -1 : 1
    const signY = this.corner.startsWith('bottom') ? -1 : 1
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) * signX
      const dy = (ev.clientY - startY) * signY
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + dx))
      const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH + dy))
      this.size = { w, h }
      this.applyCornerAndSize()
      this.rebuild(this.store.getState())
      if (this.sizeDebounce) clearTimeout(this.sizeDebounce)
      this.sizeDebounce = setTimeout(() => {
        try { localStorage.setItem(SIZE_KEY, JSON.stringify(this.size)) } catch {}
      }, 500)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onMoveDown(e: MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const move = (ev: MouseEvent) => {
      const cs = this.store.getState().containerSize
      const right = ev.clientX > cs.width / 2
      const bottom = ev.clientY > cs.height / 2
      const next: Corner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as Corner
      if (next !== this.corner) {
        this.corner = next
        this.applyCornerAndSize()
        this.rebuild(this.store.getState())
        if (this.cornerDebounce) clearTimeout(this.cornerDebounce)
        this.cornerDebounce = setTimeout(() => {
          try { localStorage.setItem(CORNER_KEY, next) } catch {}
        }, 500)
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  destroy(): void {
    this.unsubscribe()
    this.root.remove()
  }
}
