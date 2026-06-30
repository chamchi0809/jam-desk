// =============================================================================
// Shared types & constants for the Jam Desk webview.
// Geometry primitives, node/region models, and zoom/grid constants are ported
// faithfully from the upstream IDE (src/shared/types.ts, layoutEngine.ts).
//
// The upstream IDE's node "content" (editor / browser / agent panels) is deeply
// Electron-coupled, so here a node hosts VS Code-friendly content: a free-text
// *note*, a *file card* that opens a workspace file in the editor, or a live
// *terminal* (xterm.js in the webview ⇄ a node-pty shell in the extension host,
// mirroring the upstream IDE's terminal architecture).
// =============================================================================

// ---- Geometry primitives (ported verbatim from the upstream IDE) ------------------------

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  origin: Point
  size: Size
}

// ---- Node content kinds (VS Code adaptation) --------------------------------

export type NodeKind = 'note' | 'file' | 'terminal' | 'browser'

export type CanvasNodeId = string

export interface CanvasNodeState {
  id: CanvasNodeId
  kind: NodeKind
  /** Note body (markdown-ish plain text) for `note` nodes. */
  text?: string
  /** Workspace-relative path for `file` nodes. */
  filePath?: string
  /** Current URL embedded in a `browser` node's iframe. Empty until the user
   *  navigates; persisted so the page is restored on reload. */
  url?: string
  /** Zoom factor for a `browser` node's embedded page (CSS `zoom` on the iframe).
   *  Defaults to 1; persisted. */
  browserZoom?: number
  /** Optional starting working directory for `terminal` nodes (absolute or
   *  workspace-relative). Defaults to the workspace root on the host. */
  cwd?: string
  /** Ephemeral: a command typed into a freshly-spawned `terminal` once its shell
   *  settles (used by the Claude Code / Codex launcher buttons). Consumed once by
   *  the TerminalController and stripped from serialization + history, so it never
   *  persists or re-runs on reload/undo. */
  initialCommand?: string
  /** Display title — note heading or file basename. */
  title: string
  /** Optional accent color (CSS color string). */
  color?: string
  origin: Point
  size: Size
  zOrder: number
  creationIndex: number
  preMaximizeOrigin?: Point
  preMaximizeSize?: Size
  isPinned?: boolean
  animationState?: 'entering' | 'exiting' | 'idle'
  regionId?: string
}

/** Mirrors the upstream IDE's `isMaximized` computed helper. */
export function isMaximized(node: CanvasNodeState): boolean {
  return node.preMaximizeOrigin != null
}

// ---- Coding-agent status (terminal nodes) ------------------------------------

/** Coding-agent CLIs recognized inside a terminal's PTY process tree. */
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'pi'

/** What the agent is doing, derived from its TUI screen contents. */
export type AgentActivity = 'idle' | 'working' | 'waiting'

/** Ephemeral per-terminal agent state — runtime only, never persisted. */
export interface TerminalAgentState {
  agent: AgentKind | null
  activity: AgentActivity
  /** Last OSC 0/2 title from the PTY, state prefixes already stripped — agents
   * publish their session title here (see cleanAgentTitle). */
  oscTitle?: string
  oscTitleAt?: number
  /** When the current agent was first detected (epoch ms). */
  agentSince?: number
}

// ---- Agent title signals ------------------------------------------------------
// Both agent TUIs encode their state into the OSC 0 terminal title, which makes
// the title a structured signal rather than a guess (verified against Claude
// Code 2.1.162's bundle and openai/codex's status_surfaces.rs):
//  - Claude Code:  "⠂ <topic>" / "⠐ <topic>" while a task runs (frames swap
//    ~960ms), "✳ <topic>" otherwise. Waiting-for-permission is NOT title-coded —
//    that still needs the screen-scan fallback.
//  - Codex:        "⠋ <project>" (10 braille frames, 100ms) while working,
//    "[ ! ] Action Required | <project>" (blinking "[ . ]") while blocked on
//    user input, and the bare "<project>" when idle.
//  - opencode:     does NOT title-code state (its TUI footer uses a "blocks"
//    spinner, not braille) — relies entirely on the screen-scan fallback.
//  - Pi:           only title-codes when the user enables its `titlebar-spinner`
//    extension ("⠋ π - <session> - <cwd>", caught by TITLE_WORKING_RE); the
//    default build relies on the screen-scan ("(<key> to cancel)" hint).

/** Leading braille spinner frame — either agent is actively working. */
const TITLE_WORKING_RE = /^[⠀-⣿]\s/
/** Codex's blocked-on-input title ("[ ! ] Action Required | project"). */
const TITLE_WAITING_RE = /^\[\s*[!.]\s*\]\s*action required\s*(\|\s*)?/i

/** Read the activity state an agent encoded into its OSC title, if any. */
export function classifyAgentTitle(raw: string): 'working' | 'waiting' | null {
  const s = raw.trimStart()
  if (TITLE_WORKING_RE.test(s)) return 'working'
  if (TITLE_WAITING_RE.test(s)) return 'waiting'
  return null
}

/** Strip the per-state prefixes off an OSC title, leaving the session/topic
 * text. The result is stable across spinner frames (Codex rewrites the title
 * every 100ms while working), so storing the cleaned title dedupes upstream. */
