
import type React from 'react'

/**
 * Default `initialFocus` for every popup surface (dialog / sheet / popover):
 * NEVER land focus in a text field when the window opens — on mobile that
 * slams the virtual keyboard over pickers, search palettes and editors
 * (Base UI's default is "first tabbable element", which is usually the
 * search box). Focus the first actionable control (close button, menu item)
 * or the popup surface itself instead.
 *
 * Deliberate single-purpose entry fields (folder-name dialog, rename boxes,
 * find bar) keep their explicit React `autoFocus` — it commits BEFORE this
 * callback runs, so the already-focused element is honored.
 */
export function popupInitialFocus(
  popupRef: React.RefObject<HTMLElement | null>,
): () => HTMLElement | boolean {
  return () => {
    const root = popupRef.current
    if (!root) return true
    const active = document.activeElement
    if (active instanceof HTMLElement && root.contains(active) && active !== root) return active
    return root.querySelector<HTMLElement>('button, [role="menuitem"], [href]') ?? root
  }
}
