// =============================================================================
// SnapGuidesLayer — renders alignment guide lines inside the world transform
// at canvas-space positions. Edge guides are solid; center guides are dashed.
// Ported from Cate's SnapGuides.tsx.
// =============================================================================

import type { CanvasStore } from './store'
import type { SnapGuides } from './types'

const COLOR = 'rgba(74, 158, 255, 0.7)'
const EXTENT = 100000

export class SnapGuidesLayer {
  private el: HTMLDivElement
  private unsubscribe: () => void
  private lastRef: SnapGuides | null = null

  constructor(world: HTMLElement, store: CanvasStore) {
    this.el = document.createElement('div')
    this.el.className = 'snap-guides'
    this.el.style.position = 'absolute'
    this.el.style.left = '0'
    this.el.style.top = '0'
    this.el.style.pointerEvents = 'none'
    world.appendChild(this.el)

    this.render(store.getState().snapGuides)
    this.unsubscribe = store.subscribe((state) => {
      if (state.snapGuides !== this.lastRef) {
        this.render(state.snapGuides)
      }
    })
  }

  private render(guides: SnapGuides): void {
    this.lastRef = guides
    this.el.replaceChildren()
    for (const line of guides.lines) {
      const div = document.createElement('div')
      div.style.position = 'absolute'
      div.style.pointerEvents = 'none'
      const dashed = line.type === 'center'
      if (line.axis === 'x') {
        div.style.left = `${line.position}px`
        div.style.top = `${-EXTENT / 2}px`
        div.style.width = '1px'
        div.style.height = `${EXTENT}px`
        if (dashed) {
          div.style.backgroundImage = `repeating-linear-gradient(to bottom, ${COLOR} 0px, ${COLOR} 6px, transparent 6px, transparent 12px)`
        } else {
          div.style.backgroundColor = COLOR
        }
      } else {
        div.style.left = `${-EXTENT / 2}px`
        div.style.top = `${line.position}px`
        div.style.width = `${EXTENT}px`
        div.style.height = '1px'
        if (dashed) {
          div.style.backgroundImage = `repeating-linear-gradient(to right, ${COLOR} 0px, ${COLOR} 6px, transparent 6px, transparent 12px)`
        } else {
          div.style.backgroundColor = COLOR
        }
      }
      this.el.appendChild(div)
    }
  }

  destroy(): void {
    this.unsubscribe()
    this.el.remove()
  }
}