export function cleanAgentTitle(raw: string): string {
  return raw
    .replace(TITLE_WAITING_RE, '')
    .replace(/^[\s⠀-⣿✳✶✻✽·∗*]+/, '')
    .trim()
}

export const AGENT_DISPLAY_NAMES: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
  pi: 'Pi',
}

/** Per-activity accent color, RunCat365 runner sprite (media/runners/), and the
 *  short English badge label (matches Claude Code's own status wording):
 *  idle → horse (blue), working → cat (amber), waiting → parrot (pink). */
export const AGENT_ACTIVITY_META: Record<
  AgentActivity,
  { color: string; runner: 'cat' | 'horse' | 'parrot'; label: string }
> = {
  idle: { color: '#6c9ef8', runner: 'horse', label: 'Idle' },
  working: { color: '#f0a35e', runner: 'cat', label: 'Working…' },
  waiting: { color: '#ef5e88', runner: 'parrot', label: 'Waiting' },
}

/** One emoji per agent activity, shown in the Jam Desk panel (editor tab) title.
 *  working → running, waiting → needs user input, idle → attached but quiet. */
export const AGENT_ACTIVITY_EMOJI: Record<AgentActivity, string> = {
  working: '🏃',
  waiting: '🙋',
  idle: '💤',
}

/** Build the panel-title agent summary: one emoji per terminal that currently
 *  hosts a coding agent, grouped by activity (working → waiting → idle) so the
 *  string stays stable as individual agents change state. Empty when none run. */
export function agentActivityEmojiSummary(
  agents: Record<string, TerminalAgentState>,
): string {
  const counts: Record<AgentActivity, number> = { working: 0, waiting: 0, idle: 0 }
  for (const rec of Object.values(agents)) {
    if (rec?.agent) counts[rec.activity]++
  }
  const order: AgentActivity[] = ['working', 'waiting', 'idle']
  return order.map((a) => AGENT_ACTIVITY_EMOJI[a].repeat(counts[a])).join('')
}

/** A shell title set long before the agent attached belongs to the shell, not
 * the agent; only titles from (just before or) during the session are trusted. */
const AGENT_TITLE_GRACE_MS = 8000

/** Panel title for a terminal hosting an agent: the agent's session title when
 * known, else the agent's display name. Null when no agent is attached. */
export function agentDisplayTitle(rec: TerminalAgentState | undefined): string | null {
  if (!rec?.agent) return null
  const raw = rec.oscTitle?.trim()
  if (
    raw &&
    rec.oscTitleAt != null &&
    rec.agentSince != null &&
    rec.oscTitleAt >= rec.agentSince - AGENT_TITLE_GRACE_MS
  ) {
    // Stored titles are already cleaned; re-clean defensively (idempotent).
    const cleaned = cleanAgentTitle(raw)
    if (cleaned) return cleaned
  }
  return AGENT_DISPLAY_NAMES[rec.agent]
}

// ---- Region (group container, ported from the upstream IDE) -----------------------------

export interface CanvasRegion {
  id: string
  origin: Point
  size: Size
  label: string
  color: string
  zOrder: number
}

// ---- Snap guide lines --------------------------------------------------------

export interface SnapLine {
  axis: 'x' | 'y'
  position: number
  type: 'edge' | 'center'
}

export interface SnapGuides {
  lines: SnapLine[]
}

// ---- Persisted canvas document ----------------------------------------------

export interface CanvasDocument {
  version: 2
  nodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  viewportOffset: Point
  zoomLevel: number
  focusedNodeId: CanvasNodeId | null
  nextZOrder: number
  nextCreationIndex: number
}

// ---- Tools -------------------------------------------------------------------

export type CanvasTool = 'select' | 'hand'

// ---- Zoom constants (from the upstream IDE's CanvasState.swift) -------------

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 3.0
export const ZOOM_DEFAULT = 1.0

// ---- Grid (from the upstream IDE layoutEngine.ts) ---------------------------------------

/** Canvas-space spacing of the snap/background grid, in canvas units. */
export const CANVAS_GRID_SIZE = 20

// ---- Per-kind default / minimum sizes ---------------------------------------

export const NODE_DEFAULT_SIZES: Record<NodeKind, Size> = {
  note: { width: 280, height: 200 },
  file: { width: 320, height: 160 },
  terminal: { width: 520, height: 340 },
  browser: { width: 720, height: 520 },
}

export const NODE_MINIMUM_SIZES: Record<NodeKind, Size> = {
  note: { width: 140, height: 100 },
  file: { width: 200, height: 92 },
  terminal: { width: 240, height: 140 },
  browser: { width: 280, height: 200 },
}

/** A palette of accent colors offered for notes & regions (RGBA so the minimap
 *  can derive translucent fills, matching the upstream IDE's REGION_FILL_COLORS approach). */
export const ACCENT_COLORS: string[] = [
  'rgba(74, 158, 255, 1)',
  'rgba(120, 200, 120, 1)',
  'rgba(240, 180, 90, 1)',
  'rgba(220, 110, 110, 1)',
  'rgba(180, 130, 230, 1)',
  'rgba(120, 200, 220, 1)',
  'rgba(150, 150, 160, 1)',
]
