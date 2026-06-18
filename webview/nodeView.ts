// =============================================================================
// CanvasView — DOM reconciler for nodes & regions inside the world transform.
//
// Renders each node/region as an absolutely-positioned element at canvas-space
// coordinates (the world div's transform maps canvas → screen). On every store
// change it diffs which slice moved (nodes / regions / focus / selection /
// drop-target) and updates only the affected elements in place — creating
// elements for new ids and removing them for vanished ids (after the exit
// animation for nodes).
//
// Gestures (drag, resize, region drag/resize) are delegated to gestures.ts.
// The DOM contract with interaction.ts is honored: nodes carry `data-node-id`,
// regions carry `data-region-id`, scrollable content carries `data-node-content`,
// and node/region mousedown handlers bail WITHOUT stopPropagation for non-left
// buttons and under the hand tool, so the canvas pan handler still receives them.
// =============================================================================

import type { CanvasStore, CanvasData } from './store'
import type { CanvasNodeState, CanvasRegion, AgentActivity, TerminalAgentState } from './types'
import { AGENT_ACTIVITY_META, AGENT_DISPLAY_NAMES, agentDisplayTitle } from './types'
import { detectEdge, getCursorForEdge } from './resizeEdge'
import {
  beginNodeDrag,
  beginNodeResize,
  beginRegionDrag,
  beginRegionResize,
} from './gestures'
import { isMaximized } from './types'
import { TerminalController } from './terminalView'
import type { TerminalBridge } from './terminalView'
import type { FileBridge, FileContentData } from './persistence'
import { highlightInto } from './fileHighlight'
import { icons } from './icons'
import { settings } from './settings'
import type { LauncherButton } from './settings'
import { t } from './i18n'
import type { MessageKey } from './i18n'

export interface CanvasViewHooks {
  /** Open a workspace file (file-card "open" / double-click). */
  onOpenFile?: (filePath: string) => void
  /** Open a URL in the system browser (browser node "open externally"). */
  onOpenExternal?: (url: string) => void
  /** Ask the host whether a URL permits iframe embedding (X-Frame-Options / CSP
   * frame-ancestors). Used to show a clear notice instead of a blank frame. */
  onCheckEmbeddable?: (url: string) => Promise<boolean>
  /** Open the webview developer tools (browser node "debug" button). */
  onOpenDevTools?: () => void
  /** Bridge to the host PTY backend, used by `terminal` nodes. */
  terminals?: TerminalBridge
  /** Bridge to the host file reader/watcher, used by `file` node previews. */
  files?: FileBridge
}

interface NodeElements {
  container: HTMLDivElement
  card: HTMLDivElement
  titleEl: HTMLSpanElement
  pinBtn: HTMLButtonElement
  maxBtn: HTMLButtonElement
  content: HTMLDivElement
  // note
  textarea?: HTMLTextAreaElement
  // file
  filePathEl?: HTMLSpanElement
  fileCodeEl?: HTMLElement
  fileStatusEl?: HTMLDivElement
  /** The path currently subscribed via the file bridge (re-subscribe on change). */
  watchedPath?: string
  /** Unsubscribe from the file bridge for this node's current path. */
  fileUnsub?: () => void
  // terminal
  terminal?: TerminalController
  agentBadge?: HTMLSpanElement
  agentRunner?: HTMLSpanElement
  agentLabel?: HTMLSpanElement
  // browser
  iframe?: HTMLIFrameElement
  urlInput?: HTMLInputElement
  browserBackBtn?: HTMLButtonElement
  browserForwardBtn?: HTMLButtonElement
  /** URL whose embeddability is currently being checked — guards against a
   *  stale check result overwriting a newer navigation. */
  embedCheckUrl?: string
  /** Auto-fading "open externally" hint shown on each navigation. */
  browserHint?: HTMLDivElement
  /** Live zoom-percentage readout in the browser bar. */
  browserZoomLabel?: HTMLButtonElement
  /** Address-bar navigation history (link clicks inside a cross-origin frame
   *  can't be observed, so back/forward only span bar navigations). */
  browserHistory?: string[]
  browserIndex?: number
  /** URL currently loaded into the iframe — guards against reloading on every
   *  unrelated store change. */
  loadedUrl?: string
  animState?: string
  // Cancellable finalize timer for the exit animation (independent of any opacity
  // transition, so it fires even when opacity stays 0→0). Cleared if the node is
  // restored (e.g. undo) before it runs.
  exitTimer?: number
  // The entering flip-to-idle double-rAF, captured so it can be cancelled if the
  // node starts exiting before it fires (otherwise it would resurrect the node).
  enterRafOuter?: number
  enterRafInner?: number
}

/** Exit-animation duration before the node is removed from the store/DOM.
 * Matches the upstream IDE's setTimeout(200) finalize and comfortably outlasts the 0.18s
 * CSS opacity/transform transition. */
const EXIT_ANIM_MS = 200

/** Built-in launchers always offered in a terminal node's launcher menu,
 * ahead of the user's custom ones. */
const PRESET_LAUNCHERS: LauncherButton[] = [
  { label: 'Claude Code', command: 'claude' },
  { label: 'Codex', command: 'codex' },
]

/** Tooltip label key per agent activity (badge hover). */
const AGENT_ACTIVITY_LABEL: Record<AgentActivity, MessageKey> = {
  idle: 'agentIdle',
  working: 'agentWorking',
  waiting: 'agentWaiting',
}

interface RegionElements {
  container: HTMLDivElement
  labelBar: HTMLDivElement
  labelText: HTMLSpanElement
}

