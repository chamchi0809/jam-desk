// =============================================================================
// CanvasInteraction — pan / zoom / inertia / marquee / context-menu handling
// for the canvas surface. Ported from the upstream IDE's useCanvasInteraction.ts, with
// React refs collapsed to instance fields and native DOM events.
//
//  - Trackpad two-finger scroll  → pan        (rAF-throttled)
//  - Physical mouse wheel         → cursor-anchored smooth zoom
//  - Cmd/Ctrl + scroll, pinch     → cursor-anchored smooth zoom
//  - Right / middle drag          → pan with velocity-buffer inertia
//  - Hand tool / Space-hold       → left-drag pans
//  - Select tool                  → left-drag on background marquees
//  - Right-click (no drag)        → context menu on empty canvas
// =============================================================================

import { ZOOM_MIN, ZOOM_MAX } from './types'
import type { Point } from './types'
import { viewToCanvas } from './coordinates'
import { isMouseWheel, type WheelLike } from './wheelIntent'
import { settings } from './settings'
import type { CanvasStore } from './store'

const RIGHT_CLICK_DRAG_THRESHOLD = 4
const MOUSE_WHEEL_ZOOM_FACTOR = 0.15

function rectsIntersect(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return !(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay)
}

export interface ContextMenuRequest {
  x: number
  y: number
  canvasPoint: Point
}

export interface InteractionHooks {
  /** Fired on right-click over empty canvas (no drag). Host shows a DOM menu. */
  onContextMenu?: (req: ContextMenuRequest) => void
  /** Dismiss any open context menu (e.g. when a pan/zoom/marquee begins). */
  onCloseContextMenu?: () => void
}

export class CanvasInteraction {
  // Pan state
  private isPanning = false
  private lastPanPos: { x: number; y: number } | null = null
  private panButton: number | null = null

  // Right-click drag detection
  private rightClickStart: { x: number; y: number } | null = null
  private rightClickDidDrag = false

  // Momentum / inertia — circular buffer avoids shift() per mousemove
  private velocityBuffer: Array<{ dx: number; dy: number; time: number }> = new Array(5)
  private velocityIndex = 0
  private velocityCount = 0
  private cancelInertia: (() => void) | null = null

  // Smooth zoom
  private targetZoom: number | null = null
  private zoomRafId = 0
  private cursorViewPoint = { x: 0, y: 0 }

  // Wheel-pan throttle
  private panRafId = 0
  private pendingPanDelta = { x: 0, y: 0 }
  private wheelPanActive = false
  private wheelPanEndTimer: ReturnType<typeof setTimeout> | null = null

  // Marquee
  private marqueeEl: HTMLDivElement | null = null

  /** Set by the keyboard layer: Space-hold temporarily forces the hand tool. */
  spaceHeld = false

  private onWheelNative = (e: WheelEvent) => this.handleWheel(e)
  private onMouseDownNative = (e: MouseEvent) => this.handleMouseDown(e)
  private onMouseMoveNative = (e: MouseEvent) => this.handleMouseMove(e)
  private onMouseUpNative = (e: MouseEvent) => this.handleMouseUp(e)
  private onContextMenuNative = (e: MouseEvent) => e.preventDefault()

  constructor(
    private canvasEl: HTMLElement,
    private world: HTMLElement,
    private store: CanvasStore,
    private hooks: InteractionHooks = {},
  ) {
    // passive:false so preventDefault on wheel actually suppresses page zoom/scroll.
    canvasEl.addEventListener('wheel', this.onWheelNative, { capture: true, passive: false })
    canvasEl.addEventListener('mousedown', this.onMouseDownNative)
    canvasEl.addEventListener('mousemove', this.onMouseMoveNative)
    canvasEl.addEventListener('mouseup', this.onMouseUpNative)
    canvasEl.addEventListener('contextmenu', this.onContextMenuNative)
  }

