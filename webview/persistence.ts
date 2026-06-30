// =============================================================================
// Persistence — the webview ⇄ extension-host bridge.
//
// Owns the single `acquireVsCodeApi()` handle. Persists the canvas document to
// the host (which stores it in workspaceState) on a debounce whenever a
// persistable slice changes, restores it on init, relays settings, and handles
// host-initiated messages (add file node, import document, run command).
// =============================================================================

import type { CanvasStore } from './store'
import type { AgentKind, CanvasDocument, Point, TerminalAgentState } from './types'
import { agentActivityEmojiSummary, agentDisplayTitle } from './types'
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
  customLaunchersGlobal?: { label: string; command: string }[]
  customLaunchersWorkspace?: { label: string; command: string }[]
}

type HostMessage =
  | { type: 'init'; document?: CanvasDocument | null; settings?: SettingsPayload }
  | { type: 'addFileNode'; filePath: string; title?: string; at?: Point }
  | { type: 'loadDocument'; document: CanvasDocument }
  | { type: 'settings'; settings: SettingsPayload }
  | { type: 'command'; command: string }
  | { type: 'terminal.data'; id: string; data: string }
  | { type: 'terminal.exit'; id: string; exitCode: number }
  | { type: 'terminal.agent'; id: string; agent: AgentKind | null }
  | { type: 'clipboard.text'; id: string; text: string }
  | { type: 'embeddable'; url: string; embeddable: boolean }
  | { type: 'file.content'; filePath: string; content: string; languageId?: string; truncated?: boolean }
  | { type: 'file.error'; filePath: string; reason: FileError }

interface TerminalHandlers {
  onData: (data: string) => void
  onExit: (code: number) => void
  onPaste?: (text: string) => void
}

/** Why a watched file could not be previewed. */
export type FileError = 'missing' | 'binary' | 'read'

/** A file preview update pushed by the host (content, or an error). */
export interface FileContentData {
  content?: string
  languageId?: string
  truncated?: boolean
  error?: FileError
}

/** Webview side of the read-only file-preview protocol, handed to file nodes. */
export interface FileBridge {
  /** Subscribe to live content for `filePath`; the handler fires immediately
   * (once the host responds) and again whenever the file changes on disk or in
   * an open editor. Returns an unsubscribe fn that stops the host watcher when
   * the last subscriber for that path leaves. */
  watch(filePath: string, handler: (data: FileContentData) => void): () => void
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
  private fileHandlers = new Map<string, Set<(data: FileContentData) => void>>()
  private embeddableWaiters = new Map<string, Set<(ok: boolean) => void>>()

  /** The webview side of the terminal protocol, handed to terminal nodes. */
  readonly terminals: TerminalBridge

