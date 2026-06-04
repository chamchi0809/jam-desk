// =============================================================================
// wheelIntent — classify a wheel event as a physical mouse wheel vs a trackpad
// gesture. The canvas maps a physical mouse wheel → zoom (Miro-style) while
// keeping a trackpad two-finger scroll → pan, and both arrive as `wheel`
// events, so we tell them apart from the deltas alone. Ported from Cate.
// =============================================================================

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  // Chromium-only, non-standard: physical wheel notches arrive as multiples of
  // 120. Undefined on engines that don't implement it.
  wheelDeltaY?: number
}

/**
 * True when a wheel event almost certainly came from a physical mouse wheel
 * (not a trackpad two-finger scroll or pinch). In Chromium-based webviews,
 * `wheelDeltaY` reports physical notches as nonzero vertical-only multiples of
 * 120; trackpads emit pixel-precise, non-120-aligned deltas usually carrying a
 * small horizontal component. A trackpad pinch carries `ctrlKey`.
 */
export function isMouseWheel(e: WheelLike): boolean {
  if (e.ctrlKey) return false
  const wd = e.wheelDeltaY
  if (typeof wd === 'number' && wd !== 0) {
    return e.deltaX === 0 && Math.abs(wd) % 120 === 0
  }
  return e.deltaMode !== 0
}
