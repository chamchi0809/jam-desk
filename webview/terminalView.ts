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
import type { AgentActivity } from './types'
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
  /** Subscribe to PTY output / exit for this id. Returns an unsubscribe fn. */
  subscribe(
    id: string,
    handlers: { onData: (data: string) => void; onExit: (code: number) => void },
  ): () => void
}

/** Optional callbacks reporting agent-relevant terminal events upward. */
export interface TerminalControllerHooks {
  /** OSC 0/2 title set by the PTY, agent state prefixes stripped (agents
   * publish their session title here). */
  onTitleChange?: (title: string) => void
  /** Derived coding-agent activity changed (only fires while an agent is attached). */
  onActivity?: (activity: AgentActivity) => void
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

  constructor(
    private id: string,
    private bridge: TerminalBridge,
    private cwd?: string,
    private hooks: TerminalControllerHooks = {},
  ) {
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
      return true
    })
  }

  /** Attach to a host element (already in the DOM and laid out) and start the PTY. */
  mount(host: HTMLElement): void {
    if (this.mounted || this.disposed) return
    this.mounted = true

    this.term.open(host)
    this.fitNow()

    // Subscribe BEFORE create so no early output is dropped.
    this.unsub = this.bridge.subscribe(this.id, {
      onData: (data) => {
        if (this.disposed) return
        // Ack once xterm has parsed/buffered the chunk — this is the drain
        // signal the host uses to release PTY backpressure. Same units (string
        // length) the host counts, so the byte tally stays balanced.
        this.term.write(data, () => {
          if (!this.disposed) this.bridge.ack(this.id, data.length)
        })
        this.scheduleActivityScan()
      },
      onExit: (code) => {
        if (this.disposed) return
        this.term.write(`\r\n\x1b[2m${t('processExited', code)}\x1b[0m\r\n`)
      },
    })

    const cols = this.term.cols || 80
    const rows = this.term.rows || 24
    this.bridge.create(this.id, cols, rows, this.cwd)

    this.term.onData((data) => {
      if (this.disposed) return
      // A keystroke answers whatever the OSC 9 notification was about; let the
      // next scan decide whether a dialog is still up.
      if (this.osc9Waiting) {
        this.osc9Waiting = false
        this.scheduleActivityScan()
      }
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

  /** OSC 9: "4;<state>;<progress>" is ConEmu/iTerm2 progress reporting; any
   * other payload is an iTerm2-style notification message. */
  private handleOsc9(data: string): void {
    if (!this.agentPresent || this.disposed) return
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
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    this.ro?.disconnect()
    this.ro = null
    this.unsub?.()
    this.unsub = null
    this.bridge.kill(this.id)
    this.term.dispose()
  }
}
