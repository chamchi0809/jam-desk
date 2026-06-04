// =============================================================================
// CanvasView — DOM reconciler for nodes & regions inside the world transform.
//
// Renders each node/region as an absolutely-positioned element at canvas-space
// coordinates (the world div's transform maps canvas → screen). On every store
// change it diffs which slice moved (nodes / regions / focus / selection /
// drop-target) and updates only the affected elements in place — creating
// elements for new ids and removing them for vanished ids (after the exit
// animation for nodes).
//
// Gestures (drag, resize, region drag/resize) are delegated to gestures.ts.
// The DOM contract with interaction.ts is honored: nodes carry `data-node-id`,
// regions carry `data-region-id`, scrollable content carries `data-node-content`,
// and node/region mousedown handlers bail WITHOUT stopPropagation for non-left
// buttons and under the hand tool, so the canvas pan handler still receives them.
// =============================================================================

import type { CanvasStore, CanvasData } from './store'
import type { CanvasNodeState, CanvasRegion } from './types'
import { detectEdge, getCursorForEdge } from './resizeEdge'
import {
  beginNodeDrag,
  beginNodeResize,
  beginRegionDrag,
  beginRegionResize,
} from './gestures'
import { isMaximized } from './types'
import { TerminalController } from './terminalView'
import type { TerminalBridge } from './terminalView'
import { icons } from './icons'
import { t } from './i18n'

export interface CanvasViewHooks {
  /** Open a workspace file (file-card "open" / double-click). */
  onOpenFile?: (filePath: string) => void
  /** Bridge to the host PTY backend, used by `terminal` nodes. */
  terminals?: TerminalBridge
}

interface NodeElements {
  container: HTMLDivElement
  card: HTMLDivElement
  titleEl: HTMLSpanElement
  pinBtn: HTMLButtonElement
  maxBtn: HTMLButtonElement
  content: HTMLDivElement
  // note
  textarea?: HTMLTextAreaElement
  // file
  fileNameEl?: HTMLSpanElement
  filePathEl?: HTMLSpanElement
  // terminal
  terminal?: TerminalController
  animState?: string
  // Cancellable finalize timer for the exit animation (independent of any opacity
  // transition, so it fires even when opacity stays 0→0). Cleared if the node is
  // restored (e.g. undo) before it runs.
  exitTimer?: number
  // The entering flip-to-idle double-rAF, captured so it can be cancelled if the
  // node starts exiting before it fires (otherwise it would resurrect the node).
  enterRafOuter?: number
  enterRafInner?: number
}

/** Exit-animation duration before the node is removed from the store/DOM.
 * Matches the upstream IDE's setTimeout(200) finalize and comfortably outlasts the 0.18s
 * CSS opacity/transform transition. */
const EXIT_ANIM_MS = 200

interface RegionElements {
  container: HTMLDivElement
  labelBar: HTMLDivElement
  labelText: HTMLSpanElement
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

function effectiveToolOf(store: CanvasStore, spaceHeld: () => boolean): 'select' | 'hand' {
  return spaceHeld() ? 'hand' : store.getState().tool
}

export class CanvasView {
  private nodeEls = new Map<string, NodeElements>()
  private regionEls = new Map<string, RegionElements>()
  private unsubscribe: () => void

  /** Provided by main: reports whether Space is currently held (hand override). */
  spaceHeld: () => boolean = () => false

  constructor(
    private world: HTMLElement,
    private store: CanvasStore,
    private hooks: CanvasViewHooks = {},
  ) {
    const s = store.getState()
    this.reconcileRegions(s)
    this.reconcileNodes(s)

    this.unsubscribe = store.subscribe((next, prev) => {
      if (
        next.regions !== prev.regions ||
        next.selectedRegionIds !== prev.selectedRegionIds ||
        next.selectedNodeIds !== prev.selectedNodeIds ||
        next.dropTargetRegionId !== prev.dropTargetRegionId
      ) {
        this.reconcileRegions(next)
      }
      if (
        next.nodes !== prev.nodes ||
        next.focusedNodeId !== prev.focusedNodeId ||
        next.selectedNodeIds !== prev.selectedNodeIds
      ) {
        this.reconcileNodes(next)
      }
      // When a terminal node becomes the focused node (created, command, or
      // Tab/arrow navigation), move DOM focus into its xterm so keystrokes go
      // to the shell instead of being swallowed as canvas shortcuts. Keyed on
      // focusEpoch too, so re-focusing the same id re-applies. The controller
      // defers focus() until mount() if it isn't open yet.
      if (
        next.focusedNodeId &&
        (next.focusedNodeId !== prev.focusedNodeId || next.focusEpoch !== prev.focusEpoch)
      ) {
        this.nodeEls.get(next.focusedNodeId)?.terminal?.focus()
      }
    })
  }

