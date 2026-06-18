// =============================================================================
// Tabler icon SVGs (https://tabler.io/icons), bundled as raw markup strings by
// esbuild's `text` loader and injected via innerHTML. All icons use
// stroke="currentColor", so they inherit the surrounding text color; size is
// controlled per-context in canvas.css (e.g. `.toolbar-btn svg`).
// =============================================================================

import pointer from '@tabler/icons/outline/pointer.svg'
import handStop from '@tabler/icons/outline/hand-stop.svg'
import note from '@tabler/icons/outline/note.svg'
import terminal from '@tabler/icons/outline/terminal-2.svg'
import filePlus from '@tabler/icons/outline/file-plus.svg'
import fileImport from '@tabler/icons/outline/file-import.svg'
import zoomOut from '@tabler/icons/outline/zoom-out.svg'
import zoomIn from '@tabler/icons/outline/zoom-in.svg'
import maximize from '@tabler/icons/outline/maximize.svg'
import restore from '@tabler/icons/outline/restore.svg'
import layoutGrid from '@tabler/icons/outline/layout-grid.svg'
import boxMultiple from '@tabler/icons/outline/box-multiple.svg'
import arrowBackUp from '@tabler/icons/outline/arrow-back-up.svg'
import arrowForwardUp from '@tabler/icons/outline/arrow-forward-up.svg'
import map from '@tabler/icons/outline/map.svg'
import pin from '@tabler/icons/outline/pin.svg'
import arrowsMaximize from '@tabler/icons/outline/arrows-maximize.svg'
import arrowsMinimize from '@tabler/icons/outline/arrows-minimize.svg'
import x from '@tabler/icons/outline/x.svg'
import file from '@tabler/icons/outline/file.svg'
import gripVertical from '@tabler/icons/outline/grip-vertical.svg'
import sparkles from '@tabler/icons/outline/sparkles.svg'
import brandOpenai from '@tabler/icons/outline/brand-openai.svg'
import world from '@tabler/icons/outline/world.svg'
import arrowLeft from '@tabler/icons/outline/arrow-left.svg'
import arrowRight from '@tabler/icons/outline/arrow-right.svg'
import reload from '@tabler/icons/outline/reload.svg'
import externalLink from '@tabler/icons/outline/external-link.svg'
import bug from '@tabler/icons/outline/bug.svg'
import settings from '@tabler/icons/outline/settings.svg'
import plus from '@tabler/icons/outline/plus.svg'
import trash from '@tabler/icons/outline/trash.svg'
import rocket from '@tabler/icons/outline/rocket.svg'

// Split-layout glyphs drawn inline (2 columns / 3 columns / 2×2) so they read
// unambiguously and stay distinct from the auto-layout grid icon. Tabler style:
// 24×24, no fill, stroke = currentColor — sized by `.toolbar-btn svg` in CSS.
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
  ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
const layoutSplit2 =
  `${SVG_OPEN}<rect x="4" y="4" width="16" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`
const layoutSplit3 =
  `${SVG_OPEN}<rect x="4" y="4" width="16" height="16" rx="2"/>` +
  `<line x1="9.33" y1="4" x2="9.33" y2="20"/><line x1="14.67" y1="4" x2="14.67" y2="20"/></svg>`
const layoutGrid2x2 =
  `${SVG_OPEN}<rect x="4" y="4" width="16" height="16" rx="2"/>` +
  `<line x1="12" y1="4" x2="12" y2="20"/><line x1="4" y1="12" x2="20" y2="12"/></svg>`

export const icons = {
  // Toolbar — tools
  pointer,
  handStop,
  // Toolbar — add
  note,
  terminal,
  world,
  filePlus,
  fileImport,
  // Browser node chrome
  arrowLeft,
  arrowRight,
  reload,
  externalLink,
  bug,
  // Toolbar — agent launchers
  sparkles,
  brandOpenai,
  settings,
  // Launcher settings dialog
  plus,
  trash,
  // Terminal node launcher menu
  rocket,
  // Toolbar — view
  zoomOut,
  zoomIn,
  maximize,
  restore,
  // Toolbar — arrange / history / minimap
  layoutGrid,
  layoutSplit2,
  layoutSplit3,
  layoutGrid2x2,
  boxMultiple,
  arrowBackUp,
  arrowForwardUp,
  map,
  // Node card actions
  pin,
  arrowsMaximize,
  arrowsMinimize,
  x,
  file,
  // Minimap move handle
  gripVertical,
} as const