  private effectiveTool(): 'select' | 'hand' {
    return this.spaceHeld ? 'hand' : this.store.getState().tool
  }

  private rect(): DOMRect {
    return this.canvasEl.getBoundingClientRect()
  }

  // ---- Smooth zoom ----------------------------------------------------------

  private smoothZoomTick = () => {
    if (this.targetZoom === null) return
    const state = this.store.getState()
    const current = state.zoomLevel
    const target = this.targetZoom
    const diff = target - current

    if (Math.abs(diff) < 0.001) {
      const canvasPoint = viewToCanvas(this.cursorViewPoint, current, state.viewportOffset)
      this.store.setZoomAndOffset(target, {
        x: this.cursorViewPoint.x - canvasPoint.x * target,
        y: this.cursorViewPoint.y - canvasPoint.y * target,
      })
      this.targetZoom = null
      this.zoomRafId = 0
      return
    }

    const newZoom = current + diff * 0.15
    const canvasPoint = viewToCanvas(this.cursorViewPoint, current, state.viewportOffset)
    this.store.setZoomAndOffset(newZoom, {
      x: this.cursorViewPoint.x - canvasPoint.x * newZoom,
      y: this.cursorViewPoint.y - canvasPoint.y * newZoom,
    })
    this.zoomRafId = requestAnimationFrame(this.smoothZoomTick)
  }

  private applyWheelZoom(e: WheelEvent, mouse: boolean): void {
    e.preventDefault()
    e.stopPropagation()
    if (this.cancelInertia) {
      this.cancelInertia()
      this.cancelInertia = null
    }
    this.store.cancelZoomAnimation()

    const rect = this.rect()
    this.cursorViewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    const { zoomLevel } = this.store.getState()
    const zoomSpeed = settings.zoomSpeed
    const base = this.targetZoom ?? zoomLevel
    const next = mouse
      ? base * (1 + Math.sign(-e.deltaY) * MOUSE_WHEEL_ZOOM_FACTOR * zoomSpeed)
      : base + -e.deltaY * 0.01 * zoomSpeed

    this.targetZoom = Math.min(Math.max(next, ZOOM_MIN), ZOOM_MAX)
    if (!this.zoomRafId) {
      this.zoomRafId = requestAnimationFrame(this.smoothZoomTick)
    }
  }

  // ---- Wheel: pan vs zoom ---------------------------------------------------

  private handleWheel(e: WheelEvent): void {
    const target = e.target as HTMLElement
    const mouse = isMouseWheel(e as unknown as WheelLike)

    // Explicit zoom intent: trackpad pinch (ctrlKey) or Cmd/Ctrl+scroll.
    if (e.metaKey || e.ctrlKey) {
      this.applyWheelZoom(e, mouse)
      return
    }

    // Plain scroll over a FOCUSED node's scrollable content: let it scroll.
    const nodeContent = target.closest?.('[data-node-content]') as HTMLElement | null
    if (nodeContent) {
      const nodeEl = nodeContent.closest('[data-node-id]')
      const nodeId = nodeEl?.getAttribute('data-node-id')
      const focusedNodeId = this.store.getState().focusedNodeId
      if (nodeId && nodeId === focusedNodeId) {
        // Terminal: xterm owns the wheel entirely (scrollback scrolling, or
        // arrow-key emulation in the alternate buffer). Its real scroller is
        // the inner .xterm-viewport, so the content-box check below would
        // never match — let the event through untouched instead.
        if (target.closest('.cnode-terminal')) return
        const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        const canScroll = isHorizontal
          ? nodeContent.scrollWidth > nodeContent.clientWidth
          : nodeContent.scrollHeight > nodeContent.clientHeight
        if (canScroll) return // node content handles it
      }
    }

    // Physical mouse wheel over empty canvas / unfocused node → zoom.
    if (mouse) {
      this.applyWheelZoom(e, true)
      return
    }

    // Otherwise: trackpad two-finger scroll pans the canvas.
    e.preventDefault()
    e.stopPropagation()
    this.hooks.onCloseContextMenu?.()
    if (!this.wheelPanActive) {
      this.wheelPanActive = true
      document.body.classList.add('canvas-interacting')
    }
    if (this.wheelPanEndTimer) clearTimeout(this.wheelPanEndTimer)
    this.wheelPanEndTimer = setTimeout(() => {
      this.wheelPanEndTimer = null
      this.wheelPanActive = false
      document.body.classList.remove('canvas-interacting')
    }, 150)

    this.pendingPanDelta.x += e.deltaX
    this.pendingPanDelta.y += e.deltaY
    if (!this.panRafId) {
      this.panRafId = requestAnimationFrame(() => {
        this.panRafId = 0
        const dx = this.pendingPanDelta.x
        const dy = this.pendingPanDelta.y
        this.pendingPanDelta.x = 0
        this.pendingPanDelta.y = 0
        const vo = this.store.getState().viewportOffset
        this.store.setViewportOffset({ x: vo.x - dx, y: vo.y - dy })
      })
    }
  }