  // ---- Nodes ---------------------------------------------------------------

  private reconcileNodes(s: CanvasData): void {
    const seen = new Set<string>()
    for (const node of Object.values(s.nodes)) {
      seen.add(node.id)
      let el = this.nodeEls.get(node.id)
      if (!el) {
        el = this.createNodeElement(node)
        this.nodeEls.set(node.id, el)
        this.world.appendChild(el.container)
      }
      this.updateNodeElement(el, node, s)
    }
    for (const [id, el] of this.nodeEls) {
      if (!seen.has(id)) {
        this.clearNodeTimers(el)
        el.terminal?.dispose()
        el.container.remove()
        this.nodeEls.delete(id)
      }
    }
  }

  /** Cancel any pending enter-rAF / exit-finalize timer for a node element. */
  private clearNodeTimers(el: NodeElements): void {
    if (el.exitTimer != null) {
      clearTimeout(el.exitTimer)
      el.exitTimer = undefined
    }
    if (el.enterRafOuter != null) {
      cancelAnimationFrame(el.enterRafOuter)
      el.enterRafOuter = undefined
    }
    if (el.enterRafInner != null) {
      cancelAnimationFrame(el.enterRafInner)
      el.enterRafInner = undefined
    }
  }

  private createNodeElement(node: CanvasNodeState): NodeElements {
    const container = document.createElement('div')
    container.className = 'cnode'
    container.setAttribute('data-node-id', node.id)
    container.style.position = 'absolute'

    const card = document.createElement('div')
    card.className = 'cnode-card'

    const titlebar = document.createElement('div')
    titlebar.className = 'cnode-titlebar'
    titlebar.setAttribute('data-grab', '')

    const titleEl = document.createElement('span')
    titleEl.className = 'cnode-title'

    const actions = document.createElement('div')
    actions.className = 'cnode-actions'

    const pinBtn = document.createElement('button')
    pinBtn.className = 'cnode-btn'
    pinBtn.title = t('pin')
    pinBtn.innerHTML = icons.pin
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.togglePin(node.id)
    })

