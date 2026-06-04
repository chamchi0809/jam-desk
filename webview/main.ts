// =============================================================================
// main — webview bootstrap.
//
// Builds the DOM (canvas → grid + world), instantiates the store and every
// view/controller, wires the world transform, keyboard shortcuts, the empty-
// canvas context menu, the container ResizeObserver, and the host bridge.
// =============================================================================

import { CanvasStore } from './store'
import { CanvasGrid } from './grid'
import { SnapGuidesLayer } from './snapGuides'
import { CanvasView } from './nodeView'
import { CanvasMinimap } from './minimap'
import { CanvasToolbar } from './toolbar'
import { CanvasInteraction } from './interaction'
import type { ContextMenuRequest } from './interaction'
import { Persistence } from './persistence'
import { settings } from './settings'
import type { Point } from './types'

// -----------------------------------------------------------------------------
// Context menu (empty-canvas right click)
// -----------------------------------------------------------------------------

interface MenuItem {
  label: string
  run: () => void
}

class ContextMenu {
  private el: HTMLDivElement | null = null
  private attachTimer: number | null = null
  private onDocMouseDown = (e: MouseEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) this.close()
  }

  constructor(
    private store: CanvasStore,
    private persistence: Persistence,
  ) {}

  open(req: ContextMenuRequest): void {
    this.close()
    const at: Point = req.canvasPoint
    const items: MenuItem[] = [
      { label: '메모 추가', run: () => this.store.addNode('note', {}, at) },
      { label: '터미널 추가', run: () => this.store.addNode('terminal', {}, at) },
      { label: '파일 카드 추가…', run: () => this.persistence.pickFile() },
      { label: '현재 파일 추가', run: () => this.persistence.addCurrentFile() },
      { label: '—', run: () => {} },
      { label: '전체 선택', run: () => this.store.selectAll() },
      { label: '자동 정렬', run: () => this.store.autoLayout() },
      { label: '화면에 맞추기', run: () => this.store.zoomToFit() },
      { label: '뷰 초기화', run: () => this.store.resetView() },
      { label: '—', run: () => {} },
      { label: '캔버스 비우기', run: () => this.store.clearAll() },
    ]

    const menu = document.createElement('div')
    menu.className = 'context-menu'
    for (const item of items) {
      if (item.label === '—') {
        const sep = document.createElement('div')
        sep.className = 'context-menu-sep'
        menu.appendChild(sep)
        continue
      }
      const row = document.createElement('button')
      row.className = 'context-menu-item'
      row.textContent = item.label
      row.addEventListener('click', () => {
        item.run()
        this.close()
      })
      menu.appendChild(row)
    }

    document.body.appendChild(menu)
    // Clamp to viewport.
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = menu.getBoundingClientRect()
    const x = Math.min(req.x, vw - rect.width - 8)
    const y = Math.min(req.y, vh - rect.height - 8)
    menu.style.left = `${Math.max(4, x)}px`
    menu.style.top = `${Math.max(4, y)}px`

    this.el = menu
    // Defer attaching the dismiss handler so the opening click doesn't close it.
    // Guard + track the timer so a synchronous close() (Escape, command) before
    // it fires can't leave a dangling document listener.
    this.attachTimer = window.setTimeout(() => {
      this.attachTimer = null
      if (this.el) document.addEventListener('mousedown', this.onDocMouseDown)
    }, 0)
  }

  close(): void {
    if (this.attachTimer !== null) {
      clearTimeout(this.attachTimer)
      this.attachTimer = null
    }
    if (this.el) {
      this.el.remove()
      this.el = null
      document.removeEventListener('mousedown', this.onDocMouseDown)
    }
  }
}

// -----------------------------------------------------------------------------
// DOM scaffold
// -----------------------------------------------------------------------------

const app = document.getElementById('app') ?? document.body

const canvasEl = document.createElement('div')
canvasEl.className = 'canvas'

const world = document.createElement('div')
world.className = 'canvas-world'
world.style.position = 'absolute'
world.style.left = '0'
world.style.top = '0'
world.style.width = '1px'
world.style.height = '1px'
world.style.transformOrigin = '0 0'

const store = new CanvasStore()

// Grid lives OUTSIDE the world transform (screen-space); the world holds nodes,
// regions, snap guides, and the marquee.
const grid = new CanvasGrid(canvasEl, store)
canvasEl.appendChild(world)
app.appendChild(canvasEl)

// -----------------------------------------------------------------------------
// World transform — canvasToView = p*zoom + offset, realized as
// `scale(zoom) translate(offset/zoom)` on a 1×1 world div (origin 0,0).
// -----------------------------------------------------------------------------

function applyTransform(zoom: number, offset: Point): void {
  world.style.transform = `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)`
}
applyTransform(store.getState().zoomLevel, store.getState().viewportOffset)
store.subscribe((next, prev) => {
  if (next.zoomLevel !== prev.zoomLevel || next.viewportOffset !== prev.viewportOffset) {
    applyTransform(next.zoomLevel, next.viewportOffset)
  }
})

// -----------------------------------------------------------------------------
// Views & controllers
// -----------------------------------------------------------------------------

const snapGuides = new SnapGuidesLayer(world, store)
void snapGuides

const persistence = new Persistence(store, {
  onCommand: (command) => runCommand(command),
  onSettingsChanged: () => {
    grid.render()
    minimap.setVisible(settings.showMinimap)
  },
  onDocumentLoaded: () => {
    minimap.setVisible(settings.showMinimap)
  },
})

