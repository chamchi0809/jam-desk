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
import { exec, execFile } from 'child_process'
import type * as Net from 'net'
import type * as NodePty from 'node-pty'

const DOCUMENT_KEY = 'jamDesk.document'
const VIEW_TYPE = 'jamDesk.canvas'
/** Base panel (editor tab) title; the webview appends a row of agent-status
 *  emoji to it via the `agentSummary` message. */
const PANEL_TITLE = 'Jam Desk'

/** Upper bound on file-preview payload size — keeps message + webview highlight
 * cost bounded for very large files. Beyond this the preview is truncated. */
const MAX_PREVIEW_CHARS = 200_000

/** Cheap binary sniff: a NUL byte in the head means "don't try to preview as
 * text". Mirrors the heuristic Git and most editors use. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

const nodePty = loadNodePty()

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

function loadNodePty(): typeof NodePty {
  patchNodePtyConoutBridge()
  return require('node-pty') as typeof NodePty
}

function patchNodePtyConoutBridge(): void {
  if (process.platform !== 'win32' || !isExtensionHostDebugging()) return

  const net = require('net') as typeof Net
  const conoutModulePath = require.resolve('node-pty/lib/windowsConoutConnection')
  const { getWorkerPipeName } = require('node-pty/lib/shared/conout') as {
    getWorkerPipeName(conoutPipeName: string): string
  }

  class ReadyEvent {
    private listeners: Array<() => void> = []

    readonly event = (listener: () => void) => {
      this.listeners.push(listener)
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((item) => item !== listener)
        },
      }
    }

    fire(): void {
      for (const listener of [...this.listeners]) listener()
    }
  }

  class InlineConoutConnection {
    private readonly onReadyEmitter = new ReadyEvent()
    private readonly conoutSocket: Net.Socket
    private readonly server: Net.Server

    constructor(private readonly conoutPipeName: string) {
      this.conoutSocket = new net.Socket()
      this.conoutSocket.setEncoding('utf8')
      this.server = net.createServer((workerSocket) => {
        this.conoutSocket.pipe(workerSocket)
      })
      this.conoutSocket.connect(conoutPipeName, () => {
        this.server.listen(getWorkerPipeName(conoutPipeName), () => this.onReadyEmitter.fire())
      })
    }

    get onReady() {
      return this.onReadyEmitter.event
    }

    connectSocket(socket: Net.Socket): void {
      socket.connect(getWorkerPipeName(this.conoutPipeName))
    }

    dispose(): void {
      this.conoutSocket.destroy()
      this.server.close()
    }
  }

  ;(require(conoutModulePath) as { ConoutConnection: unknown }).ConoutConnection =
    InlineConoutConnection
  console.info('[jam-desk] using inline ConPTY bridge for extension-host debugging')
}

function isExtensionHostDebugging(): boolean {
  const args = [...process.execArgv, ...process.argv]
  return (
    process.env.VSCODE_DEBUG_MODE === 'true' ||
    args.some((arg) => /^--inspect(?:-brk)?(?:=|$)/.test(arg))
  )
}

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
  proc: NodePty.IPty
  /** Bytes posted to the webview but not yet acknowledged as drained. */
  unacked: number
  paused: boolean
}

// ---- Coding-agent detection ---------------------------------------------------
// Every AGENT_POLL_MS the process table is read once; each live PTY's
// descendant tree is searched for a Claude Code / Codex CLI. Changes are posted
// to the webview as `terminal.agent` messages, which drive the panel-title and
// minimap status UI.

const AGENT_POLL_MS = 2000

type AgentKind = 'claude' | 'codex'

/** Classify a process command line as an agent CLI. Only the leading tokens are
 * inspected ("claude --resume", "node …/claude-code/cli.js", "bun x codex") so
 * arbitrary argument text cannot false-positive. */
