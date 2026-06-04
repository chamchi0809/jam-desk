// =============================================================================
// CanvasToolbar — the floating control strip: tool toggle (select / hand),
// add note / file, zoom controls + live percentage, fit, reset, auto-layout,
// group, undo / redo, and a minimap toggle. Subscribes to the store to keep the
// zoom readout, active-tool highlight, and undo/redo enabled-state in sync.
// =============================================================================

import type { CanvasStore } from './store'
import { settings, applySettings } from './settings'
import { icons } from './icons'
import { t } from './i18n'

export interface ToolbarHooks {
  /** Host picks a workspace file → adds a file node. */
  onAddFile?: () => void
  /** Host resolves the active editor file → adds a file node. */
  onAddCurrentFile?: () => void
  /** Minimap visibility toggled. */
  onToggleMinimap?: (visible: boolean) => void
}

export class CanvasToolbar {
  private root: HTMLDivElement
  private unsubscribe: () => void
  private zoomLabel: HTMLButtonElement
  private selectBtn: HTMLButtonElement
  private handBtn: HTMLButtonElement
  private undoBtn: HTMLButtonElement
  private redoBtn: HTMLButtonElement
  private minimapBtn: HTMLButtonElement

  constructor(
    parent: HTMLElement,
    private store: CanvasStore,
    private hooks: ToolbarHooks = {},
  ) {
    this.root = document.createElement('div')
    this.root.className = 'toolbar'

    // -- Tools -------------------------------------------------------------
    this.selectBtn = this.button('Select', icons.pointer, t('toolSelect'), () =>
      this.store.setTool('select'),
    )
    this.handBtn = this.button('Hand', icons.handStop, t('toolHand'), () =>
      this.store.setTool('hand'),
    )

    // -- Add ---------------------------------------------------------------
    const addNoteBtn = this.button('Note', icons.note, t('addNote'), () => {
      this.store.addNode('note')
    })
    const addTerminalBtn = this.button('Terminal', icons.terminal, t('addTerminal'), () => {
      this.store.addNode('terminal')
    })
    const addFileBtn = this.button('File', icons.filePlus, t('addFileNode'), () => {
      this.hooks.onAddFile?.()
    })
    const addCurrentBtn = this.button('Current', icons.fileImport, t('addEditorFile'), () => {
      this.hooks.onAddCurrentFile?.()
    })

    // -- Zoom --------------------------------------------------------------
    const zoomOut = this.button('ZoomOut', icons.zoomOut, t('zoomOut'), () => {
      this.store.animateZoomTo(this.store.getState().zoomLevel - 0.1)
    })
    this.zoomLabel = this.button('Zoom', '100%', t('zoomReset'), () => {
      this.store.animateZoomTo(1)
    })
    this.zoomLabel.classList.add('toolbar-zoom-label')
    const zoomIn = this.button('ZoomIn', icons.zoomIn, t('zoomIn'), () => {
      this.store.animateZoomTo(this.store.getState().zoomLevel + 0.1)
    })

    const fitBtn = this.button('Fit', icons.maximize, t('fitToScreenShortcut'), () =>
      this.store.zoomToFit(),
    )
    const resetBtn = this.button('Reset', icons.restore, t('resetView'), () => this.store.resetView())

    // -- Arrange -----------------------------------------------------------
    const layoutBtn = this.button('Layout', icons.layoutGrid, t('autoLayout'), () =>
      this.store.autoLayout(),
    )
    const groupBtn = this.button('Group', icons.boxMultiple, t('groupSelection'), () =>
      this.store.groupSelectedIntoRegion(),
    )

    // -- History -----------------------------------------------------------
    this.undoBtn = this.button('Undo', icons.arrowBackUp, t('undo'), () =>
      this.store.undo(),
    )
    this.redoBtn = this.button('Redo', icons.arrowForwardUp, t('redo'), () =>
      this.store.redo(),
    )

    // -- Minimap -----------------------------------------------------------
    this.minimapBtn = this.button('Minimap', icons.map, t('toggleMinimap'), () => {
      const next = !settings.showMinimap
      applySettings({ showMinimap: next })
      this.hooks.onToggleMinimap?.(next)
      this.syncMinimapBtn()
    })

    this.root.append(
      this.selectBtn,
      this.handBtn,
      this.sep(),
      addNoteBtn,
      addTerminalBtn,
      addFileBtn,
      addCurrentBtn,
      this.sep(),
      zoomOut,
      this.zoomLabel,
      zoomIn,
      fitBtn,
      resetBtn,
      this.sep(),
      layoutBtn,
      groupBtn,
      this.sep(),
      this.undoBtn,
      this.redoBtn,
      this.sep(),
      this.minimapBtn,
    )
    parent.appendChild(this.root)

    this.sync(store.getState())
    this.syncMinimapBtn()
    this.unsubscribe = store.subscribe((next) => this.sync(next))
  }

  private button(
    key: string,
    label: string,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'toolbar-btn'
    b.dataset.key = key
    // `label` is either a bundled Tabler SVG string or plain text (zoom %).
    if (label.startsWith('<svg')) b.innerHTML = label
    else b.textContent = label
    // Custom CSS tooltip (see .toolbar-btn::after) — faster + theme-styled
    // compared to the native title tooltip.
    b.dataset.tooltip = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    // Don't let the toolbar steal canvas gestures.
    b.addEventListener('mousedown', (e) => e.stopPropagation())
    return b
  }

  private sep(): HTMLSpanElement {
    const s = document.createElement('span')
    s.className = 'toolbar-sep'
    return s
  }

  private sync(s: ReturnType<CanvasStore['getState']>): void {
    this.zoomLabel.textContent = `${Math.round(s.zoomLevel * 100)}%`
    this.selectBtn.classList.toggle('is-active', s.tool === 'select')
    this.handBtn.classList.toggle('is-active', s.tool === 'hand')
    this.undoBtn.disabled = s.history.length === 0
    this.redoBtn.disabled = s.future.length === 0
  }

  private syncMinimapBtn(): void {
    this.minimapBtn.classList.toggle('is-active', settings.showMinimap)
  }

  destroy(): void {
    this.unsubscribe()
    this.root.remove()
  }
}