  // ---- Mouse down -----------------------------------------------------------

  private handleMouseDown(e: MouseEvent): void {
    if (e.button === 2 || e.button === 1) {
      // Right / middle button → pan (with inertia for right button).
      if (this.cancelInertia) {
        this.cancelInertia()
        this.cancelInertia = null
      }
      this.isPanning = true
      this.panButton = e.button
      this.lastPanPos = { x: e.clientX, y: e.clientY }
      if (e.button === 2) {
        this.rightClickStart = { x: e.clientX, y: e.clientY }
        this.rightClickDidDrag = false
        this.velocityIndex = 0
        this.velocityCount = 0
      }
      this.canvasEl.style.cursor = 'grabbing'
      document.body.classList.add('canvas-interacting')
      this.hooks.onCloseContextMenu?.()
      e.preventDefault()
      return
    }

    if (e.button !== 0) return

    // Hand tool (or Space-hold): left-drag pans, even over a node.
    if (this.effectiveTool() === 'hand') {
      if (this.cancelInertia) {
        this.cancelInertia()
        this.cancelInertia = null
      }
      this.isPanning = true
      this.panButton = 0
      this.lastPanPos = { x: e.clientX, y: e.clientY }
      this.canvasEl.style.cursor = 'grabbing'
      document.body.classList.add('canvas-interacting')
      this.hooks.onCloseContextMenu?.()
      e.preventDefault()
      return
    }

    // Select tool: left-click on empty background → marquee or clear.
    const target = e.target as HTMLElement
    const isOnNode = target.closest('[data-node-id]') !== null
    const isOnRegion = target.closest('[data-region-id]') !== null
    if (isOnNode || isOnRegion) return

    this.hooks.onCloseContextMenu?.()
    const rect = this.rect()
    const { zoomLevel, viewportOffset } = this.store.getState()
    const startCanvasX = (e.clientX - rect.left - viewportOffset.x) / zoomLevel
    const startCanvasY = (e.clientY - rect.top - viewportOffset.y) / zoomLevel
    const startClientX = e.clientX
    const startClientY = e.clientY
    const shiftHeld = e.shiftKey
    let didDrag = false

    const handleMarqueeMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startClientX
      const dy = ev.clientY - startClientY
      if (!didDrag && Math.sqrt(dx * dx + dy * dy) >= 4) didDrag = true
      if (didDrag) {
        const { zoomLevel: z, viewportOffset: vo } = this.store.getState()
        const r = this.rect()
        const currentCanvasX = (ev.clientX - r.left - vo.x) / z
        const currentCanvasY = (ev.clientY - r.top - vo.y) / z
        this.renderMarquee(startCanvasX, startCanvasY, currentCanvasX, currentCanvasY)
      }
    }

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMarqueeMove)
      window.removeEventListener('mouseup', handleMarqueeUp)
      window.removeEventListener('blur', handleMarqueeBlur)
    }

    const handleMarqueeBlur = () => {
      cleanup()
      this.clearMarquee()
    }

    const handleMarqueeUp = (ev: MouseEvent) => {
      cleanup()
      this.clearMarquee()

      if (!didDrag) {
        this.store.clearSelection()
        this.store.unfocus()
        return
      }

      const { zoomLevel: z, viewportOffset: vo, nodes, regions } = this.store.getState()
      const r = this.rect()
      const endCanvasX = (ev.clientX - r.left - vo.x) / z
      const endCanvasY = (ev.clientY - r.top - vo.y) / z
      const mx = Math.min(startCanvasX, endCanvasX)
      const my = Math.min(startCanvasY, endCanvasY)
      const mw = Math.abs(endCanvasX - startCanvasX)
      const mh = Math.abs(endCanvasY - startCanvasY)

      const hitNodeIds = Object.values(nodes)
        .filter((n) => rectsIntersect(mx, my, mw, mh, n.origin.x, n.origin.y, n.size.width, n.size.height))
        .map((n) => n.id)
      const hitRegionIds = Object.values(regions)
        .filter((rg) => rectsIntersect(mx, my, mw, mh, rg.origin.x, rg.origin.y, rg.size.width, rg.size.height))
        .map((rg) => rg.id)

      if (!shiftHeld) this.store.clearSelection()
      this.store.selectNodes(hitNodeIds, true)
      this.store.selectRegions(hitRegionIds, true)
    }

    window.addEventListener('mousemove', handleMarqueeMove)
    window.addEventListener('mouseup', handleMarqueeUp)
    window.addEventListener('blur', handleMarqueeBlur)
  }

  // ---- Mouse move (pan) -----------------------------------------------------

  private handleMouseMove(e: MouseEvent): void {
    if (!this.isPanning || !this.lastPanPos) return

    if (!this.rightClickDidDrag && this.rightClickStart) {
      const dx = e.clientX - this.rightClickStart.x
      const dy = e.clientY - this.rightClickStart.y
      if (Math.sqrt(dx * dx + dy * dy) > RIGHT_CLICK_DRAG_THRESHOLD) {
        this.rightClickDidDrag = true
      }
    }

    const dx = e.clientX - this.lastPanPos.x
    const dy = e.clientY - this.lastPanPos.y
    const vo = this.store.getState().viewportOffset
    this.store.setViewportOffset({ x: vo.x + dx, y: vo.y + dy })
    this.lastPanPos = { x: e.clientX, y: e.clientY }

    if (this.panButton === 2) {
      this.velocityBuffer[this.velocityIndex] = { dx, dy, time: performance.now() }
      this.velocityIndex = (this.velocityIndex + 1) % 5
      if (this.velocityCount < 5) this.velocityCount++
    }
  }

  // ---- Mouse up (context menu + inertia) ------------------------------------

  private handleMouseUp(e: MouseEvent): void {
    if (e.button === 2) {
      if (!this.rightClickDidDrag && this.rightClickStart) {
        const target = e.target as HTMLElement
        const isOnInteractive =
          target.closest('[data-node-id]') !== null || target.closest('[data-region-id]') !== null
        if (!isOnInteractive) {
          const rect = this.rect()
          const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
          const { zoomLevel, viewportOffset } = this.store.getState()
          const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
          this.hooks.onContextMenu?.({ x: e.clientX, y: e.clientY, canvasPoint })
        }
      }
    }

    if (e.button === 2 || e.button === this.panButton) {
      this.isPanning = false
      this.panButton = null
      this.lastPanPos = null
      this.rightClickStart = null
      this.canvasEl.style.cursor = this.effectiveTool() === 'hand' ? 'grab' : ''
      document.body.classList.remove('canvas-interacting')
    }

    if (e.button === 2) {
      if (this.cancelInertia) {
        this.cancelInertia()
        this.cancelInertia = null
      }
      if (this.rightClickDidDrag && this.velocityCount >= 2) {
        const now = performance.now()
        const recent: Array<{ dx: number; dy: number; time: number }> = []
        for (let i = 0; i < Math.min(3, this.velocityCount); i++) {
          const idx = (this.velocityIndex - 1 - i + 5) % 5
          recent.push(this.velocityBuffer[idx])
        }
        const validSamples = recent.filter((s) => now - s.time < 100)
        if (validSamples.length >= 2) {
          const avgDx = validSamples.reduce((sum, s) => sum + s.dx, 0) / validSamples.length
          const avgDy = validSamples.reduce((sum, s) => sum + s.dy, 0) / validSamples.length
          const speed = Math.hypot(avgDx, avgDy)
          if (speed > 2) {
            let velX = avgDx
            let velY = avgDy
            let lastTime = performance.now()
            const startTime = lastTime
            let rafId = 0
            const tick = () => {
              const now2 = performance.now()
              const dt = Math.min(now2 - lastTime, 32)
              lastTime = now2
              const factor = Math.pow(0.95, dt / 16.67)
              velX *= factor
              velY *= factor
              if ((Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) || now2 - startTime > 500) {
                this.cancelInertia = null
                return
              }
              const vo = this.store.getState().viewportOffset
              const scale = dt / 16.67
              this.store.setViewportOffset({ x: vo.x + velX * scale, y: vo.y + velY * scale })
              rafId = requestAnimationFrame(tick)
            }
            rafId = requestAnimationFrame(tick)
            this.cancelInertia = () => {
              if (rafId) cancelAnimationFrame(rafId)
            }
          }
        }
      }
      this.velocityIndex = 0
      this.velocityCount = 0
    }
  }

  // ---- Marquee rendering ----------------------------------------------------

  private renderMarquee(sx: number, sy: number, cx: number, cy: number): void {
    if (!this.marqueeEl) {
      this.marqueeEl = document.createElement('div')
      this.marqueeEl.className = 'marquee'
      this.world.appendChild(this.marqueeEl)
    }
    const x = Math.min(sx, cx)
    const y = Math.min(sy, cy)
    const w = Math.abs(cx - sx)
    const h = Math.abs(cy - sy)
    const s = this.marqueeEl.style
    s.left = `${x}px`
    s.top = `${y}px`
    s.width = `${w}px`
    s.height = `${h}px`
  }

  private clearMarquee(): void {
    if (this.marqueeEl) {
      this.marqueeEl.remove()
      this.marqueeEl = null
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  cancelAllAnimations(): void {
    if (this.cancelInertia) {
      this.cancelInertia()
      this.cancelInertia = null
    }
    if (this.zoomRafId) {
      cancelAnimationFrame(this.zoomRafId)
      this.zoomRafId = 0
    }
    this.targetZoom = null
    if (this.panRafId) {
      cancelAnimationFrame(this.panRafId)
      this.panRafId = 0
    }
    this.pendingPanDelta = { x: 0, y: 0 }
    if (this.wheelPanEndTimer) {
      clearTimeout(this.wheelPanEndTimer)
      this.wheelPanEndTimer = null
    }
    if (this.wheelPanActive) {
      document.body.classList.remove('canvas-interacting')
      this.wheelPanActive = false
    }
    this.store.cancelZoomAnimation()
  }

  destroy(): void {
    this.cancelAllAnimations()
    this.clearMarquee()
    this.canvasEl.removeEventListener('wheel', this.onWheelNative, { capture: true } as EventListenerOptions)
    this.canvasEl.removeEventListener('mousedown', this.onMouseDownNative)
    this.canvasEl.removeEventListener('mousemove', this.onMouseMoveNative)
    this.canvasEl.removeEventListener('mouseup', this.onMouseUpNative)
    this.canvasEl.removeEventListener('contextmenu', this.onContextMenuNative)
  }
}