function classifyAgentCommand(command: string): AgentKind | null {
  for (const raw of leadingCommandTokens(command, 8)) {
    const tok = raw.trim().replace(/^[`"']+|[`"']+$/g, '').toLowerCase()
    const base = path.win32.basename(tok)
    const stem = base.replace(/\.(?:exe|cmd|bat|ps1|js|cjs|mjs)$/i, '')
    if (stem === 'claude' || tok.includes('claude-code')) return 'claude'
    if (stem === 'codex' || stem.startsWith('codex-') || tok.includes('@openai/codex')) {
      return 'codex'
    }
  }
  return null
}

function leadingCommandTokens(command: string, limit: number): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|[^\s]+/g
  let m: RegExpExecArray | null
  while (tokens.length < limit && (m = re.exec(command))) {
    tokens.push(m[1] ?? m[2] ?? m[0])
  }
  return tokens
}

type ProcessTree = Map<number, Array<{ pid: number; command: string }>>

/** One process-list pass -> children-by-parent-pid map. Null when unavailable. */
function readProcessTree(): Promise<ProcessTree | null> {
  if (process.platform === 'win32') return readWindowsProcessTree()
  return readPosixProcessTree()
}

function readPosixProcessTree(): Promise<ProcessTree | null> {
  return new Promise((resolve) => {
    exec('ps -axo pid=,ppid=,command=', { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || typeof stdout !== 'string') return resolve(null)
      const byParent: ProcessTree = new Map()
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        if (!m) continue
        const entry = { pid: Number(m[1]), command: m[3] }
        const ppid = Number(m[2])
        const siblings = byParent.get(ppid)
        if (siblings) siblings.push(entry)
        else byParent.set(ppid, [entry])
      }
      resolve(byParent)
    })
  })
}

interface WindowsProcessEntry {
  ProcessId?: unknown
  ParentProcessId?: unknown
  CommandLine?: unknown
}

const WINDOWS_PROCESS_TREE_SCRIPT =
  "$ErrorActionPreference='Stop'; " +
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | ForEach-Object { ' +
  '[pscustomobject]@{ ' +
  'ProcessId=[int]$_.ProcessId; ' +
  'ParentProcessId=[int]$_.ParentProcessId; ' +
  'CommandLine=$(if ($_.CommandLine) { [string]$_.CommandLine } else { [string]$_.Name }) ' +
  '} ' +
  '} | ConvertTo-Json -Compress'

function readWindowsProcessTree(): Promise<ProcessTree | null> {
  return new Promise((resolve) => {
    execFile(
      resolveWindowsPowerShellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_PROCESS_TREE_SCRIPT,
      ],
      { maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || typeof stdout !== 'string') return resolve(null)
        resolve(parseWindowsProcessTree(stdout))
      },
    )
  })
}

function resolveWindowsPowerShellPath(): string {
  const root = process.env.SystemRoot || process.env.WINDIR
  if (root) {
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (fs.existsSync(exe)) return exe
  }
  return 'powershell.exe'
}

function parseWindowsProcessTree(stdout: string): ProcessTree | null {
  const text = stdout.trim()
  if (!text) return new Map()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const byParent: ProcessTree = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as WindowsProcessEntry
    const pid = Number(rec.ProcessId)
    const ppid = Number(rec.ParentProcessId)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const command = typeof rec.CommandLine === 'string' ? rec.CommandLine : ''
    const siblings = byParent.get(ppid)
    const entry = { pid, command }
    if (siblings) siblings.push(entry)
    else byParent.set(ppid, [entry])
  }
  return byParent
}

/** Breadth-first search of a PTY's descendants for an agent CLI, so the
 * shallowest match wins (the agent itself, not subshells it spawns). */
function findAgent(tree: ProcessTree, rootPid: number): AgentKind | null {
  const queue = [rootPid]
  const seen = new Set<number>()
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const child of tree.get(pid) ?? []) {
      const kind = classifyAgentCommand(child.command)
      if (kind) return kind
      queue.push(child.pid)
    }
  }
  return null
}

class TerminalManager {
  private readonly procs = new Map<string, TerminalProc>()
  private agentTimer: ReturnType<typeof setInterval> | null = null
  private agentScanInFlight = false
  /** Last agent posted per terminal id, so only changes are messaged. */
  private readonly lastAgents = new Map<string, AgentKind | null>()

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

