// =============================================================================
// TerminalController — an xterm.js terminal living inside a canvas node, talking
// to a node-pty shell in the extension host through the TerminalBridge.
//
// Mirrors the upstream IDE's renderer terminal (TerminalPanel + terminalRegistry): xterm in
// the webview, PTY in the host, data streamed both ways over the message bridge.
//
// Geometry note: xterm measures the cell size with `offsetWidth` and FitAddon
// reads the host's `getComputedStyle` width/height — both are layout pixels,
// unaffected by the world's `scale(zoom)` transform. So `fit()` yields correct
// cols/rows at any canvas zoom, and a zoom change (which leaves layout boxes
// untouched) never triggers a spurious refit — only a real node resize does.
// =============================================================================

import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
// Bundled as a string via esbuild's text loader and injected once (CSP allows
// inline <style> through `style-src 'unsafe-inline'`).
import xtermCss from '@xterm/xterm/css/xterm.css'
import { t } from './i18n'
import type { AgentActivity, AgentKind } from './types'
import { classifyAgentTitle, cleanAgentTitle } from './types'

/** The webview side of the terminal protocol; implemented by Persistence. */
export interface TerminalBridge {
  /** Ask the host to spawn a PTY for this terminal id. */
  create(id: string, cols: number, rows: number, cwd?: string): void
  /** Forward keystrokes / pasted text to the PTY. */
  input(id: string, data: string): void
  /** Tell the PTY the viewport changed. */
  resize(id: string, cols: number, rows: number): void
  /** Acknowledge that `bytes` of output have been drained (for host backpressure). */
  ack(id: string, bytes: number): void
  /** Kill the PTY and release host resources. */
  kill(id: string): void
  /** Copy text to the system clipboard (routed through the host). */
  copy(text: string): void
  /** Request the system clipboard contents be pasted into terminal `id`. */
  paste(id: string): void
  /** Subscribe to PTY output / exit / paste for this id. Returns an unsubscribe fn. */
  subscribe(
    id: string,
    handlers: {
      onData: (data: string) => void
      onExit: (code: number) => void
      /** Clipboard text resolved by the host in response to paste(id). */
      onPaste?: (text: string) => void
    },
  ): () => void
}

/** Optional callbacks reporting agent-relevant terminal events upward. */
export interface TerminalControllerHooks {
  /** OSC 0/2 title set by the PTY, agent state prefixes stripped (agents
   * publish their session title here). */
  onTitleChange?: (title: string) => void
  /** Agent inferred from local terminal signals before/without host process scan. */
  onAgent?: (agent: AgentKind) => void
  /** Derived coding-agent activity changed (only fires while an agent is attached). */
  onActivity?: (activity: AgentActivity) => void
  /** Current canvas zoom. The terminal lives inside the world's `scale(zoom)`
   * transform, which xterm's mouse→cell mapping does not account for; we read
   * this to correct selection / mouse-report coordinates at any zoom. */
  getZoom?: () => number
}

// ---- xterm internals (pinned 5.5.0) for the mouse-coordinate zoom fix --------
// xterm computes the cell under the pointer from `element.getBoundingClientRect()`
// (which is in *visual* px — scaled by the world's `scale(zoom)` transform) but
// divides by the cell size measured in *layout* px. Under any zoom ≠ 1 the
// selection then drifts from the cursor, worsening with distance from the
// terminal's top-left. xterm exposes no scale hook, so we reach the (pinned)
// internal MouseService and replace its two coordinate methods with copies that
// divide the pointer offset back into layout space first. All access is
// optional-chained: if these private shapes ever change, we silently leave the
// stock (zoom-naive) behavior in place rather than throw.
interface XtermCellDims {
  width: number
  height: number
}
interface XtermMouseService {
  getCoords?: (
    event: MouseEvent,
    element: HTMLElement,
    cols: number,
    rows: number,
    isSelection?: boolean,
  ) => [number, number] | undefined
  getMouseReportCoords?: (
    event: MouseEvent,
    element: HTMLElement,
  ) => { col: number; row: number; x: number; y: number } | undefined
  _charSizeService?: { hasValidSize: boolean }
  _renderService?: { dimensions?: { css?: { cell?: XtermCellDims; canvas?: XtermCellDims } } }
  __jamZoomPatched?: boolean
}