  /** The webview side of the file-preview protocol, handed to file nodes. */
  readonly files: FileBridge

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
      copy: (text) => this.vscode.postMessage({ type: 'clipboard.write', text }),
      paste: (id) => this.vscode.postMessage({ type: 'clipboard.read', id }),
      openExternal: (url) => this.vscode.postMessage({ type: 'openExternal', url }),
      subscribe: (id, handlers) => {
        this.terminalHandlers.set(id, handlers)
        return () => {
          // Only delete if still the same registration (a recreated node may have
          // re-registered under the same id).
          if (this.terminalHandlers.get(id) === handlers) this.terminalHandlers.delete(id)
        }
      },
    }

    this.files = {
      watch: (filePath, handler) => {
        let set = this.fileHandlers.get(filePath)
        if (!set) {
          set = new Set()
          this.fileHandlers.set(filePath, set)
          // First subscriber for this path — ask the host to read + watch it.
          this.vscode.postMessage({ type: 'file.watch', filePath })
        }
        set.add(handler)
        return () => {
          const s = this.fileHandlers.get(filePath)
          if (!s) return
          s.delete(handler)
          if (s.size === 0) {
            this.fileHandlers.delete(filePath)
            this.vscode.postMessage({ type: 'file.unwatch', filePath })
          }
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

    // Mirror running coding-agent statuses into the panel (editor tab) title as
    // a row of emoji. `agents` is an immutable slice, so it only differs on a
    // real status change (detection, activity, or an agent vanishing).
    this.store.subscribe((next, prev) => {
      if (next.agents !== prev.agents) {
        this.postAgentSummary()
        this.postAgentNotifications(next.agents, prev.agents)
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

  /** Push the current agent-status emoji row to the host, which appends it to
   * the panel title. Sent on every agents-slice change (empty string clears it). */
  private postAgentSummary(): void {
    this.vscode.postMessage({
      type: 'agentSummary',
      emoji: agentActivityEmojiSummary(this.store.getState().agents),
    })
  }

  /** Fire a desktop notification when a terminal's agent transitions to a state
   * worth interrupting the user for: finishing a task (working → idle) or
   * starting to wait on their input. The host turns this into an OS banner and
   * adds the project name; we supply the terminal's panel title. */
  private postAgentNotifications(
    next: Record<string, TerminalAgentState>,
    prev: Record<string, TerminalAgentState>,
  ): void {
    for (const [id, rec] of Object.entries(next)) {
      if (!rec.agent) continue
      const before = prev[id]?.activity
      if (rec.activity === before) continue
      const kind =
        rec.activity === 'waiting'
          ? 'waiting'
          : before === 'working' && rec.activity === 'idle'
            ? 'complete'
            : null
      if (!kind) continue
      this.vscode.postMessage({ type: 'notify', kind, title: agentDisplayTitle(rec) ?? '' })
    }
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

  /** Open a URL in the system browser (browser node "open externally"). */
  openExternal(url: string): void {
    this.vscode.postMessage({ type: 'openExternal', url })
  }

  /** Open the webview developer tools (browser node debugging). The user can
   * then pick the embedded page's frame from the DevTools frame selector. */
  openDevTools(): void {
    this.vscode.postMessage({ type: 'openDevTools' })
  }

  /** Ask the host whether `url` allows iframe embedding (resolves once the host
   * has read the response headers). Resolves `true` on any error so the iframe
   * still gets a chance to load. */
  checkEmbeddable(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.embeddableWaiters.get(url)
      if (!set) {
        set = new Set()
        this.embeddableWaiters.set(url, set)
      }
      set.add(resolve)
      this.vscode.postMessage({ type: 'checkEmbeddable', url })
    })
  }

  pickFile(): void {
    this.vscode.postMessage({ type: 'pickFile' })
  }

  addCurrentFile(): void {
    this.vscode.postMessage({ type: 'addCurrentFile' })
  }

  /** Files dragged from the VS Code explorer onto the canvas. The host resolves
   * each URI to a workspace path and echoes back an addFileNode at `at`. */
  dropFiles(uris: string[], at: Point): void {
    this.vscode.postMessage({ type: 'dropFiles', uris, at })
  }

  exportDocument(): void {
    this.vscode.postMessage({ type: 'export', document: this.store.toDocument() })
  }

  requestImport(): void {
    this.vscode.postMessage({ type: 'requestImport' })
  }

  /** Persist the custom launcher buttons per scope; host writes config and echoes back. */
  setCustomLaunchers(scopes: {
    global: { label: string; command: string }[]
    workspace: { label: string; command: string }[]
  }): void {
    this.vscode.postMessage({ type: 'setCustomLaunchers', ...scopes })
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
        this.store.addNode('file', { filePath: msg.filePath, title: msg.title }, msg.at)
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
      case 'terminal.agent': {
        // Host process scan saw a coding agent appear/vanish in this PTY.
        this.store.updateTerminalAgent(msg.id, { agent: msg.agent })
        break
      }
      case 'clipboard.text': {
        // Host read the system clipboard in response to paste(id).
        this.terminalHandlers.get(msg.id)?.onPaste?.(msg.text)
        break
      }
      case 'embeddable': {
        const set = this.embeddableWaiters.get(msg.url)
        if (set) {
          this.embeddableWaiters.delete(msg.url)
          set.forEach((resolve) => resolve(msg.embeddable))
        }
        break
      }
      case 'file.content': {
        this.fileHandlers.get(msg.filePath)?.forEach((h) =>
          h({ content: msg.content, languageId: msg.languageId, truncated: msg.truncated }),
        )
        break
      }
      case 'file.error': {
        this.fileHandlers.get(msg.filePath)?.forEach((h) => h({ error: msg.reason }))
        break
      }
    }
  }
}