/** The sandbox flags a browser node's iframe runs under — permissive enough for
 *  ordinary sites (scripts, forms, popups, downloads) without granting the frame
 *  top-level navigation of the host webview. */
const BROWSER_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock'

/** Turn whatever the user typed in the address bar into a navigable URL: keep an
 *  explicit http(s) scheme, assume https for bare hosts (example.com, localhost:3000,
 *  192.168.0.1), and fall back to a web search for free text. */
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  const looksLikeHost =
    /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s) || /^[\w-]+(\.[\w-]+)+/.test(s)
  if (looksLikeHost) return 'https://' + s
  return 'https://www.google.com/search?q=' + encodeURIComponent(s)
}

/** Short address-bar / title label for a URL: its host (with path hint), or the
 *  raw string if it does not parse. */
function hostLabel(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function effectiveToolOf(store: CanvasStore, spaceHeld: () => boolean): 'select' | 'hand' {
  return spaceHeld() ? 'hand' : store.getState().tool
}

export class CanvasView {
  private nodeEls = new Map<string, NodeElements>()
  private regionEls = new Map<string, RegionElements>()
  private unsubscribe: () => void
  /** Open terminal-node launcher dropdown, if any. */
  private launcherMenu: HTMLDivElement | null = null

  /** Provided by main: reports whether Space is currently held (hand override). */
  spaceHeld: () => boolean = () => false

  constructor(
    private world: HTMLElement,
    private store: CanvasStore,
    private hooks: CanvasViewHooks = {},
  ) {
    const s = store.getState()
    this.reconcileRegions(s)
    this.reconcileNodes(s)

    this.unsubscribe = store.subscribe((next, prev) => {
      if (
        next.regions !== prev.regions ||
        next.selectedRegionIds !== prev.selectedRegionIds ||
        next.selectedNodeIds !== prev.selectedNodeIds ||
        next.dropTargetRegionId !== prev.dropTargetRegionId
      ) {
        this.reconcileRegions(next)
      }
      if (
        next.nodes !== prev.nodes ||
        next.focusedNodeId !== prev.focusedNodeId ||
        next.selectedNodeIds !== prev.selectedNodeIds ||
        next.agents !== prev.agents
      ) {
        this.reconcileNodes(next)
      }
      // When a terminal node becomes the focused node (created, command, or
      // Tab/arrow navigation), move DOM focus into its xterm so keystrokes go
      // to the shell instead of being swallowed as canvas shortcuts. Keyed on
      // focusEpoch too, so re-focusing the same id re-applies. The controller
      // defers focus() until mount() if it isn't open yet.
      if (
        next.focusedNodeId &&
        (next.focusedNodeId !== prev.focusedNodeId || next.focusEpoch !== prev.focusEpoch)
      ) {
        this.nodeEls.get(next.focusedNodeId)?.terminal?.focus()
      }
    })
  }

  // ---- Nodes ---------------------------------------------------------------

  private reconcileNodes(s: CanvasData): void {
    const seen = new Set<string>()
    for (const node of Object.values(s.nodes)) {
      seen.add(node.id)
      let el = this.nodeEls.get(node.id)
      if (!el) {
        el = this.createNodeElement(node)
        this.nodeEls.set(node.id, el)
        this.world.appendChild(el.container)
      }
      this.updateNodeElement(el, node, s)
    }
    for (const [id, el] of this.nodeEls) {
      if (!seen.has(id)) {
        this.clearNodeTimers(el)
        el.fileUnsub?.()
        el.terminal?.dispose()
        el.container.remove()
        this.nodeEls.delete(id)
      }
    }
  }

  /** Cancel any pending enter-rAF / exit-finalize timer for a node element. */
  private clearNodeTimers(el: NodeElements): void {
    if (el.exitTimer != null) {
      clearTimeout(el.exitTimer)
      el.exitTimer = undefined
    }
    if (el.enterRafOuter != null) {
      cancelAnimationFrame(el.enterRafOuter)
      el.enterRafOuter = undefined
    }
    if (el.enterRafInner != null) {
      cancelAnimationFrame(el.enterRafInner)
      el.enterRafInner = undefined
    }
  }

  private createNodeElement(node: CanvasNodeState): NodeElements {
    const container = document.createElement('div')
    container.className = 'cnode'
    container.setAttribute('data-node-id', node.id)
    container.style.position = 'absolute'

    const card = document.createElement('div')
    card.className = 'cnode-card'

    const titlebar = document.createElement('div')
    titlebar.className = 'cnode-titlebar'
    titlebar.setAttribute('data-grab', '')

    const titleEl = document.createElement('span')
    titleEl.className = 'cnode-title'

    const actions = document.createElement('div')
    actions.className = 'cnode-actions'

    const pinBtn = document.createElement('button')
    pinBtn.className = 'cnode-btn'
    pinBtn.title = t('pin')
    pinBtn.innerHTML = icons.pin
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.togglePin(node.id)
    })

    const maxBtn = document.createElement('button')
    maxBtn.className = 'cnode-btn'
    maxBtn.title = t('maximize')
    maxBtn.innerHTML = icons.arrowsMaximize
    maxBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.toggleMaximize(node.id, this.store.getState().containerSize)
    })

    const closeBtn = document.createElement('button')
    closeBtn.className = 'cnode-btn cnode-btn-close'
    closeBtn.title = t('close')
    closeBtn.innerHTML = icons.x
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.store.removeNode(node.id)
    })

    actions.append(pinBtn, maxBtn, closeBtn)
    titlebar.append(titleEl, actions)

    const content = document.createElement('div')
    content.className = 'cnode-content'
    content.setAttribute('data-node-content', '')

    const el: NodeElements = { container, card, titleEl, pinBtn, maxBtn, content }

    if (node.kind === 'note') {
      const ta = document.createElement('textarea')
      ta.className = 'cnode-note'
      ta.placeholder = t('notePlaceholder')
      ta.spellcheck = false
      const selectAndFocusNote = () => {
        const state = this.store.getState()
        if (
          state.selectedNodeIds.size !== 1 ||
          !state.selectedNodeIds.has(node.id) ||
          state.selectedRegionIds.size > 0
        ) {
          this.store.clearSelection()
          this.store.selectNodes([node.id])
        }
        this.store.focusNode(node.id)
      }
      ta.addEventListener('focus', () => {
        selectAndFocusNote()
        // One undo step per editing session.
        this.store.pushHistory()
      })
      ta.addEventListener('input', () => {
        this.store.setNodeText(node.id, ta.value)
      })
      // 메모 본문을 클릭해도 카드 선택 상태가 해당 메모로 이동해야 한다.
      ta.addEventListener('pointerdown', (e) => {
        if (e.button === 0 && effectiveToolOf(this.store, this.spaceHeld) === 'select') {
          selectAndFocusNote()
        }
        e.stopPropagation()
      })
      ta.addEventListener('mousedown', (e) => {
        if (e.button === 0 && effectiveToolOf(this.store, this.spaceHeld) === 'select') {
          selectAndFocusNote()
        }
        e.stopPropagation()
      })
      content.appendChild(ta)
      el.textarea = ta
    } else if (node.kind === 'terminal') {
      container.classList.add('is-terminal')
      // Agent status badge (animated RunCat runner) — hidden via CSS until a
      // coding agent (Claude Code / Codex) is detected in this terminal's PTY.
      const badge = document.createElement('span')
      badge.className = 'cnode-agent'
      const runner = document.createElement('span')
      runner.className = 'cnode-agent-runner'
      const label = document.createElement('span')
      label.className = 'cnode-agent-label'
      badge.appendChild(runner)
      badge.appendChild(label)
      titlebar.insertBefore(badge, titleEl)
      el.agentBadge = badge
      el.agentRunner = runner
      el.agentLabel = label

      const host = document.createElement('div')
      host.className = 'cnode-terminal'
      content.appendChild(host)
      if (this.hooks.terminals) {
        const ctrl = new TerminalController(
          node.id,
          this.hooks.terminals,
          node.cwd,
          {
            onAgent: (agent) => this.store.updateTerminalAgent(node.id, { agent }),
            onTitleChange: (title) => this.store.updateTerminalAgent(node.id, { oscTitle: title }),
            onActivity: (activity) => this.store.updateTerminalAgent(node.id, { activity }),
            getZoom: () => this.store.getState().zoomLevel,
          },
          node.initialCommand,
        )
        el.terminal = ctrl
        // Launcher dropdown — runs a configured command in THIS terminal. The
        // menu reads settings live on open, so edits need no per-node rebuild.
        const launcherBtn = document.createElement('button')
        launcherBtn.className = 'cnode-btn'
        launcherBtn.title = t('runLauncher')
        launcherBtn.innerHTML = icons.rocket
        launcherBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          this.openLauncherMenu(launcherBtn, ctrl)
        })
        actions.insertBefore(launcherBtn, pinBtn)
        // Mount after this element is attached + sized so the first fit() is correct.
        requestAnimationFrame(() => ctrl.mount(host))
      } else {
        host.textContent = t('terminalUnavailable')
      }
    } else if (node.kind === 'browser') {
      container.classList.add('is-browser')
      const browser = document.createElement('div')
      browser.className = 'cnode-browser'

      // Address / navigation bar.
      const bar = document.createElement('div')
      bar.className = 'cnode-browser-bar'

      const backBtn = document.createElement('button')
      backBtn.className = 'cnode-browser-nav'
      backBtn.title = t('browserBack')
      backBtn.innerHTML = icons.arrowLeft
      backBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.browserGo(el, node.id, -1)
      })

      const fwdBtn = document.createElement('button')
      fwdBtn.className = 'cnode-browser-nav'
      fwdBtn.title = t('browserForward')
      fwdBtn.innerHTML = icons.arrowRight
      fwdBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.browserGo(el, node.id, +1)
      })

      const reloadBtn = document.createElement('button')
      reloadBtn.className = 'cnode-browser-nav'
      reloadBtn.title = t('browserReload')
      reloadBtn.innerHTML = icons.reload
      reloadBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (el.iframe && el.iframe.src && el.iframe.src !== 'about:blank') {
          el.iframe.src = el.iframe.src
        }
      })

      const urlInput = document.createElement('input')
      urlInput.className = 'cnode-browser-url'
      urlInput.type = 'text'
      urlInput.placeholder = t('browserAddress')
      urlInput.spellcheck = false
      // Let the field take the caret/selection without starting a node drag.
      urlInput.addEventListener('mousedown', (e) => e.stopPropagation())
      // Only intercept Enter (navigate). Every other key — Cmd/Ctrl+A, +C, +V,
      // +X, arrows, undo… — must reach the field natively, so we DON'T blanket
      // stopPropagation (that breaks the webview's clipboard/selection). Canvas
      // shortcuts are already suppressed while an input is focused (isTyping()).
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          this.browserNavigate(el, node.id, urlInput.value)
          urlInput.blur()
        }
      })

      // Zoom controls for the embedded page (CSS `zoom` on the iframe).
      const zoomOutBtn = document.createElement('button')
      zoomOutBtn.className = 'cnode-browser-nav'
      zoomOutBtn.title = t('browserZoomOut')
      zoomOutBtn.innerHTML = icons.zoomOut
      zoomOutBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.browserZoomBy(node.id, -0.1)
      })

      const zoomLabel = document.createElement('button')
      zoomLabel.className = 'cnode-browser-zoom'
      zoomLabel.title = t('browserZoomReset')
      zoomLabel.textContent = '100%'
      zoomLabel.addEventListener('click', (e) => {
        e.stopPropagation()
        this.store.setNodeBrowserZoom(node.id, 1)
      })

      const zoomInBtn = document.createElement('button')
      zoomInBtn.className = 'cnode-browser-nav'
      zoomInBtn.title = t('browserZoomIn')
      zoomInBtn.innerHTML = icons.zoomIn
      zoomInBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.browserZoomBy(node.id, +0.1)
      })

      const devToolsBtn = document.createElement('button')
      devToolsBtn.className = 'cnode-browser-nav'
      devToolsBtn.title = t('browserDevTools')
      devToolsBtn.innerHTML = icons.bug
      devToolsBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.hooks.onOpenDevTools?.()
      })

      const extBtn = document.createElement('button')
      extBtn.className = 'cnode-browser-nav'
      extBtn.title = t('browserOpenExternal')
      extBtn.innerHTML = icons.externalLink
      extBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const u = this.store.getState().nodes[node.id]?.url
        if (u) this.hooks.onOpenExternal?.(normalizeUrl(u))
      })

      bar.append(
        backBtn,
        fwdBtn,
        reloadBtn,
        urlInput,
        zoomOutBtn,
        zoomLabel,
        zoomInBtn,
        devToolsBtn,
        extBtn,
      )

      // Viewport: the iframe, with a placeholder shown until a URL is entered.
      const wrap = document.createElement('div')
      wrap.className = 'cnode-browser-viewport'
      const iframe = document.createElement('iframe')
      iframe.className = 'cnode-browser-frame'
      iframe.setAttribute('sandbox', BROWSER_SANDBOX)
      iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade')
      const blank = document.createElement('div')
      blank.className = 'cnode-browser-blank'
      blank.textContent = t('browserBlank')

      // Shown when the host reports the site forbids embedding (X-Frame-Options
      // / CSP frame-ancestors) — otherwise the frame would just be blank.
      const blocked = document.createElement('div')
      blocked.className = 'cnode-browser-blocked'
      const blockedMsg = document.createElement('p')
      blockedMsg.className = 'cnode-browser-blocked-msg'
      blockedMsg.textContent = t('browserBlocked')
      const blockedBtn = document.createElement('button')
      blockedBtn.className = 'cnode-browser-blocked-open'
      blockedBtn.textContent = t('browserOpenExternal')
      blockedBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const u = this.store.getState().nodes[node.id]?.url
        if (u) this.hooks.onOpenExternal?.(normalizeUrl(u))
      })
      blocked.append(blockedMsg, blockedBtn)

      // A slim, auto-fading hint shown on every navigation: some sites load then
      // blank themselves (frame-busting) or fail a bot check — that's invisible
      // to us cross-origin, so we always surface a one-click escape hatch.
      const hint = document.createElement('div')
      hint.className = 'cnode-browser-hint'
      const hintText = document.createElement('span')
      hintText.textContent = t('browserHint')
      const hintBtn = document.createElement('button')
      hintBtn.className = 'cnode-browser-hint-open'
      hintBtn.textContent = t('browserOpenExternal')
      hintBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const u = this.store.getState().nodes[node.id]?.url
        if (u) this.hooks.onOpenExternal?.(normalizeUrl(u))
      })
      hint.append(hintText, hintBtn)
      // Drop the pill once it has faded so its (invisible) button isn't clickable.
      hint.addEventListener('animationend', () => hint.classList.remove('is-visible'))

      wrap.append(iframe, blank, hint, blocked)

      browser.append(bar, wrap)
      content.appendChild(browser)

      el.iframe = iframe
      el.urlInput = urlInput
      el.browserBackBtn = backBtn
      el.browserForwardBtn = fwdBtn
      el.browserHint = hint
      el.browserZoomLabel = zoomLabel
      // Seed history from any persisted URL so back/forward have a starting point.
      el.browserHistory = node.url ? [node.url] : []
      el.browserIndex = node.url ? 0 : -1
    } else {
      container.classList.add('is-file')
      const file = document.createElement('div')
      file.className = 'cnode-file'

      // Header: file icon + relative path + open-in-editor button.
      const head = document.createElement('div')
      head.className = 'cnode-file-head'
      head.setAttribute('data-grab', '')
      const icon = document.createElement('span')
      icon.className = 'cnode-file-icon'
      icon.innerHTML = icons.file
      const pathEl = document.createElement('span')
      pathEl.className = 'cnode-file-path'
      const openBtn = document.createElement('button')
      openBtn.className = 'cnode-file-open'
      openBtn.textContent = t('open')
      openBtn.title = t('open')
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const fp = this.store.getState().nodes[node.id]?.filePath
        if (fp) this.hooks.onOpenFile?.(fp)
      })
      head.append(icon, pathEl, openBtn)

      // Read-only syntax-highlighted preview, kept in sync by the file bridge.
      const pre = document.createElement('pre')
      pre.className = 'cnode-file-code'
      const code = document.createElement('code')
      code.className = 'hljs'
      pre.appendChild(code)

      // Status line (loading / missing / binary / truncated).
      const status = document.createElement('div')
      status.className = 'cnode-file-status'
      status.textContent = t('filePreviewLoading')

      file.append(head, pre, status)
      content.appendChild(file)
      content.addEventListener('dblclick', () => {
        const fp = this.store.getState().nodes[node.id]?.filePath
        if (fp) this.hooks.onOpenFile?.(fp)
      })
      el.filePathEl = pathEl
      el.fileCodeEl = code
      el.fileStatusEl = status
    }

    card.append(titlebar, content)
    container.appendChild(card)

    // ---- Pointer wiring --------------------------------------------------
    container.addEventListener('mousedown', (e) => this.onNodeMouseDown(e, node.id))
    container.addEventListener('mousemove', (e) => this.onNodeMouseMove(e, node.id))

    return el
  }

  private onNodeMouseDown(e: MouseEvent, id: string): void {
    if (e.button !== 0) return // right/middle → bubble to canvas pan
    if (effectiveToolOf(this.store, this.spaceHeld) === 'hand') return // bubble → pan

    const node = this.store.getState().nodes[id]
    if (!node) return
    const target = e.target as HTMLElement

    // Buttons handle their own click; don't drag/resize.
    if (target.closest('button')) {
      e.stopPropagation()
      return
    }

    // Selection.
    if (e.shiftKey) {
      e.stopPropagation()
      this.store.toggleNodeSelection(id)
      this.store.focusNode(id)
      return
    }
    if (!this.store.getState().selectedNodeIds.has(id)) {
      this.store.selectNodes([id])
    }
    this.store.focusNode(id)

    // Resize (edge hit) — unless pinned.
    if (!node.isPinned) {
      const edge = this.edgeAt(e, id)
      if (edge) {
        beginNodeResize(this.store, id, edge, e)
        return
      }
    }

    // Drag from the title bar or the (non-content) card body.
    const onContent = target.closest('[data-node-content]')
    const onTitlebar = target.closest('[data-grab]')
    if (onTitlebar || !onContent) {
      beginNodeDrag(this.store, id, e)
      return
    }

    // Clicked inside scrollable content (e.g. textarea / terminal): focus only;
    // keep the canvas from clearing selection, but allow the caret to land.
    this.nodeEls.get(id)?.terminal?.focus()
    e.stopPropagation()
  }

  private onNodeMouseMove(e: MouseEvent, id: string): void {
    const el = this.nodeEls.get(id)
    if (!el) return
    if (effectiveToolOf(this.store, this.spaceHeld) !== 'select') {
      el.container.style.cursor = ''
      return
    }
    const node = this.store.getState().nodes[id]
    if (!node || node.isPinned) {
      el.container.style.cursor = ''
      return
    }
    const edge = this.edgeAt(e, id)
    el.container.style.cursor = edge ? getCursorForEdge(edge) : ''
  }

  /** Edge hit-test in the node's local canvas coordinates. */
  private edgeAt(e: MouseEvent, id: string) {
    const el = this.nodeEls.get(id)
    const node = this.store.getState().nodes[id]
    if (!el || !node) return null
    const rect = el.container.getBoundingClientRect()
    const zoom = this.store.getState().zoomLevel
    const localX = (e.clientX - rect.left) / zoom
    const localY = (e.clientY - rect.top) / zoom
    return detectEdge(localX, localY, node.size.width, node.size.height, zoom)
  }

  private updateNodeElement(el: NodeElements, node: CanvasNodeState, s: CanvasData): void {
    const c = el.container
    c.style.left = `${node.origin.x}px`
    c.style.top = `${node.origin.y}px`
    c.style.width = `${node.size.width}px`
    c.style.height = `${node.size.height}px`
    c.style.zIndex = String(1000 + node.zOrder)

    // Title + content. A terminal hosting a coding agent shows the agent's
    // session title (or its name) instead of the stored node title.
    const fallbackTitle =
      node.kind === 'note'
        ? t('defaultNote')
        : node.kind === 'terminal'
          ? t('defaultTerminal')
          : node.kind === 'browser'
            ? t('defaultBrowser')
            : t('defaultFile')
    const agentRec = node.kind === 'terminal' ? s.agents[node.id] : undefined
    // A browser node titles itself after the page host, so the tab reads
    // "github.com" rather than the generic "Browser".
    const browserTitle = node.kind === 'browser' && node.url ? hostLabel(node.url) : null
    el.titleEl.textContent =
      agentDisplayTitle(agentRec) ?? browserTitle ?? (node.title || fallbackTitle)
    if (node.kind === 'terminal') this.syncAgentChrome(el, agentRec)

    if (node.kind === 'note' && el.textarea) {
      const next = node.text ?? ''
      if (document.activeElement !== el.textarea && el.textarea.value !== next) {
        el.textarea.value = next
      }
    } else if (node.kind === 'file') {
      const fp = node.filePath ?? ''
      if (el.filePathEl) el.filePathEl.textContent = fp
      this.syncFileWatch(el, fp)
    } else if (node.kind === 'browser') {
      this.syncBrowser(el, node)
    }

    // Accent color (left border tint).
    c.style.setProperty('--node-accent', node.color || 'transparent')

    // Focus / selection state.
    const focused = s.focusedNodeId === node.id
    const selected = s.selectedNodeIds.has(node.id)
    c.classList.toggle('is-focused', focused)
    c.classList.toggle('is-selected', selected)
    c.classList.toggle('is-pinned', !!node.isPinned)
    c.classList.toggle('is-maximized', isMaximized(node))
    el.pinBtn.classList.toggle('is-active', !!node.isPinned)
    // Only swap the SVG when the maximize state actually flips — sync runs on
    // every store change and innerHTML would rebuild the icon DOM each time.
    const maxState = isMaximized(node) ? 'maximized' : 'normal'
    if (el.maxBtn.dataset.state !== maxState) {
      el.maxBtn.dataset.state = maxState
      el.maxBtn.innerHTML = maxState === 'maximized' ? icons.arrowsMinimize : icons.arrowsMaximize
    }

    // Enter / exit animation, driven by animationState.
    const anim = node.animationState ?? 'idle'
    if (anim !== el.animState) {
      // Cancel any in-flight enter flip-to-idle so it can't resurrect a node that
      // is now exiting (or otherwise changed state).
      if (el.enterRafOuter != null) {
        cancelAnimationFrame(el.enterRafOuter)
        el.enterRafOuter = undefined
      }
      if (el.enterRafInner != null) {
        cancelAnimationFrame(el.enterRafInner)
        el.enterRafInner = undefined
      }
      // Leaving 'exiting' (e.g. undo restored the node) → cancel the pending
      // finalize so the just-restored node is not deleted out from under the user.
      if (anim !== 'exiting' && el.exitTimer != null) {
        clearTimeout(el.exitTimer)
        el.exitTimer = undefined
      }

      c.classList.toggle('is-entering', anim === 'entering')
      c.classList.toggle('is-exiting', anim === 'exiting')

      if (anim === 'entering') {
        // Flip to idle on the next frame so the transform transitions in.
        el.enterRafOuter = requestAnimationFrame(() => {
          el.enterRafInner = requestAnimationFrame(() => {
            el.enterRafOuter = undefined
            el.enterRafInner = undefined
            this.store.setNodeAnimationState(node.id, 'idle')
          })
        })
      }
      if (anim === 'exiting' && el.exitTimer == null) {
        // Finalize on a fixed timer rather than a transitionend: works even when
        // computed opacity never changes (deleting a node that is still entering),
        // and is cancellable above if the node is restored first.
        el.exitTimer = window.setTimeout(() => {
          el.exitTimer = undefined
          this.store.finalizeRemoveNode(node.id)
        }, EXIT_ANIM_MS)
      }
      el.animState = anim
    }
  }

  /** Apply coding-agent status chrome to a terminal node: state classes, the
   * accent color variable, and the animated runner sprite. */
  private syncAgentChrome(el: NodeElements, rec: TerminalAgentState | undefined): void {
    const c = el.container
    const agent = rec?.agent ?? null
    // Keep the controller's scanner in sync (defers internally — no sync set()).
    el.terminal?.setAgentPresent(!!agent)
    c.classList.toggle('has-agent', !!agent)
    const activity = agent && rec ? rec.activity : null
    c.classList.toggle('agent-idle', activity === 'idle')
    c.classList.toggle('agent-working', activity === 'working')
    c.classList.toggle('agent-waiting', activity === 'waiting')
    if (agent && rec) {
      const meta = AGENT_ACTIVITY_META[rec.activity]
      c.style.setProperty('--agent-color', meta.color)
      if (el.agentRunner) {
        const cls = `cnode-agent-runner runner-${meta.runner}`
        if (el.agentRunner.className !== cls) el.agentRunner.className = cls
      }
      if (el.agentLabel && el.agentLabel.textContent !== meta.label) {
        el.agentLabel.textContent = meta.label
      }
      if (el.agentBadge) {
        el.agentBadge.title = `${AGENT_DISPLAY_NAMES[agent]} — ${t(AGENT_ACTIVITY_LABEL[rec.activity])}`
      }
    } else {
      c.style.removeProperty('--agent-color')
    }
  }

  /** (Re)subscribe a file node to live content for `filePath`. No-op if the path
   * is unchanged; tears down the previous subscription when the path changes. */
  private syncFileWatch(el: NodeElements, filePath: string): void {
    if (el.watchedPath === filePath) return
    el.fileUnsub?.()
    el.fileUnsub = undefined
    el.watchedPath = filePath
    if (el.fileCodeEl) el.fileCodeEl.textContent = ''
    if (el.fileStatusEl) {
      el.fileStatusEl.textContent = t('filePreviewLoading')
      el.fileStatusEl.classList.remove('is-error', 'is-hidden')
    }
    if (!filePath || !this.hooks.files) return
    el.fileUnsub = this.hooks.files.watch(filePath, (data) => this.renderFilePreview(el, filePath, data))
  }

  /** Render a file-bridge update into a file node's preview / status line. */
  private renderFilePreview(el: NodeElements, filePath: string, data: FileContentData): void {
    const status = el.fileStatusEl
    if (data.error) {
      if (el.fileCodeEl) el.fileCodeEl.textContent = ''
      if (status) {
        status.textContent = t(
          data.error === 'missing'
            ? 'filePreviewMissing'
            : data.error === 'binary'
              ? 'filePreviewBinary'
              : 'filePreviewUnavailable',
        )
        status.classList.add('is-error')
        status.classList.remove('is-hidden')
      }
      return
    }
    if (el.fileCodeEl) {
      highlightInto(el.fileCodeEl, data.content ?? '', data.languageId, filePath)
    }
    if (status) {
      status.classList.remove('is-error')
      if (data.truncated) {
        status.textContent = t('filePreviewTruncated')
        status.classList.remove('is-hidden')
      } else {
        status.classList.add('is-hidden')
      }
    }
  }

  // ---- Browser -------------------------------------------------------------

  /** Push a new address-bar destination onto a browser node's history and load
   * it. Forward entries (if the user had gone back) are dropped, matching a
   * normal browser. */
  private browserNavigate(el: NodeElements, id: string, raw: string): void {
    const url = normalizeUrl(raw)
    if (!url) return
    const hist = el.browserHistory ?? (el.browserHistory = [])
    const idx = el.browserIndex ?? -1
    if (hist[idx] !== url) {
      hist.splice(idx + 1)
      hist.push(url)
      el.browserIndex = hist.length - 1
    }
    this.store.setNodeUrl(id, url)
  }

  /** Step the browser node's history cursor by `delta` (-1 back / +1 forward). */
  private browserGo(el: NodeElements, id: string, delta: number): void {
    const hist = el.browserHistory ?? []
    const idx = (el.browserIndex ?? -1) + delta
    if (idx < 0 || idx >= hist.length) return
    el.browserIndex = idx
    this.store.setNodeUrl(id, hist[idx])
  }

  /** Reflect a browser node's URL into its iframe, address bar, and nav buttons. */
  private syncBrowser(el: NodeElements, node: CanvasNodeState): void {
    const url = node.url ?? ''
    // (Re)load the iframe only when the URL actually changed — reconcile runs on
    // every store tick and re-assigning src would otherwise reload constantly.
    if (url !== el.loadedUrl) {
      el.loadedUrl = url
      const target = url ? normalizeUrl(url) : 'about:blank'
      // Load optimistically so embeddable sites appear with no added latency.
      if (el.iframe) el.iframe.src = target
      el.container.classList.toggle('browser-blank', !url)
      el.container.classList.remove('browser-blocked')
      // Flash the escape-hatch hint on every real navigation (covers the
      // undetectable frame-busting / bot-block cases that load then blank).
      if (url) this.flashBrowserHint(el)
      // In parallel, ask the host if the site allows framing; if not, swap the
      // (blank) frame for a clear notice. Guard against a newer navigation.
      if (url && this.hooks.onCheckEmbeddable) {
        el.embedCheckUrl = url
        this.hooks.onCheckEmbeddable(target).then((ok) => {
          if (el.embedCheckUrl !== url || el.loadedUrl !== url) return
          if (!ok && el.iframe) el.iframe.src = 'about:blank'
          el.container.classList.toggle('browser-blocked', !ok)
        })
      }
    }
    // Keep the address bar in sync unless the user is mid-edit.
    if (el.urlInput && document.activeElement !== el.urlInput && el.urlInput.value !== url) {
      el.urlInput.value = url
    }
    const hist = el.browserHistory ?? []
    const idx = el.browserIndex ?? -1
    if (el.browserBackBtn) el.browserBackBtn.disabled = idx <= 0
    if (el.browserForwardBtn) el.browserForwardBtn.disabled = idx >= hist.length - 1

    // Embedded-page zoom: scale the iframe and counter-size it (width/height =
    // 100% / zoom) so the page reflows to fill the viewport at the chosen zoom —
    // i.e. real browser zoom, not a clipped blow-up. transform-origin is set in
    // CSS (top-left).
    const zoom = node.browserZoom ?? 1
    if (el.iframe) {
      el.iframe.style.transform = zoom === 1 ? '' : `scale(${zoom})`
      el.iframe.style.width = `${100 / zoom}%`
      el.iframe.style.height = `${100 / zoom}%`
    }
    if (el.browserZoomLabel) el.browserZoomLabel.textContent = `${Math.round(zoom * 100)}%`
  }

  /** Step a browser node's embedded-page zoom by `delta`. */
  private browserZoomBy(id: string, delta: number): void {
    const current = this.store.getState().nodes[id]?.browserZoom ?? 1
    this.store.setNodeBrowserZoom(id, current + delta)
  }

  /** (Re)start the auto-fading "open externally" hint on a browser node. */
  private flashBrowserHint(el: NodeElements): void {
    const hint = el.browserHint
    if (!hint) return
    hint.classList.remove('is-visible')
    // Force a reflow so re-adding the class restarts the CSS fade animation.
    void hint.offsetWidth
    hint.classList.add('is-visible')
  }

  // ---- Regions -------------------------------------------------------------

  private reconcileRegions(s: CanvasData): void {
    const seen = new Set<string>()
    for (const region of Object.values(s.regions)) {
      seen.add(region.id)
      let el = this.regionEls.get(region.id)
      if (!el) {
        el = this.createRegionElement(region)
        this.regionEls.set(region.id, el)
        this.world.appendChild(el.container)
      }
      this.updateRegionElement(el, region, s)
    }
    for (const [id, el] of this.regionEls) {
      if (!seen.has(id)) {
        el.container.remove()
        this.regionEls.delete(id)
      }
    }
  }

  private createRegionElement(region: CanvasRegion): RegionElements {
    const container = document.createElement('div')
    container.className = 'cregion'
    container.setAttribute('data-region-id', region.id)
    container.style.position = 'absolute'

    const labelBar = document.createElement('div')
    labelBar.className = 'cregion-label'
    labelBar.setAttribute('data-grab', '')

    const labelText = document.createElement('span')
    labelText.className = 'cregion-label-text'
    labelBar.appendChild(labelText)

    // Inline rename on double-click.
    labelBar.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.beginRegionRename(region.id, labelText)
    })

    container.appendChild(labelBar)

    container.addEventListener('mousedown', (e) => this.onRegionMouseDown(e, region.id))
    container.addEventListener('mousemove', (e) => this.onRegionMouseMove(e, region.id))

    return { container, labelBar, labelText }
  }

  private onRegionMouseDown(e: MouseEvent, id: string): void {
    if (e.button !== 0) return
    if (effectiveToolOf(this.store, this.spaceHeld) === 'hand') return
    const region = this.store.getState().regions[id]
    if (!region) return

    // Selection.
    if (e.shiftKey) {
      e.stopPropagation()
      this.store.toggleRegionSelection(id)
      return
    }
    if (!this.store.getState().selectedRegionIds.has(id)) {
      this.store.selectRegions([id])
    }

    // Resize from the region border.
    const edge = this.regionEdgeAt(e, id)
    if (edge) {
      beginRegionResize(this.store, id, edge, e)
      return
    }
    // Otherwise drag (label bar or body).
    beginRegionDrag(this.store, id, e)
  }

  private onRegionMouseMove(e: MouseEvent, id: string): void {
    const el = this.regionEls.get(id)
    if (!el) return
    if (effectiveToolOf(this.store, this.spaceHeld) !== 'select') {
      el.container.style.cursor = ''
      return
    }
    const edge = this.regionEdgeAt(e, id)
    el.container.style.cursor = edge ? getCursorForEdge(edge) : ''
  }

  private regionEdgeAt(e: MouseEvent, id: string) {
    const el = this.regionEls.get(id)
    const region = this.store.getState().regions[id]
    if (!el || !region) return null
    const rect = el.container.getBoundingClientRect()
    const zoom = this.store.getState().zoomLevel
    const localX = (e.clientX - rect.left) / zoom
    const localY = (e.clientY - rect.top) / zoom
    return detectEdge(localX, localY, region.size.width, region.size.height, zoom)
  }

  private beginRegionRename(id: string, labelText: HTMLSpanElement): void {
    const region = this.store.getState().regions[id]
    if (!region) return
    const input = document.createElement('input')
    input.className = 'cregion-label-input'
    input.value = region.label
    labelText.replaceWith(input)
    input.focus()
    input.select()
    const commit = () => {
      const v = input.value.trim() || t('defaultRegion')
      this.store.renameRegion(id, v)
      input.replaceWith(labelText)
      labelText.textContent = v
    }
    input.addEventListener('blur', commit)
    // Only intercept Enter / Escape; leave clipboard & selection keys native
    // (a blanket stopPropagation breaks Cmd/Ctrl+A/C/V in webview inputs).
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        ev.stopPropagation()
        input.blur()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        input.value = region.label
        input.blur()
      }
    })
    input.addEventListener('mousedown', (ev) => ev.stopPropagation())
  }

  private updateRegionElement(el: RegionElements, region: CanvasRegion, s: CanvasData): void {
    const c = el.container
    c.style.left = `${region.origin.x}px`
    c.style.top = `${region.origin.y}px`
    c.style.width = `${region.size.width}px`
    c.style.height = `${region.size.height}px`
    c.style.zIndex = String(region.zOrder)
    c.style.setProperty('--region-color', region.color)
    if (document.activeElement !== el.labelText) {
      el.labelText.textContent = region.label
    }

    const selected = s.selectedRegionIds.has(region.id)
    const dropTarget = s.dropTargetRegionId === region.id
    c.classList.toggle('is-selected', selected)
    c.classList.toggle('is-drop-target', dropTarget)
  }

  /** Open the launcher dropdown for a terminal node; picking an item runs that
   * command in this terminal. Reads launchers from settings on each open. */
  private openLauncherMenu(anchor: HTMLElement, ctrl: TerminalController): void {
    this.closeLauncherMenu()
    const items = [
      ...PRESET_LAUNCHERS,
      ...settings.customLaunchersGlobal,
      ...settings.customLaunchersWorkspace,
    ]
    const menu = document.createElement('div')
    menu.className = 'context-menu'
    for (const l of items) {
      const row = document.createElement('button')
      row.className = 'context-menu-item'
      row.textContent = l.label
      row.title = l.command
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        ctrl.runCommand(l.command)
        this.closeLauncherMenu()
      })
      menu.appendChild(row)
    }
    document.body.appendChild(menu)

    // Anchor below the button, right-aligned, clamped to the viewport.
    const r = anchor.getBoundingClientRect()
    const left = Math.max(4, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))
    const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 4)
    menu.style.left = `${left}px`
    menu.style.top = `${Math.max(4, top)}px`
    this.launcherMenu = menu

    // Defer so the opening click doesn't immediately close it.
    setTimeout(() => {
      window.addEventListener('mousedown', this.onLauncherOutside, true)
      window.addEventListener('keydown', this.onLauncherKey, true)
    }, 0)
  }

  private onLauncherOutside = (e: MouseEvent): void => {
    if (this.launcherMenu && !this.launcherMenu.contains(e.target as Node)) this.closeLauncherMenu()
  }

  private onLauncherKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeLauncherMenu()
  }

  private closeLauncherMenu(): void {
    if (!this.launcherMenu) return
    window.removeEventListener('mousedown', this.onLauncherOutside, true)
    window.removeEventListener('keydown', this.onLauncherKey, true)
    this.launcherMenu.remove()
    this.launcherMenu = null
  }

  destroy(): void {
    this.closeLauncherMenu()
    this.unsubscribe()
    for (const el of this.nodeEls.values()) {
      this.clearNodeTimers(el)
      el.fileUnsub?.()
      el.terminal?.dispose()
      el.container.remove()
    }
    for (const el of this.regionEls.values()) el.container.remove()
    this.nodeEls.clear()
    this.regionEls.clear()
  }
}