const view = new CanvasView(world, store, {
  onOpenFile: (filePath) => persistence.openFile(filePath),
  terminals: persistence.terminals,
})

const minimap = new CanvasMinimap(canvasEl, store)
minimap.setVisible(settings.showMinimap)

const toolbar = new CanvasToolbar(canvasEl, store, {
  onAddFile: () => persistence.pickFile(),
  onAddCurrentFile: () => persistence.addCurrentFile(),
  onToggleMinimap: (visible) => minimap.setVisible(visible),
})
void toolbar

const contextMenu = new ContextMenu(store, persistence)

const interaction = new CanvasInteraction(canvasEl, world, store, {
  onContextMenu: (req) => contextMenu.open(req),
  onCloseContextMenu: () => contextMenu.close(),
})

// Space-hold → hand-tool override, shared between interaction and the view.
let spaceHeld = false
view.spaceHeld = () => spaceHeld

// -----------------------------------------------------------------------------
// Container size tracking
// -----------------------------------------------------------------------------

const measure = () => {
  const r = canvasEl.getBoundingClientRect()
  store.setContainerSize({ width: r.width, height: r.height })
}
measure()
const ro = new ResizeObserver(() => measure())
ro.observe(canvasEl)

// -----------------------------------------------------------------------------
// Command dispatch (toolbar / palette / host menu)
// -----------------------------------------------------------------------------

function runCommand(command: string): void {
  switch (command) {
    case 'addNote':
      store.addNode('note')
      break
    case 'addTerminal':
      store.addNode('terminal')
      break
    case 'addFile':
      persistence.pickFile()
      break
    case 'addCurrentFile':
      persistence.addCurrentFile()
      break
    case 'fitToScreen':
      store.zoomToFit()
      break
    case 'autoLayout':
      store.autoLayout()
      break
    case 'resetView':
      store.resetView()
      break
    case 'export':
      persistence.exportDocument()
      break
    case 'import':
      persistence.requestImport()
      break
    case 'clear':
      store.clearAll()
      break
  }
}

// -----------------------------------------------------------------------------
// Keyboard shortcuts
// -----------------------------------------------------------------------------

function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null
  if (!a) return false
  const tag = a.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || a.isContentEditable
}

window.addEventListener('keydown', (e) => {
  // Space-hold → temporary hand tool (pan), unless typing.
  if (e.code === 'Space' && !isTyping()) {
    if (!spaceHeld) {
      spaceHeld = true
      interaction.spaceHeld = true
      canvasEl.classList.add('canvas-tool-hand')
    }
    e.preventDefault()
    return
  }

  const mod = e.metaKey || e.ctrlKey

  // Undo / redo work even while a node is focused (but not mid-text-edit
  // unless it's the canvas-level shortcut — VS Code text areas have their own).
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    if (isTyping()) return
    e.preventDefault()
    if (e.shiftKey) store.redo()
    else store.undo()
    return
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    if (isTyping()) return
    e.preventDefault()
    store.redo()
    return
  }

  if (mod && (e.key === 'a' || e.key === 'A')) {
    if (isTyping()) return
    e.preventDefault()
    store.selectAll()
    return
  }

  if (mod && e.key === '0') {
    e.preventDefault()
    store.animateZoomTo(1)
    return
  }

  if (isTyping()) return

  switch (e.key) {
    case 'v':
    case 'V':
      store.setTool('select')
      break
    case 'h':
    case 'H':
      store.setTool('hand')
      break
    case 'Delete':
    case 'Backspace': {
      e.preventDefault()
      const s = store.getState()
      if (s.selectedNodeIds.size > 0 || s.selectedRegionIds.size > 0) {
        store.deleteSelection(e.shiftKey)
      } else if (s.focusedNodeId) {
        store.removeNode(s.focusedNodeId)
      }
      break
    }
    case 'Escape':
      contextMenu.close()
      store.clearSelection()
      store.unfocus()
      break
    case 'ArrowUp':
      e.preventDefault()
      store.navigateDirection('up')
      break
    case 'ArrowDown':
      e.preventDefault()
      store.navigateDirection('down')
      break
    case 'ArrowLeft':
      e.preventDefault()
      store.navigateDirection('left')
      break
    case 'ArrowRight':
      e.preventDefault()
      store.navigateDirection('right')
      break
    case 'Tab': {
      e.preventDefault()
      const id = e.shiftKey ? store.previousNode() : store.nextNode()
      if (id) store.focusAndCenter(id)
      break
    }
    case '+':
    case '=':
      e.preventDefault()
      store.animateZoomTo(store.getState().zoomLevel + 0.1)
      break
    case '-':
    case '_':
      e.preventDefault()
      store.animateZoomTo(store.getState().zoomLevel - 0.1)
      break
    case '1':
      if (e.shiftKey) {
        e.preventDefault()
        store.zoomToFit()
      }
      break
  }
})

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceHeld = false
    interaction.spaceHeld = false
    canvasEl.classList.remove('canvas-tool-hand')
  }
})

// Reflect the active tool on the canvas (cursor) via a class.
store.subscribe((next, prev) => {
  if (next.tool !== prev.tool) {
    canvasEl.classList.toggle('canvas-tool-hand', next.tool === 'hand')
  }
})
canvasEl.classList.toggle('canvas-tool-hand', store.getState().tool === 'hand')

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

persistence.ready()