    const maxBtn = document.createElement('button')
    maxBtn.className = 'cnode-btn'
    maxBtn.title = t('maximize')
    maxBtn.innerHTML = icons.arrowsMaximize
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.toggleMaximize(node.id, this.store.getState().containerSize)
    })

    const closeBtn = document.createElement('button')
    closeBtn.className = 'cnode-btn cnode-btn-close'
    closeBtn.title = t('close')
    closeBtn.innerHTML = icons.x
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.removeNode(node.id)
    })

    actions.append(pinBtn, maxBtn, closeBtn)
    titlebar.append(titleEl, actions)

    const content = document.createElement('div')
    content.className = 'cnode-content'
    content.setAttribute('data-node-content', '')

    const el: NodeElements = { container, card, titleEl, pinBtn, maxBtn, content }

    if (node.kind === 'note') {
      const ta = document.createElement('textarea')
      ta.className = 'cnode-note'
      ta.placeholder = t('notePlaceholder')
      ta.spellcheck = false
      ta.addEventListener('focus', () => {
        // One undo step per editing session.
        this.store.pushHistory()
      })
      ta.addEventListener('input', () => {
        this.store.setNodeText(node.id, ta.value)
      })
      // Let text selection / caret work without starting a node drag.
      ta.addEventListener('mousedown', (e) => e.stopPropagation())
      content.appendChild(ta)
      el.textarea = ta
    } else if (node.kind === 'terminal') {
      container.classList.add('is-terminal')
      const host = document.createElement('div')
      host.className = 'cnode-terminal'
      content.appendChild(host)
      if (this.hooks.terminals) {
        const ctrl = new TerminalController(node.id, this.hooks.terminals, node.cwd)
        el.terminal = ctrl
        // Mount after this element is attached + sized so the first fit() is correct.
        requestAnimationFrame(() => ctrl.mount(host))
      } else {
        host.textContent = t('terminalUnavailable')
      }
    } else {
      const file = document.createElement('div')
      file.className = 'cnode-file'
      const icon = document.createElement('div')
      icon.className = 'cnode-file-icon'
      icon.innerHTML = icons.file
      const nameEl = document.createElement('span')
      nameEl.className = 'cnode-file-name'
      const pathEl = document.createElement('span')
      pathEl.className = 'cnode-file-path'
      const openBtn = document.createElement('button')
      openBtn.className = 'cnode-file-open'
      openBtn.textContent = t('open')
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fp = this.store.getState().nodes[node.id]?.filePath
        if (fp) this.hooks.onOpenFile?.(fp)
      })
      file.append(icon, nameEl, pathEl, openBtn)
      content.appendChild(file)
      content.addEventListener('dblclick', () => {
        const fp = this.store.getState().nodes[node.id]?.filePath
        if (fp) this.hooks.onOpenFile?.(fp)
      })
      el.fileNameEl = nameEl
      el.filePathEl = pathEl
    }

    card.append(titlebar, content)
    container.appendChild(card)

    // ---- Pointer wiring --------------------------------------------------
    container.addEventListener('mousedown', (e) => this.onNodeMouseDown(e, node.id))
    container.addEventListener('mousemove', (e) => this.onNodeMouseMove(e, node.id))

    return el
  }

  private onNodeMouseDown(e: MouseEvent, id: string): void {
    if (e.button !== 0) return // right/middle → bubble to canvas pan
    if (effectiveToolOf(this.store, this.spaceHeld) === 'hand') return // bubble → pan

    const node = this.store.getState().nodes[id]
    if (!node) return
    const target = e.target as HTMLElement

    // Buttons handle their own click; don't drag/resize.
    if (target.closest('button')) {
      e.stopPropagation()
      return
    }

    // Selection.
    if (e.shiftKey) {
      e.stopPropagation()
      this.store.toggleNodeSelection(id)
      this.store.focusNode(id)
      return
    }
    if (!this.store.getState().selectedNodeIds.has(id)) {
      this.store.selectNodes([id])
    }
    this.store.focusNode(id)

    // Resize (edge hit) — unless pinned.
    if (!node.isPinned) {
      const edge = this.edgeAt(e, id)
      if (edge) {
        beginNodeResize(this.store, id, edge, e)
        return
      }
    }

    // Drag from the title bar or the (non-content) card body.
    const onContent = target.closest('[data-node-content]')
    const onTitlebar = target.closest('[data-grab]')
    if (onTitlebar || !onContent) {
      beginNodeDrag(this.store, id, e)
      return
    }

    // Clicked inside scrollable content (e.g. textarea / terminal): focus only;
    // keep the canvas from clearing selection, but allow the caret to land.
    this.nodeEls.get(id)?.terminal?.focus()
    e.stopPropagation()
  }

  private onNodeMouseMove(e: MouseEvent, id: string): void {
    const el = this.nodeEls.get(id)
    if (!el) return
    if (effectiveToolOf(this.store, this.spaceHeld) !== 'select') {
      el.container.style.cursor = ''
      return
    }
    const node = this.store.getState().nodes[id]
    if (!node || node.isPinned) {
      el.container.style.cursor = ''
      return
    }
    const edge = this.edgeAt(e, id)
    el.container.style.cursor = edge ? getCursorForEdge(edge) : ''
  }

  /** Edge hit-test in the node's local canvas coordinates. */
  private edgeAt(e: MouseEvent, id: string) {
    const el = this.nodeEls.get(id)
    const node = this.store.getState().nodes[id]
    if (!el || !node) return null
    const rect = el.container.getBoundingClientRect()
    const zoom = this.store.getState().zoomLevel
    const localX = (e.clientX - rect.left) / zoom
    const localY = (e.clientY - rect.top) / zoom
    return detectEdge(localX, localY, node.size.width, node.size.height, zoom)
  }

  private updateNodeElement(el: NodeElements, node: CanvasNodeState, s: CanvasData): void {
    const c = el.container
    c.style.left = `${node.origin.x}px`
    c.style.top = `${node.origin.y}px`
    c.style.width = `${node.size.width}px`
    c.style.height = `${node.size.height}px`
    c.style.zIndex = String(1000 + node.zOrder)

    // Title + content.
    const fallbackTitle =
      node.kind === 'note'
        ? t('defaultNote')
        : node.kind === 'terminal'
          ? t('defaultTerminal')
          : t('defaultFile')
    el.titleEl.textContent = node.title || fallbackTitle

    if (node.kind === 'note' && el.textarea) {
      const next = node.text ?? ''
      if (document.activeElement !== el.textarea && el.textarea.value !== next) {
        el.textarea.value = next
      }
    } else if (node.kind === 'file') {
      const fp = node.filePath ?? ''
      if (el.fileNameEl) el.fileNameEl.textContent = node.title || basename(fp) || t('defaultFile')
      if (el.filePathEl) el.filePathEl.textContent = fp
    }

    // Accent color (left border tint).
    c.style.setProperty('--node-accent', node.color || 'transparent')

    // Focus / selection state.
    const focused = s.focusedNodeId === node.id
    const selected = s.selectedNodeIds.has(node.id)
    c.classList.toggle('is-focused', focused)
    c.classList.toggle('is-selected', selected)
    c.classList.toggle('is-pinned', !!node.isPinned)
    c.classList.toggle('is-maximized', isMaximized(node))
    el.pinBtn.classList.toggle('is-active', !!node.isPinned)
    // Only swap the SVG when the maximize state actually flips — sync runs on
    // every store change and innerHTML would rebuild the icon DOM each time.
    const maxState = isMaximized(node) ? 'maximized' : 'normal'
    if (el.maxBtn.dataset.state !== maxState) {
      el.maxBtn.dataset.state = maxState
      el.maxBtn.innerHTML = maxState === 'maximized' ? icons.arrowsMinimize : icons.arrowsMaximize
    }

    // Enter / exit animation, driven by animationState.
    const anim = node.animationState ?? 'idle'
    if (anim !== el.animState) {
      // Cancel any in-flight enter flip-to-idle so it can't resurrect a node that
      // is now exiting (or otherwise changed state).
      if (el.enterRafOuter != null) {
        cancelAnimationFrame(el.enterRafOuter)
        el.enterRafOuter = undefined
      }
      if (el.enterRafInner != null) {
        cancelAnimationFrame(el.enterRafInner)
        el.enterRafInner = undefined
      }
      // Leaving 'exiting' (e.g. undo restored the node) → cancel the pending
      // finalize so the just-restored node is not deleted out from under the user.
      if (anim !== 'exiting' && el.exitTimer != null) {
        clearTimeout(el.exitTimer)
        el.exitTimer = undefined
      }

      c.classList.toggle('is-entering', anim === 'entering')
      c.classList.toggle('is-exiting', anim === 'exiting')

      if (anim === 'entering') {
        // Flip to idle on the next frame so the transform transitions in.
        el.enterRafOuter = requestAnimationFrame(() => {
          el.enterRafInner = requestAnimationFrame(() => {
            el.enterRafOuter = undefined
            el.enterRafInner = undefined
            this.store.setNodeAnimationState(node.id, 'idle')
          })
        })
      }
      if (anim === 'exiting' && el.exitTimer == null) {
        // Finalize on a fixed timer rather than a transitionend: works even when
        // computed opacity never changes (deleting a node that is still entering),
        // and is cancellable above if the node is restored first.
        el.exitTimer = window.setTimeout(() => {
          el.exitTimer = undefined
          this.store.finalizeRemoveNode(node.id)
        }, EXIT_ANIM_MS)
      }
      el.animState = anim
    }
  }

  // ---- Regions -------------------------------------------------------------

  private reconcileRegions(s: CanvasData): void {
    const seen = new Set<string>()
    for (const region of Object.values(s.regions)) {
      seen.add(region.id)
      let el = this.regionEls.get(region.id)
      if (!el) {
        el = this.createRegionElement(region)
        this.regionEls.set(region.id, el)
        this.world.appendChild(el.container)
      }
      this.updateRegionElement(el, region, s)
    }
    for (const [id, el] of this.regionEls) {
      if (!seen.has(id)) {
        el.container.remove()
        this.regionEls.delete(id)
      }
    }
  }

  private createRegionElement(region: CanvasRegion): RegionElements {
    const container = document.createElement('div')
    container.className = 'cregion'
    container.setAttribute('data-region-id', region.id)
    container.style.position = 'absolute'

    const labelBar = document.createElement('div')
    labelBar.className = 'cregion-label'
    labelBar.setAttribute('data-grab', '')

    const labelText = document.createElement('span')
    labelText.className = 'cregion-label-text'
    labelBar.appendChild(labelText)

    // Inline rename on double-click.
    labelBar.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.beginRegionRename(region.id, labelText)
    })

    container.appendChild(labelBar)

    container.addEventListener('mousedown', (e) => this.onRegionMouseDown(e, region.id))
    container.addEventListener('mousemove', (e) => this.onRegionMouseMove(e, region.id))

    return { container, labelBar, labelText }
  }

  private onRegionMouseDown(e: MouseEvent, id: string): void {
    if (e.button !== 0) return
    if (effectiveToolOf(this.store, this.spaceHeld) === 'hand') return
    const region = this.store.getState().regions[id]
    if (!region) return

    // Selection.
    if (e.shiftKey) {
      e.stopPropagation()
      this.store.toggleRegionSelection(id)
      return
    }
    if (!this.store.getState().selectedRegionIds.has(id)) {
      this.store.selectRegions([id])
    }

    // Resize from the region border.
    const edge = this.regionEdgeAt(e, id)
    if (edge) {
      beginRegionResize(this.store, id, edge, e)
      return
    }
    // Otherwise drag (label bar or body).
    beginRegionDrag(this.store, id, e)
  }

  private onRegionMouseMove(e: MouseEvent, id: string): void {
    const el = this.regionEls.get(id)
    if (!el) return
    if (effectiveToolOf(this.store, this.spaceHeld) !== 'select') {
      el.container.style.cursor = ''
      return
    }
    const edge = this.regionEdgeAt(e, id)
    el.container.style.cursor = edge ? getCursorForEdge(edge) : ''
  }

  private regionEdgeAt(e: MouseEvent, id: string) {
    const el = this.regionEls.get(id)
    const region = this.store.getState().regions[id]
    if (!el || !region) return null
    const rect = el.container.getBoundingClientRect()
    const zoom = this.store.getState().zoomLevel
    const localX = (e.clientX - rect.left) / zoom
    const localY = (e.clientY - rect.top) / zoom
    return detectEdge(localX, localY, region.size.width, region.size.height, zoom)
  }

  private beginRegionRename(id: string, labelText: HTMLSpanElement): void {
    const region = this.store.getState().regions[id]
    if (!region) return
    const input = document.createElement('input')
    input.className = 'cregion-label-input'
    input.value = region.label
    labelText.replaceWith(input)
    input.focus()
    input.select()
    const commit = () => {
      const v = input.value.trim() || t('defaultRegion')
      this.store.renameRegion(id, v)
      input.replaceWith(labelText)
      labelText.textContent = v
    }
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        input.blur()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        input.value = region.label
        input.blur()
      }
      ev.stopPropagation()
    })
    input.addEventListener('mousedown', (ev) => ev.stopPropagation())
  }

  private updateRegionElement(el: RegionElements, region: CanvasRegion, s: CanvasData): void {
    const c = el.container
    c.style.left = `${region.origin.x}px`
    c.style.top = `${region.origin.y}px`
    c.style.width = `${region.size.width}px`
    c.style.height = `${region.size.height}px`
    c.style.zIndex = String(region.zOrder)
    c.style.setProperty('--region-color', region.color)
    if (document.activeElement !== el.labelText) {
      el.labelText.textContent = region.label
    }

    const selected = s.selectedRegionIds.has(region.id)
    const dropTarget = s.dropTargetRegionId === region.id
    c.classList.toggle('is-selected', selected)
    c.classList.toggle('is-drop-target', dropTarget)
  }

  destroy(): void {
    this.unsubscribe()
    for (const el of this.nodeEls.values()) {
      this.clearNodeTimers(el)
      el.terminal?.dispose()
      el.container.remove()
    }
    for (const el of this.regionEls.values()) el.container.remove()
    this.nodeEls.clear()
    this.regionEls.clear()
  }
}
