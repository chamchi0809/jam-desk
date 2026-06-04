// =============================================================================
// TerminalController — an xterm.js terminal living inside a canvas node, talking
// to a node-pty shell in the extension host through the TerminalBridge.
//
// Mirrors Cate's renderer terminal (TerminalPanel + terminalRegistry): xterm in
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

  constructor(
    private id: string,
    private bridge: TerminalBridge,
    private cwd?: string,
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
      },
      onExit: (code) => {
        if (this.disposed) return
        this.term.write(`\r\n\x1b[2m[프로세스가 종료되었습니다 (코드 ${code})]\x1b[0m\r\n`)
      },
    })

    const cols = this.term.cols || 80
    const rows = this.term.rows || 24
    this.bridge.create(this.id, cols, rows, this.cwd)

    this.term.onData((data) => {
      if (!this.disposed) this.bridge.input(this.id, data)
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
    if (this.fitRaf) cancelAnimationFrame(this.fitRaf)
    this.ro?.disconnect()
    this.ro = null
    this.unsub?.()
    this.unsub = null
    this.bridge.kill(this.id)
    this.term.dispose()
  }
}
