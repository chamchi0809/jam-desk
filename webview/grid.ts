// =============================================================================
// CanvasGrid — screen-space CSS-background grid (dots or lines).
//
// Renders OUTSIDE the world transform so the pattern always lands on whole
// device pixels and looks identical at every zoom level. The pattern step is
// computed in screen px (BASE_SPACING * zoom); background-position slides the
// pattern with the pan offset. Pan updates the position imperatively (no full
// rebuild), matching Cate's CanvasGrid.
// =============================================================================

import { CANVAS_GRID_SIZE } from './types'
import { settings } from './settings'
import type { CanvasStore } from './store'

const BASE_SPACING = CANVAS_GRID_SIZE
const MIN_SCREEN_STEP = 16

export class CanvasGrid {
  private el: HTMLDivElement
  private unsubscribe: () => void

  constructor(parent: HTMLElement, private store: CanvasStore) {
    this.el = document.createElement('div')
    this.el.className = 'canvas-grid'
    parent.appendChild(this.el)

    this.render()

    const state0 = store.getState()
    this.el.style.backgroundPosition = `${state0.viewportOffset.x}px ${state0.viewportOffset.y}px`

    this.unsubscribe = store.subscribe((state, prev) => {
      if (state.zoomLevel !== prev.zoomLevel) {
        this.render()
      }
      if (state.viewportOffset !== prev.viewportOffset) {
        this.el.style.backgroundPosition = `${state.viewportOffset.x}px ${state.viewportOffset.y}px`
      }
    })
  }

  /** Re-evaluate the pattern (style + LOD step). Called on zoom and on settings change. */
  render(): void {
    const style = settings.gridStyle
    if (style === 'none') {
      this.el.style.display = 'none'
      return
    }
    this.el.style.display = 'block'

    const zoom = this.store.getState().zoomLevel
    // LOD: when zoomed out, double the canvas-space spacing until the on-screen
    // step is comfortably readable.
    let canvasStep = BASE_SPACING
    while (canvasStep * zoom < MIN_SCREEN_STEP) canvasStep *= 2
    const step = canvasStep * zoom

    this.el.style.backgroundImage =
      style === 'lines'
        ? `linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)`
        : `radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)`
    this.el.style.backgroundSize = `${step}px ${step}px`
  }

  destroy(): void {
    this.unsubscribe()
    this.el.remove()
  }
}
