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

export const icons = {
  // Toolbar — tools
  pointer,
  handStop,
  // Toolbar — add
  note,
  terminal,
  filePlus,
  fileImport,
  // Toolbar — view
  zoomOut,
  zoomIn,
  maximize,
  restore,
  // Toolbar — arrange / history / minimap
  layoutGrid,
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
