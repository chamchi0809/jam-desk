// =============================================================================
// Jam Desk — VS Code extension host.
//
// Owns a single WebviewPanel hosting the infinite canvas, the message protocol
// to/from the webview, document persistence (workspaceState), settings relay,
// and the command surface (open, add note/file, fit, layout, reset, export,
// import, clear). Extracted from the upstream IDE.
// =============================================================================

import * as vscode from 'vscode'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as nodePty from 'node-pty'

const DOCUMENT_KEY = 'jamDesk.document'
const VIEW_TYPE = 'jamDesk.canvas'

interface CanvasDocument {
  version: number
  nodes: Record<string, unknown>
  regions: Record<string, unknown>
  viewportOffset: { x: number; y: number }
  zoomLevel: number
  focusedNodeId: string | null
  nextZOrder: number
  nextCreationIndex: number
}

let panel: CanvasPanel | undefined

export function activate(context: vscode.ExtensionContext): void {
  const open = () => {
    if (!panel) {
      panel = new CanvasPanel(context)
      panel.onDispose(() => {
        panel = undefined
      })
    }
    panel.reveal()
  }

  // Relay a command to the live webview, opening the canvas first if needed.
  const relay = (command: string) => {
    open()
    panel?.post({ type: 'command', command })
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('jamDesk.open', open),
    vscode.commands.registerCommand('jamDesk.addNote', () => relay('addNote')),
    vscode.commands.registerCommand('jamDesk.addTerminal', () => relay('addTerminal')),
    vscode.commands.registerCommand('jamDesk.addFile', () => relay('addFile')),
    vscode.commands.registerCommand('jamDesk.addCurrentFile', () => relay('addCurrentFile')),
    vscode.commands.registerCommand('jamDesk.fitToScreen', () => relay('fitToScreen')),
    vscode.commands.registerCommand('jamDesk.autoLayout', () => relay('autoLayout')),
    vscode.commands.registerCommand('jamDesk.resetView', () => relay('resetView')),
    vscode.commands.registerCommand('jamDesk.export', () => relay('export')),
    vscode.commands.registerCommand('jamDesk.import', () => relay('import')),
    vscode.commands.registerCommand('jamDesk.clear', () => relay('clear')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jamDesk')) panel?.post(settingsMessage())
    }),
  )
}