// ---- Coding-agent activity signals --------------------------------------------
// Activity is fused from layered signals, most-structured first:
//
//  1. OSC 0 title (classifyAgentTitle): both agents encode working — and Codex
//     also blocked-on-input — into the terminal title they already set.
//  2. OSC 9: ConEmu/iTerm2 progress ("4;<state>;…", Claude Code emits it when
//     the terminal advertises support) and iTerm2-style notification messages
//     (Codex `tui.notifications` — approval / plan prompts mean blocked).
//  3. Screen scan (fallback, throttled): the visible buffer is searched for
//     marker text. This is the only source for Claude Code's permission
//     dialogs, which are not title-coded; Codex's "esc to interrupt" footer is
//     pinned by a test in openai/codex, so the strings are stabler than they
//     look.
//
// Fusion: waiting beats working beats idle — a permission dialog can pop while
// the title still says "working", and the user being asked something is the
// state that matters.

const AGENT_WORKING_RE = /esc to interrupt/i

const AGENT_WAITING_RES: RegExp[] = [
  /❯\s*\d+\./, // Claude Code option selector ("❯ 1. Yes")
  /[❯›]\s*(yes|approve|allow)\b/i, // Codex-style approval selector
  /\(y\/n\)/i,
  /│\s*do you (want|trust)/i, // boxed Claude Code permission prompts
  /│\s*would you like/i,
  /press enter to continue/i,
  /waiting for (your )?(input|approval|confirmation)/i,
  /allow command\?/i,
]

/** OSC 9 notification payloads that mean the agent is blocked on user input
 * (Codex chatwidget/notifications.rs message templates). */
const OSC9_WAITING_RE = /^(approval requested|codex wants to edit|plan mode prompt)/i

/** Trailing scan delay after PTY output settles (also the max scan rate). */
const ACTIVITY_SCAN_MS = 250

/** After a launched terminal's startup output settles, wait this long before
 * typing its command, so the shell prompt is ready to receive it. */
const INITIAL_COMMAND_SETTLE_MS = 500

const CODEX_WAITING_TITLE_RE = /^\[\s*[!.]\s*\]\s*action required/i
const CLAUDE_IDLE_TITLE_RE = /^[\u2733\u2736\u273b\u273d]\s/

const INPUT_PREFIX_COMMANDS = new Set(['command', 'env', 'rlwrap', 'sudo', 'winpty'])
const DIRECT_EXEC_COMMANDS = new Set(['bunx', 'npx', 'uvx'])
const PACKAGE_EXEC_COMMANDS = new Map([
  ['bun', new Set(['x'])],
  ['npm', new Set(['exec', 'x'])],
  ['pnpm', new Set(['dlx', 'exec'])],
  ['yarn', new Set(['dlx', 'exec'])],
])

const OUTPUT_AGENT_PROBES: Array<{ agent: AgentKind; re: RegExp }> = [
  { agent: 'claude', re: /\bClaude Code\b|claude-code/i },
  { agent: 'codex', re: /\bOpenAI Codex\b|esc to interrupt|Action Required/i },
]

function leadingCommandTokens(command: string, limit: number): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|[^\s]+/g
  let m: RegExpExecArray | null
  while (tokens.length < limit && (m = re.exec(command))) {
    tokens.push(m[1] ?? m[2] ?? m[0])
  }
  return tokens
}

