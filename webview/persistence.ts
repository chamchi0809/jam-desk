// =============================================================================
// Persistence — the webview ⇄ extension-host bridge.
//
// Owns the single `acquireVsCodeApi()` handle. Persists the canvas document to
// the host (which stores it in workspaceState) on a debounce whenever a
// persistable slice changes, restores it on init, relays settings, and handles
// host-initiated messages (add file node, import document, run command).
// =============================================================================

import type { CanvasStore } from './store'
import type { CanvasDocument } from './types'
import { applySettings } from './settings'
import type { GridStyle } from './settings'
import type { TerminalBridge } from './terminalView'

interface VsCodeApi {
  postMessage(msg: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

/** Settings payload mirrored from the host's workspace configuration. */
interface SettingsPayload {
  gridStyle?: GridStyle
  snapToGrid?: boolean
  zoomSpeed?: number
  showMinimap?: boolean
}

type HostMessage =
  | { type: 'init'; document?: CanvasDocument | null; settings?: SettingsPayload }
  | { type: 'addFileNode'; filePath: string; title?: string }
  | { type: 'loadDocument'; document: CanvasDocument }
  | { type: 'settings'; settings: SettingsPayload }
  | { type: 'command'; command: string }
  | { type: 'terminal.data'; id: string; data: string }
  | { type: 'terminal.exit'; id: string; exitCode: number }

interface TerminalHandlers {
  onData: (data: string) => void
  onExit: (code: number) => void
}

export interface PersistenceHooks {
  /** A host command (palette / menu) to run against the live canvas. */
  onCommand?: (command: string) => void
  /** Settings changed (host config or init) — refresh grid / minimap. */
  onSettingsChanged?: () => void
  /** The full document was (re)loaded — refit / recenter as desired. */
  onDocumentLoaded?: () => void
}

const SAVE_DEBOUNCE_MS = 400

export class Persistence {
  private vscode: VsCodeApi
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private suppressSave = false
  private terminalHandlers = new Map<string, TerminalHandlers>()

  /** The webview side of the terminal protocol, handed to terminal nodes. */
  readonly terminals: TerminalBridge

  constructor(
    private store: CanvasStore,
    private hooks: PersistenceHooks = {},
  ) {
    this.vscode = acquireVsCodeApi()
    window.addEventListener('message', (e: MessageEvent) => this.onMessage(e.data as HostMessage))

    this.terminals = {
      create: (id, cols, rows, cwd) =>
        this.vscode.postMessage({ type: 'terminal.create', id, cols, rows, cwd }),
      input: (id, data) => this.vscode.postMessage({ type: 'terminal.input', id, data }),
      resize: (id, cols, rows) =>
        this.vscode.postMessage({ type: 'terminal.resize', id, cols, rows }),
      ack: (id, bytes) => this.vscode.postMessage({ type: 'terminal.ack', id, bytes }),
      kill: (id) => this.vscode.postMessage({ type: 'terminal.kill', id }),
      subscribe: (id, handlers) => {
        this.terminalHandlers.set(id, handlers)
        return () => {
          // Only delete if still the same registration (a recreated node may have
          // re-registered under the same id).
          if (this.terminalHandlers.get(id) === handlers) this.terminalHandlers.delete(id)
        }
      },
    }

    this.store.subscribe((next, prev) => {
      if (this.suppressSave) return
      if (
        next.nodes !== prev.nodes ||
        next.regions !== prev.regions ||
        next.viewportOffset !== prev.viewportOffset ||
        next.zoomLevel !== prev.zoomLevel ||
        next.focusedNodeId !== prev.focusedNodeId
      ) {
        this.scheduleSave()
      }
    })
  }

  /** Announce readiness so the host sends the initial document + settings. */
  ready(): void {
    this.vscode.postMessage({ type: 'ready' })
  }

  // ---- Outbound (webview → host) -------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.vscode.postMessage({ type: 'save', document: this.store.toDocument() })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Flush any pending save immediately (e.g. on explicit export). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.vscode.postMessage({ type: 'save', document: this.store.toDocument() })
  }

  openFile(filePath: string): void {
    this.vscode.postMessage({ type: 'openFile', filePath })
  }

  pickFile(): void {
    this.vscode.postMessage({ type: 'pickFile' })
  }

  addCurrentFile(): void {
    this.vscode.postMessage({ type: 'addCurrentFile' })
  }

  exportDocument(): void {
    this.vscode.postMessage({ type: 'export', document: this.store.toDocument() })
  }

  requestImport(): void {
    this.vscode.postMessage({ type: 'requestImport' })
  }

  // ---- Inbound (host → webview) --------------------------------------------

  private onMessage(msg: HostMessage): void {
    if (!msg || typeof msg.type !== 'string') return
    switch (msg.type) {
      case 'init': {
        if (msg.settings) {
          applySettings(msg.settings)
          this.hooks.onSettingsChanged?.()
        }
        if (msg.document && msg.document.nodes) {
          // Don't echo the just-loaded document straight back to the host.
          this.suppressSave = true
          this.store.loadDocument(msg.document)
          this.suppressSave = false
          this.hooks.onDocumentLoaded?.()
        }
        break
      }
      case 'addFileNode': {
        this.store.addNode('file', { filePath: msg.filePath, title: msg.title })
        break
      }
      case 'loadDocument': {
        if (msg.document) {
          this.store.loadDocument(msg.document)
          this.hooks.onDocumentLoaded?.()
          this.scheduleSave()
        }
        break
      }
      case 'settings': {
        applySettings(msg.settings)
        this.hooks.onSettingsChanged?.()
        break
      }
      case 'command': {
        this.hooks.onCommand?.(msg.command)
        break
      }
      case 'terminal.data': {
        this.terminalHandlers.get(msg.id)?.onData(msg.data)
        break
      }
      case 'terminal.exit': {
        this.terminalHandlers.get(msg.id)?.onExit(msg.exitCode)
        break
      }
    }
  }
}