export function deactivate(): void {
  panel?.dispose()
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

function settingsMessage() {
  const cfg = vscode.workspace.getConfiguration('jamDesk')
  return {
    type: 'settings' as const,
    settings: {
      gridStyle: cfg.get<string>('gridStyle', 'dots'),
      snapToGrid: cfg.get<boolean>('snapToGrid', true),
      zoomSpeed: cfg.get<number>('zoomSpeed', 1),
      showMinimap: cfg.get<boolean>('showMinimap', true),
    },
  }
}

// -----------------------------------------------------------------------------
// Terminal backend — one node-pty shell per terminal node, keyed by node id.
//
// Mirrors the upstream IDE's main-process terminal IPC (src/main/ipc/terminal.ts), trimmed
// to the essentials: spawn / write / resize / kill, with output streamed back to
// the webview. PTYs are killed when their node is removed, when a node id is
// re-created (e.g. after a webview reload), and when the panel is disposed.
// -----------------------------------------------------------------------------

// Backpressure: pause the shell when this many bytes have been posted to the
// webview but not yet acked (drained by xterm), resume once it drains below the
// low-water mark. Mirrors VS Code's integrated-terminal ACK flow control so a
// flood (`yes`, `cat bigfile`) cannot grow the postMessage queue unboundedly.
const FLOW_HIGH_WATER = 100_000
const FLOW_LOW_WATER = 20_000

interface TerminalProc {
  proc: nodePty.IPty
  /** Bytes posted to the webview but not yet acknowledged as drained. */
  unacked: number
  paused: boolean
}

class TerminalManager {
  private readonly procs = new Map<string, TerminalProc>()

  constructor(private readonly post: (msg: unknown) => void) {}

  create(id: string, cols: number, rows: number, cwd?: string): void {
    // Replace any stale PTY under this id (webview reload re-mounts nodes).
    this.kill(id)

    const shellPath = resolveShellPath()
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as {
      [key: string]: string
    }
    // VS Code marks the host as a Node runtime; unset so user shells behave
    // like a normal interactive terminal.
    delete env.ELECTRON_RUN_AS_NODE

    let proc: nodePty.IPty
    try {
      proc = nodePty.spawn(shellPath, shellArgs(shellPath), {
        name: 'xterm-256color',
        cols: clampDim(cols, 80),
        rows: clampDim(rows, 24),
        cwd: this.resolveCwd(cwd),
        env,
      })
    } catch (err) {
      this.post({
        type: 'terminal.data',
        id,
        data: `\r\n\x1b[31m${vscode.l10n.t('[Failed to launch shell: {0}]', String(err))}\x1b[0m\r\n`,
      })
      this.post({ type: 'terminal.exit', id, exitCode: 1 })
      return
    }

    const entry: TerminalProc = { proc, unacked: 0, paused: false }
    this.procs.set(id, entry)

    proc.onData((data) => {
      // Output from a superseded PTY (killed inside a create→recreate) must not
      // bleed into the live replacement terminal now owning this id.
      if (this.procs.get(id) !== entry) return
      this.post({ type: 'terminal.data', id, data })
      entry.unacked += data.length
      if (!entry.paused && entry.unacked > FLOW_HIGH_WATER) {
        entry.paused = true
        try {
          proc.pause()
        } catch {
          /* PTY gone */
        }
      }
    })
    proc.onExit(({ exitCode }) => {
      // Only the live entry reports its exit. A superseded PTY (killed by a
      // recreate, or via kill()) stays silent, so it cannot inject a bogus
      // "process exited" line into whatever terminal now owns this id.
      if (this.procs.get(id) !== entry) return
      this.procs.delete(id)
      this.post({ type: 'terminal.exit', id, exitCode })
    })
  }

  input(id: string, data: string): void {
    try {
      this.procs.get(id)?.proc.write(data)
    } catch {
      /* PTY fd closed between exit and an in-flight write */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.procs.get(id)?.proc.resize(clampDim(cols, 80), clampDim(rows, 24))
    } catch {
      /* PTY gone */
    }
  }

  /** Webview acked `bytes` of drained output; release backpressure if caught up. */
  ack(id: string, bytes: number): void {
    const entry = this.procs.get(id)
    if (!entry) return
    entry.unacked = Math.max(0, entry.unacked - (Number.isFinite(bytes) ? bytes : 0))
    if (entry.paused && entry.unacked < FLOW_LOW_WATER) {
      entry.paused = false
      try {
        entry.proc.resume()
      } catch {
        /* PTY gone */
      }
    }
  }

  kill(id: string): void {
    const entry = this.procs.get(id)
    if (!entry) return
    this.procs.delete(id)
    try {
      entry.proc.kill()
    } catch {
      /* already exited */
    }
  }

  disposeAll(): void {
    for (const entry of this.procs.values()) {
      try {
        entry.proc.kill()
      } catch {
        /* already exited */
      }
    }
    this.procs.clear()
  }

  private resolveCwd(cwd?: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (cwd) {
      const abs = path.isAbsolute(cwd) ? cwd : folder ? path.join(folder, cwd) : cwd
      try {
        if (fs.statSync(abs).isDirectory()) return abs
      } catch {
        /* fall through to defaults */
      }
    }
    return folder ?? os.homedir()
  }
}

function resolveShellPath(): string {
  if (vscode.env.shell) return vscode.env.shell
  if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

/** Login-shell args for POSIX shells (full PATH, like VS Code's terminal). */
function shellArgs(shellPath: string): string[] {
  if (process.platform === 'win32') return []
  const base = path.basename(shellPath).toLowerCase()
  if (base.includes('zsh') || base.includes('bash') || base === 'sh' || base.includes('fish')) {
    return ['-l']
  }
  return []
}

function clampDim(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

// -----------------------------------------------------------------------------
// Panel
// -----------------------------------------------------------------------------

class CanvasPanel {
  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []
  private readonly disposeCallbacks: Array<() => void> = []
  private readonly terminals = new TerminalManager((msg) => this.post(msg))

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Jam Desk',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
        ],
      },
    )

    this.panel.webview.html = this.html()
    vscode.commands.executeCommand('setContext', 'jamDesk.active', true)

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      null,
      this.disposables,
    )

    this.panel.onDidChangeViewState(
      () => {
        vscode.commands.executeCommand('setContext', 'jamDesk.active', this.panel.active)
      },
      null,
      this.disposables,
    )

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active)
  }

  onDispose(cb: () => void): void {
    this.disposeCallbacks.push(cb)
  }

  post(message: unknown): void {
    void this.panel.webview.postMessage(message)
  }

  dispose(): void {
    vscode.commands.executeCommand('setContext', 'jamDesk.active', false)
    this.terminals.disposeAll()
    for (const cb of this.disposeCallbacks.splice(0)) cb()
    while (this.disposables.length) this.disposables.pop()?.dispose()
    this.panel.dispose()
  }

  // ---- Messages from the webview -----------------------------------------

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready': {
        const document = this.context.workspaceState.get<CanvasDocument>(DOCUMENT_KEY) ?? null
        this.post({ type: 'init', document, settings: settingsMessage().settings })
        break
      }
      case 'save': {
        await this.context.workspaceState.update(DOCUMENT_KEY, msg.document)
        break
      }
      case 'openFile': {
        await this.openFile(msg.filePath)
        break
      }
      case 'pickFile': {
        await this.pickFile()
        break
      }
      case 'addCurrentFile': {
        this.addCurrentFile()
        break
      }
      case 'export': {
        await this.exportDocument(msg.document)
        break
      }
      case 'requestImport': {
        await this.importDocument()
        break
      }
      case 'terminal.create': {
        this.terminals.create(msg.id, msg.cols, msg.rows, msg.cwd)
        break
      }
      case 'terminal.input': {
        this.terminals.input(msg.id, msg.data)
        break
      }
      case 'terminal.resize': {
        this.terminals.resize(msg.id, msg.cols, msg.rows)
        break
      }
      case 'terminal.ack': {
        this.terminals.ack(msg.id, msg.bytes)
        break
      }
      case 'terminal.kill': {
        this.terminals.kill(msg.id)
        break
      }
    }
  }

  // ---- File operations ----------------------------------------------------

  private resolveUri(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath)
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (folder) return vscode.Uri.joinPath(folder.uri, filePath)
    return vscode.Uri.file(filePath)
  }

  private toWorkspaceRelative(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    if (folder) return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
    return uri.fsPath
  }

  private async openFile(filePath: string): Promise<void> {
    try {
      const uri = this.resolveUri(filePath)
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside })
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Jam Desk: Could not open file — {0}', String(err)))
    }
  }

  private async pickFile(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: vscode.l10n.t('Add to Canvas'),
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    })
    if (!picks || picks.length === 0) return
    const uri = picks[0]
    this.post({
      type: 'addFileNode',
      filePath: this.toWorkspaceRelative(uri),
      title: path.basename(uri.fsPath),
    })
  }

  private addCurrentFile(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showInformationMessage(vscode.l10n.t('Jam Desk: No active editor.'))
      return
    }
    const uri = editor.document.uri
    this.post({
      type: 'addFileNode',
      filePath: this.toWorkspaceRelative(uri),
      title: path.basename(uri.fsPath),
    })
  }

  private async exportDocument(document: CanvasDocument): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      saveLabel: vscode.l10n.t('Export'),
      filters: { JSON: ['json'] },
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'canvas.json')
        : undefined,
    })
    if (!target) return
    const data = Buffer.from(JSON.stringify(document, null, 2), 'utf8')
    await vscode.workspace.fs.writeFile(target, data)
    vscode.window.showInformationMessage(vscode.l10n.t('Jam Desk: Canvas exported.'))
  }

  private async importDocument(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { JSON: ['json'] },
      openLabel: vscode.l10n.t('Import'),
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    })
    if (!picks || picks.length === 0) return
    try {
      const bytes = await vscode.workspace.fs.readFile(picks[0])
      const document = JSON.parse(Buffer.from(bytes).toString('utf8'))
      this.post({ type: 'loadDocument', document })
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Jam Desk: Import failed — {0}', String(err)))
    }
  }

  // ---- HTML ---------------------------------------------------------------

  private html(): string {
    const webview = this.panel.webview
    const nonce = getNonce()
    // VS Code display language → <html lang>, read synchronously by the
    // webview's i18n module to pick its string table.
    const lang = /^[A-Za-z-]+$/.test(vscode.env.language) ? vscode.env.language : 'en'
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'canvas.css'),
    )
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Jam Desk</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length))
  return text
}