function commandStem(token: string): string {
  const clean = token.trim().replace(/^[`"']+|[`"']+$/g, '').toLowerCase()
  const base = clean.split(/[\\/]/).pop() ?? clean
  return base.replace(/\.(?:exe|cmd|bat|ps1|js|cjs|mjs)$/i, '')
}

function classifyAgentToken(token: string | undefined): AgentKind | null {
  if (!token) return null
  const clean = token.trim().replace(/^[`"']+|[`"']+$/g, '').toLowerCase()
  const stem = commandStem(clean)
  if (stem === 'claude' || clean.includes('claude-code')) return 'claude'
  if (stem === 'codex' || stem.startsWith('codex-') || clean.includes('@openai/codex')) {
    return 'codex'
  }
  return null
}

function nextNonOption(tokens: string[], start: number): string | undefined {
  for (let i = start; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) return tokens[i]
  }
  return undefined
}

function isInputPrefixToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || INPUT_PREFIX_COMMANDS.has(commandStem(token))
}

function classifyAgentLaunchCommand(command: string): AgentKind | null {
  const tokens = leadingCommandTokens(command, 12)
  let i = 0
  while (i < tokens.length && isInputPrefixToken(tokens[i])) i++

  const direct = classifyAgentToken(tokens[i])
  if (direct) return direct

  const stem = commandStem(tokens[i] ?? '')
  if (DIRECT_EXEC_COMMANDS.has(stem)) return classifyAgentToken(nextNonOption(tokens, i + 1))

  const subcommands = PACKAGE_EXEC_COMMANDS.get(stem)
  const subcommand = commandStem(tokens[i + 1] ?? '')
  if (subcommands?.has(subcommand)) {
    return classifyAgentToken(nextNonOption(tokens, i + 2))
  }

  if (stem === 'node') return classifyAgentToken(nextNonOption(tokens, i + 1))
  return null
}

function inferAgentFromTitle(title: string): AgentKind | null {
  const s = title.trimStart()
  if (CODEX_WAITING_TITLE_RE.test(s)) return 'codex'
  if (CLAUDE_IDLE_TITLE_RE.test(s)) return 'claude'
  return null
}

let cssInjected = false
function ensureXtermCss(): void {
  if (cssInjected) return
  cssInjected = true
  const style = document.createElement('style')
  style.textContent = xtermCss
  document.head.appendChild(style)
}

/** Read a CSS custom property off the document root, falling back if unset. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Build an xterm theme from VS Code's injected `--vscode-*` theme variables. */
function readTheme(): ITheme {
  const bg = cssVar('--vscode-terminal-background', cssVar('--vscode-panel-background', '#1e1e1e'))
  const fg = cssVar('--vscode-terminal-foreground', cssVar('--vscode-foreground', '#cccccc'))
  return {
    background: bg,
    foreground: fg,
    cursor: cssVar('--vscode-terminalCursor-foreground', fg),
    cursorAccent: cssVar('--vscode-terminalCursor-background', bg),
    selectionBackground: cssVar('--vscode-terminal-selectionBackground', 'rgba(255,255,255,0.25)'),
    black: cssVar('--vscode-terminal-ansiBlack', '#000000'),
    red: cssVar('--vscode-terminal-ansiRed', '#cd3131'),
    green: cssVar('--vscode-terminal-ansiGreen', '#0dbc79'),
    yellow: cssVar('--vscode-terminal-ansiYellow', '#e5e510'),
    blue: cssVar('--vscode-terminal-ansiBlue', '#2472c8'),
    magenta: cssVar('--vscode-terminal-ansiMagenta', '#bc3fbc'),
    cyan: cssVar('--vscode-terminal-ansiCyan', '#11a8cd'),
    white: cssVar('--vscode-terminal-ansiWhite', '#e5e5e5'),
    brightBlack: cssVar('--vscode-terminal-ansiBrightBlack', '#666666'),
    brightRed: cssVar('--vscode-terminal-ansiBrightRed', '#f14c4c'),
    brightGreen: cssVar('--vscode-terminal-ansiBrightGreen', '#23d18b'),
    brightYellow: cssVar('--vscode-terminal-ansiBrightYellow', '#f5f543'),
    brightBlue: cssVar('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
    brightMagenta: cssVar('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
    brightCyan: cssVar('--vscode-terminal-ansiBrightCyan', '#29b8db'),
    brightWhite: cssVar('--vscode-terminal-ansiBrightWhite', '#e5e5e5'),
  }
}

export class TerminalController {
  private term: Terminal
  private fit: FitAddon
  private unsub: (() => void) | null = null
  private ro: ResizeObserver | null = null
  private fitRaf = 0
  private disposed = false
  private mounted = false
  /** focus() requested before mount() ran; applied once the term is open. */
  private wantFocus = false
  /** Host detected a coding agent in this PTY — enables activity scanning. */
  private agentPresent = false
  /** Agent inferred in the webview from typed commands / title / output probes. */
  private inferredAgent: AgentKind | null = null
  private pendingInputLine = ''
  private outputProbe = ''
  private scanTimer: number | null = null
  private lastReportedActivity: AgentActivity | null = null
  // Layered activity signals (see "Coding-agent activity signals" above).
  /** State the agent encoded into its OSC title. Tracked even before the host's
   * process scan lands, since agents write their title within the poll gap. */
  private titleState: 'working' | 'waiting' | null = null
  /** Latched by an OSC 9 approval/plan notification; cleared by a keystroke
   * (the user answered), a turn-complete notification, or the title going busy. */
  private osc9Waiting = false
  /** OSC 9;4 progress state — a task is running (Claude Code progress report). */
  private progressWorking = false
  /** Last screen-scan verdict; null until the first scan after attach. */
  private scanState: AgentActivity | null = null
  /** Pending one-shot launcher command (Claude Code / Codex buttons); cleared
   * once typed into the shell, or cancelled if the user types first. */
  private initialCommand: string | undefined
  private initialCommandTimer: number | null = null
  private zoomRefreshTimer: number | null = null

  constructor(
    private id: string,
    private bridge: TerminalBridge,
    private cwd?: string,
    private hooks: TerminalControllerHooks = {},
    initialCommand?: string,
  ) {
    this.initialCommand = initialCommand
    ensureXtermCss()
    this.term = new Terminal({
      theme: readTheme(),
      fontFamily: cssVar('--vscode-editor-font-family', 'Menlo, Monaco, "Courier New", monospace'),
      fontSize: 12,
      cursorBlink: true,
      scrollback: 1000,
      allowProposedApi: false,
      // PTY output already carries CRLF; do not translate.
      convertEol: false,
    })
    this.fit = new FitAddon()
    this.term.loadAddon(this.fit)

    // OSC 0/2 window-title sequences. Always classified (so a state set just
    // before agent detection lands is not lost) and reported cleaned — the
    // cleaned text is stable across spinner frames, so the upstream store
    // dedupes Codex's 100ms title rewrites for free.
    this.term.onTitleChange((title) => {
      if (this.disposed) return
      const titleAgent = inferAgentFromTitle(title)
      if (titleAgent) this.reportInferredAgent(titleAgent)
      const state = classifyAgentTitle(title)
      if (state !== this.titleState) {
        this.titleState = state
        // The agent resumed working — any approval it was blocked on is gone.
        if (state === 'working') this.osc9Waiting = false
        this.recomputeActivity()
        this.scheduleActivityScan()
      }
      this.hooks.onTitleChange?.(cleanAgentTitle(title))
    })

    // OSC 9 — two protocols share the slot (see signal notes above).
    this.term.parser.registerOscHandler(9, (data) => {
      this.handleOsc9(data)
      return true
    })

    // xterm.js sends Shift+Enter as a plain CR, which TUIs like Claude Code
    // treat as submit. Send backslash+CR (line continuation) instead so
    // Claude Code inserts a newline; shells (zsh/bash) show a PS2
    // continuation prompt, which is also a newline-like behavior.
    // NOTE: the handler fires for keydown, keypress AND keyup. Returning
    // false on keydown does not preventDefault, so the browser still fires
    // keypress — xterm would then send a plain \r and submit anyway. Block
    // every event type for Shift+Enter; emit our sequence on keydown only.
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (ev.type === 'keydown' && !this.disposed) this.bridge.input(this.id, '\\\r')
        return false
      }

      // Copy / paste. Ctrl (Win/Linux) or Cmd (mac) + C / V, plus Shift+Insert.
      // We preventDefault + route clipboard through the host so behavior is
      // identical across platforms and the browser's own copy/paste (which the
      // hidden xterm helper textarea would otherwise mishandle) never fires.
      const mod = ev.ctrlKey || ev.metaKey
      if (mod && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
        // Only intercept when there's a selection — otherwise let Ctrl+C through
        // so it still sends SIGINT to the shell / running program.
        if (this.term.hasSelection()) {
          if (ev.type === 'keydown') {
            ev.preventDefault()
            this.copySelection()
          }
          return false
        }
        return true
      }
      if (mod && !ev.altKey && (ev.key === 'v' || ev.key === 'V')) {
        if (ev.type === 'keydown') {
          ev.preventDefault()
          this.requestPaste()
        }
        return false
      }
      if (ev.shiftKey && ev.key === 'Insert') {
        if (ev.type === 'keydown') {
          ev.preventDefault()
          this.requestPaste()
        }
        return false
      }
      return true
    })
  }

  /** Attach to a host element (already in the DOM and laid out) and start the PTY. */
  mount(host: HTMLElement): void {
    if (this.mounted || this.disposed) return
    this.mounted = true

    this.term.open(host)
    this.patchMouseScaling()
    this.fitNow()

    // Right-click in the terminal copies the selection (if any), else pastes —
    // the common GUI-terminal convention. Stop the right mousedown from bubbling
    // to the canvas (which would otherwise start a right-drag pan), and suppress
    // the native context menu.
    host.addEventListener('mousedown', (e) => {
      if (e.button === 2) e.stopPropagation()
    })
    host.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (this.disposed) return
      if (this.term.hasSelection()) this.copySelection()
      else this.requestPaste()
    })

    // Paste is routed through the host (vscode.env.clipboard) so it works in the
    // VS Code webview on every platform — see requestPaste(). xterm ALSO binds
    // native `paste` listeners to its root element and hidden textarea, and on
    // macOS that paste event still fires on Cmd+V (preventDefault on the keydown
    // doesn't cancel it), pasting a second time. Swallow the native paste in the
    // capture phase (before it reaches either xterm listener) so only our
    // host-routed paste runs.
    host.addEventListener(
      'paste',
      (e) => {
        e.preventDefault()
        e.stopImmediatePropagation()
      },
      true,
    )

    // Subscribe BEFORE create so no early output is dropped.
    this.unsub = this.bridge.subscribe(this.id, {
      onPaste: (text) => {
        if (this.disposed || !text) return
        // term.paste() routes through onData (and bracketed-paste mode when the
        // app enabled it), so multi-line pastes into agents stay intact.
        this.term.paste(text)
      },
      onData: (data) => {
        if (this.disposed) return
        this.observeOutput(data)
        // Ack once xterm has parsed/buffered the chunk — this is the drain
        // signal the host uses to release PTY backpressure. Same units (string
        // length) the host counts, so the byte tally stays balanced.
        this.term.write(data, () => {
          if (!this.disposed) this.bridge.ack(this.id, data.length)
        })
        this.scheduleActivityScan()
        // Push the launcher command out until startup output stops streaming.
        this.scheduleInitialCommand()
      },
      onExit: (code) => {
        if (this.disposed) return
        this.term.write(`\r\n\x1b[2m${t('processExited', code)}\x1b[0m\r\n`)
      },
    })

    const cols = this.term.cols || 80
    const rows = this.term.rows || 24
    this.bridge.create(this.id, cols, rows, this.cwd)

    // Fallback for a shell that prints nothing on startup: run anyway after a beat.
    if (this.initialCommand != null) this.scheduleInitialCommand()

    this.term.onData((data) => {
      if (this.disposed) return
      // The user started typing before the launcher fired — let them drive.
      // Ignore automatic terminal replies, which xterm also routes through
      // onData (cursor-position reports `ESC[…R`, device-attributes `ESC[…c`):
      // PSReadLine probes terminal capabilities on startup, and treating its
      // reply as a keystroke would cancel the launcher before it ever runs.
      if (this.initialCommand != null && !data.startsWith('\x1b')) this.cancelInitialCommand()
      // A keystroke answers whatever the OSC 9 notification was about; let the
      // next scan decide whether a dialog is still up.
      if (this.osc9Waiting) {
        this.osc9Waiting = false
        this.scheduleActivityScan()
      }
      this.observeInput(data)
      this.bridge.input(this.id, data)
    })
    this.term.onResize(({ cols, rows }) => {
      if (!this.disposed) this.bridge.resize(this.id, cols, rows)
    })

    // Refit on layout (node-resize) changes; zoom never changes the layout box.
    this.ro = new ResizeObserver(() => this.scheduleFit())
    this.ro.observe(host)

    // Apply a focus() that arrived before the term was open (e.g. the node was
    // created focused, before this rAF-deferred mount ran).
    if (this.wantFocus) {
      this.wantFocus = false
      this.term.focus()
    }
  }

  focus(): void {
    if (this.disposed) return
    // term.focus() is a no-op before term.open(); remember and apply in mount().
    if (!this.mounted) {
      this.wantFocus = true
      return
    }
    this.term.focus()
  }

  refreshAfterCanvasZoom(): void {
    if (this.disposed || !this.mounted) return
    if (this.zoomRefreshTimer != null) clearTimeout(this.zoomRefreshTimer)
    this.zoomRefreshTimer = window.setTimeout(() => {
      this.zoomRefreshTimer = null
      if (this.disposed) return
      this.term.refresh(0, this.term.rows - 1)
    }, 80)
  }

  /** Make xterm's pointer→cell mapping account for the world's `scale(zoom)`
   * transform. See the XtermMouseService notes above. Must run after
   * `term.open()` (the MouseService is created during open). No-op when no zoom
   * getter is wired or the internal shape is unavailable — selection then keeps
   * xterm's stock behavior (already correct at zoom = 1). */
  private patchMouseScaling(): void {
    const getZoom = this.hooks.getZoom
    if (!getZoom) return
    const core = (this.term as unknown as { _core?: { _mouseService?: XtermMouseService } })._core
    const ms = core?._mouseService
    if (!ms || ms.__jamZoomPatched || typeof ms.getCoords !== 'function') return
    ms.__jamZoomPatched = true

    // Pointer offset within `element`, converted from visual (scaled) px back to
    // layout px — the space the cell size is measured in. Padding (layout px) is
    // subtracted after the divide, matching xterm's own getCoordsRelativeToElement.
    const layoutOffset = (event: MouseEvent, element: HTMLElement, zoom: number) => {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      const padL = parseInt(style.paddingLeft) || 0
      const padT = parseInt(style.paddingTop) || 0
      return {
        x: (event.clientX - rect.left) / zoom - padL,
        y: (event.clientY - rect.top) / zoom - padT,
      }
    }

    ms.getCoords = (event, element, cols, rows, isSelection) => {
      const cell = ms._renderService?.dimensions?.css?.cell
      if (!ms._charSizeService?.hasValidSize || !cell || !cell.width || !cell.height) return undefined
      const zoom = getZoom() || 1
      const { x, y } = layoutOffset(event, element, zoom)
      let col = Math.ceil((x + (isSelection ? cell.width / 2 : 0)) / cell.width)
      let row = Math.ceil(y / cell.height)
      col = Math.min(Math.max(col, 1), cols + (isSelection ? 1 : 0))
      row = Math.min(Math.max(row, 1), rows)
      return [col, row]
    }

    ms.getMouseReportCoords = (event, element) => {
      const css = ms._renderService?.dimensions?.css
      const cell = css?.cell
      const canvas = css?.canvas
      if (!ms._charSizeService?.hasValidSize || !cell || !canvas) return undefined
      const zoom = getZoom() || 1
      const off = layoutOffset(event, element, zoom)
      const x = Math.min(Math.max(off.x, 0), canvas.width - 1)
      const y = Math.min(Math.max(off.y, 0), canvas.height - 1)
      return {
        col: Math.floor(x / cell.width),
        row: Math.floor(y / cell.height),
        x: Math.floor(x),
        y: Math.floor(y),
      }
    }
  }

  // ---- Clipboard ------------------------------------------------------------

  /** Copy the current selection to the system clipboard, then clear it. */
  private copySelection(): void {
    if (this.disposed) return
    const text = this.term.getSelection()
    if (!text) return
    this.bridge.copy(text)
    this.term.clearSelection()
  }

  /** Ask the host for the clipboard text; it comes back via the onPaste hook. */
  private requestPaste(): void {
    if (this.disposed) return
    this.term.focus()
    this.bridge.paste(this.id)
  }

  // ---- Launcher command -----------------------------------------------------

  /** (Re)arm the settle timer that types the one-shot launcher command into the
   * shell. Each call resets it, so the command fires only after output quiets. */
  private scheduleInitialCommand(): void {
    if (this.initialCommand == null || this.disposed) return
    if (this.initialCommandTimer != null) clearTimeout(this.initialCommandTimer)
    this.initialCommandTimer = window.setTimeout(() => {
      this.initialCommandTimer = null
      const cmd = this.initialCommand
      if (cmd == null || this.disposed) return
      this.initialCommand = undefined
      // Route through observeInput too, so the agent badge can light up at once.
      this.observeInput(cmd + '\r')
      this.bridge.input(this.id, cmd + '\r')
    }, INITIAL_COMMAND_SETTLE_MS)
  }

  private cancelInitialCommand(): void {
    if (this.initialCommandTimer != null) {
      clearTimeout(this.initialCommandTimer)
      this.initialCommandTimer = null
    }
    this.initialCommand = undefined
  }

  // ---- Coding-agent activity ------------------------------------------------

  /** Host-side process scan attached/detached an agent. Scanning (and activity
   * reporting) only runs while an agent is present, so plain shells produce no
   * store churn. Safe to call from a store-listener render path: it never
   * mutates state synchronously, only schedules a deferred scan. */
  setAgentPresent(present: boolean): void {
    if (this.agentPresent === present || this.disposed) return
    this.agentPresent = present
    this.lastReportedActivity = null
    // Reset per-agent latches; titleState survives on purpose — agents write
    // their title within the host's detection poll gap, before this lands.
    this.osc9Waiting = false
    this.progressWorking = false
    this.scanState = null
    if (present) this.scheduleActivityScan()
  }

  private reportInferredAgent(agent: AgentKind): void {
    if (this.inferredAgent === agent && this.agentPresent) return
    this.inferredAgent = agent
    this.hooks.onAgent?.(agent)
    if (!this.agentPresent) this.setAgentPresent(true)
  }

  private observeInput(data: string): void {
    if (data.includes('\x1b')) return

    for (const ch of data) {
      if (ch === '\x03') {
        this.pendingInputLine = ''
      } else if (ch === '\x7f' || ch === '\b') {
        this.pendingInputLine = this.pendingInputLine.slice(0, -1)
      } else if (ch === '\r' || ch === '\n') {
        const agent = classifyAgentLaunchCommand(this.pendingInputLine)
        this.pendingInputLine = ''
        if (agent) this.reportInferredAgent(agent)
      } else if (ch >= ' ') {
        this.pendingInputLine = (this.pendingInputLine + ch).slice(-512)
      }
    }
  }

  private observeOutput(data: string): void {
    if (this.agentPresent) return
    const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    this.outputProbe = (this.outputProbe + plain).slice(-4096)
    for (const probe of OUTPUT_AGENT_PROBES) {
      if (probe.re.test(this.outputProbe)) {
        this.reportInferredAgent(probe.agent)
        return
      }
    }
  }

  /** OSC 9: "4;<state>;<progress>" is ConEmu/iTerm2 progress reporting; any
   * other payload is an iTerm2-style notification message. */
  private handleOsc9(data: string): void {
    if (this.disposed) return
    if (!this.agentPresent && OSC9_WAITING_RE.test(data)) this.reportInferredAgent('codex')
    if (!this.agentPresent) return
    const progress = /^4;(\d*)/.exec(data)
    if (progress) {
      // 1 = running, 3 = indeterminate; 0/2 = cleared/error.
      this.progressWorking = progress[1] === '1' || progress[1] === '3'
      this.recomputeActivity()
      return
    }
    this.osc9Waiting = OSC9_WAITING_RE.test(data)
    this.recomputeActivity()
    // Turn-complete and the like: rescan so a stale screen verdict clears.
    if (!this.osc9Waiting) this.scheduleActivityScan()
  }

  private scheduleActivityScan(): void {
    if (!this.agentPresent || this.disposed || this.scanTimer != null) return
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null
      if (!this.agentPresent || this.disposed) return
      this.scanState = this.scanActivity()
      this.recomputeActivity()
    }, ACTIVITY_SCAN_MS)
  }

  /** Fuse the signal layers into one activity and report it on change. */
  private recomputeActivity(): void {
    if (!this.agentPresent || this.disposed) return
    const activity: AgentActivity =
      this.osc9Waiting || this.titleState === 'waiting' || this.scanState === 'waiting'
        ? 'waiting'
        : this.titleState === 'working' || this.progressWorking || this.scanState === 'working'
          ? 'working'
          : 'idle'
    if (activity !== this.lastReportedActivity) {
      this.lastReportedActivity = activity
      this.hooks.onActivity?.(activity)
    }
  }

  /** Classify the agent's state from the bottom screen of the buffer (the live
   * TUI area, regardless of how far the user has scrolled back). */
  private scanActivity(): AgentActivity {
    const buf = this.term.buffer.active
    const start = Math.max(0, buf.length - this.term.rows)
    const lines: string[] = []
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    const screen = lines.join('\n')
    if (AGENT_WORKING_RE.test(screen)) return 'working'
    if (AGENT_WAITING_RES.some((re) => re.test(screen))) return 'waiting'
    return 'idle'
  }

  private scheduleFit(): void {
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = 0
      this.fitNow()
    })
  }

  private fitNow(): void {
    try {
      this.fit.fit()
    } catch {
      // Host not laid out yet (zero size) — a later ResizeObserver tick refits.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.scanTimer != null) {
      clearTimeout(this.scanTimer)
      this.scanTimer = null
    }
    if (this.initialCommandTimer != null) {
      clearTimeout(this.initialCommandTimer)
      this.initialCommandTimer = null
    }
    if (this.zoomRefreshTimer != null) {
      clearTimeout(this.zoomRefreshTimer)
      this.zoomRefreshTimer = null
    }
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    this.ro?.disconnect()
    this.ro = null
    this.unsub?.()
    this.unsub = null
    this.bridge.kill(this.id)
    this.term.dispose()
  }
}