    let proc: NodePty.IPty
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
    this.ensureAgentPolling()

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
    this.stopAgentPolling()
    this.lastAgents.clear()
    for (const entry of this.procs.values()) {
      try {
        entry.proc.kill()
      } catch {
        /* already exited */
      }
    }
    this.procs.clear()
  }

  // ---- Coding-agent polling --------------------------------------------------

  private ensureAgentPolling(): void {
    if (this.agentTimer) return
    this.agentTimer = setInterval(() => void this.pollAgents(), AGENT_POLL_MS)
  }

  private stopAgentPolling(): void {
    if (this.agentTimer) {
      clearInterval(this.agentTimer)
      this.agentTimer = null
    }
  }

  private async pollAgents(): Promise<void> {
    if (this.agentScanInFlight) return
    if (this.procs.size === 0) {
      // Flush "agent gone" for terminals whose PTY exited, then go idle.
      for (const [id, agent] of this.lastAgents) {
        if (agent) this.post({ type: 'terminal.agent', id, agent: null })
      }
      this.lastAgents.clear()
      this.stopAgentPolling()
      return
    }
    this.agentScanInFlight = true
    try {
      const tree = await readProcessTree()
      if (!tree) return
      for (const [id, entry] of this.procs) {
        const agent = findAgent(tree, entry.proc.pid)
        if ((this.lastAgents.get(id) ?? null) !== agent) {
          this.post({ type: 'terminal.agent', id, agent })
        }
        this.lastAgents.set(id, agent)
      }
      // PTYs that exited since the last pass: report their agent as gone.
      for (const id of [...this.lastAgents.keys()]) {
        if (!this.procs.has(id)) {
          if (this.lastAgents.get(id)) this.post({ type: 'terminal.agent', id, agent: null })
          this.lastAgents.delete(id)
        }
      }
    } catch {
      /* scan failed — retry on the next tick */
    } finally {
      this.agentScanInFlight = false
    }
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
  /** File paths the webview is previewing → refcount + disk watcher + resolved
   * fsPath (for matching editor-change events back to the webview's key). */
  private readonly watchedFiles = new Map<
    string,
    { refs: number; watcher?: vscode.FileSystemWatcher; fsPath: string }
  >()
  private readonly fileSendTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
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

    // Live-sync file previews with the real editors: unsaved edits stream in via
    // onDidChangeTextDocument (debounced), and saves push immediately. On-disk
    // changes to files NOT open in an editor are caught by per-file watchers
    // created in watchFile().
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        const key = this.findWatchKeyByFsPath(e.document.uri.fsPath)
        if (key) this.scheduleFileSend(key)
      },
      null,
      this.disposables,
    )
    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        const key = this.findWatchKeyByFsPath(doc.uri.fsPath)
        if (key) void this.sendFileContent(key)
      },
      null,
      this.disposables,
    )
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
    for (const entry of this.watchedFiles.values()) entry.watcher?.dispose()
    this.watchedFiles.clear()
    for (const timer of this.fileSendTimers.values()) clearTimeout(timer)
    this.fileSendTimers.clear()
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
      case 'agentSummary': {
        // The webview computed a row of emoji for the running coding agents.
        // Append it to the tab title (empty string → just the base title).
        const emoji = typeof msg.emoji === 'string' ? msg.emoji : ''
        this.panel.title = emoji ? `${PANEL_TITLE} ${emoji}` : PANEL_TITLE
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
      case 'dropFiles': {
        this.addDroppedFiles(msg.uris, msg.at)
        break
      }
      case 'file.watch': {
        if (typeof msg.filePath === 'string') this.watchFile(msg.filePath)
        break
      }
      case 'file.unwatch': {
        if (typeof msg.filePath === 'string') this.unwatchFile(msg.filePath)
        break
      }
      case 'clipboard.write': {
        await vscode.env.clipboard.writeText(String(msg.text ?? ''))
        break
      }
      case 'clipboard.read': {
        const text = await vscode.env.clipboard.readText()
        this.post({ type: 'clipboard.text', id: msg.id, text })
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

  // ---- File previews (read-only, live-synced) -----------------------------

  /** The watched-file key (the webview's filePath) whose resolved path matches
   * `fsPath`, if any. Used to route editor change/save events to the webview. */
  private findWatchKeyByFsPath(fsPath: string): string | undefined {
    for (const [key, entry] of this.watchedFiles) {
      if (entry.fsPath === fsPath) return key
    }
    return undefined
  }

  /** Start (or refcount) a read-only preview watch for `filePath` and push its
   * current contents to the webview. */
  private watchFile(filePath: string): void {
    const existing = this.watchedFiles.get(filePath)
    if (existing) {
      existing.refs++
      void this.sendFileContent(filePath)
      return
    }
    const uri = this.resolveUri(filePath)
    let watcher: vscode.FileSystemWatcher | undefined
    try {
      const dir = vscode.Uri.file(path.dirname(uri.fsPath))
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, path.basename(uri.fsPath)),
      )
      watcher.onDidChange(() => this.scheduleFileSend(filePath), null, this.disposables)
      watcher.onDidCreate(() => this.scheduleFileSend(filePath), null, this.disposables)
      watcher.onDidDelete(
        () => this.post({ type: 'file.error', filePath, reason: 'missing' }),
        null,
        this.disposables,
      )
    } catch {
      // Watcher creation can fail for exotic schemes — the preview still works,
      // it just won't auto-refresh on external disk changes.
    }
    this.watchedFiles.set(filePath, { refs: 1, watcher, fsPath: uri.fsPath })
    void this.sendFileContent(filePath)
  }

  private unwatchFile(filePath: string): void {
    const entry = this.watchedFiles.get(filePath)
    if (!entry) return
    if (--entry.refs > 0) return
    this.watchedFiles.delete(filePath)
    entry.watcher?.dispose()
    const timer = this.fileSendTimers.get(filePath)
    if (timer) {
      clearTimeout(timer)
      this.fileSendTimers.delete(filePath)
    }
  }

  /** Debounced content push — collapses the burst of onDidChangeTextDocument /
   * watcher events that a single edit or save produces. */
  private scheduleFileSend(filePath: string): void {
    const prev = this.fileSendTimers.get(filePath)
    if (prev) clearTimeout(prev)
    this.fileSendTimers.set(
      filePath,
      setTimeout(() => {
        this.fileSendTimers.delete(filePath)
        void this.sendFileContent(filePath)
      }, 120),
    )
  }

  /** Read the current contents of a watched file and post them to the webview.
   * Prefers an open TextDocument (so unsaved edits show live), else reads disk. */
  private async sendFileContent(filePath: string): Promise<void> {
    if (!this.watchedFiles.has(filePath)) return
    const uri = this.resolveUri(filePath)
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath)
      let text: string
      let languageId: string | undefined
      if (open) {
        text = open.getText()
        languageId = open.languageId
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri)
        if (looksBinary(bytes)) {
          this.post({ type: 'file.error', filePath, reason: 'binary' })
          return
        }
        text = Buffer.from(bytes).toString('utf8')
      }
      const truncated = text.length > MAX_PREVIEW_CHARS
      if (truncated) text = text.slice(0, MAX_PREVIEW_CHARS)
      this.post({ type: 'file.content', filePath, content: text, languageId, truncated })
    } catch {
      this.post({ type: 'file.error', filePath, reason: 'missing' })
    }
  }

  private async openFile(filePath: string): Promise<void> {
    try {
      const uri = this.resolveUri(filePath)
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      })
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

  /** Files dragged from the explorer onto the canvas: resolve each `file:` URI to
   * a workspace-relative path and add a node at the drop point. Directories and
   * non-file schemes are ignored. `at` is the drop position in canvas space. */
  private addDroppedFiles(uris: unknown, at: unknown): void {
    if (!Array.isArray(uris)) return
    const point =
      at && typeof at === 'object' && Number.isFinite((at as any).x) && Number.isFinite((at as any).y)
        ? { x: (at as any).x, y: (at as any).y }
        : undefined
    for (const raw of uris) {
      if (typeof raw !== 'string' || !raw) continue
      let uri: vscode.Uri
      try {
        uri = vscode.Uri.parse(raw, true)
      } catch {
        continue
      }
      if (uri.scheme !== 'file') continue
      try {
        if (fs.statSync(uri.fsPath).isDirectory()) continue
      } catch {
        continue
      }
      this.post({
        type: 'addFileNode',
        filePath: this.toWorkspaceRelative(uri),
        title: path.basename(uri.fsPath),
        at: point,
      })
    }
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
