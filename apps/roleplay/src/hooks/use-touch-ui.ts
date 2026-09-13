
import { useSyncExternalStore } from 'react'

// Touch UI when the primary pointer is coarse OR the device can't hover.
// Subscribed LIVE, not snapshotted at load: DevTools device emulation flipped
// on after page load changes these media queries, and the message toolbar
// must switch to the always-visible touch bar with it.
const mq = typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse), (hover: none)') : null

// A fine pointer (mouse, trackpad, stylus) means a hardware keyboard is
// around too: Enter-to-send stays on for hybrids whose primary input reports
// as touch, while a phone or tablet with no fine pointer keeps Enter as a
// newline from the on-screen keyboard. Both queries are only a guess about
// the device; the real pointer takes the last word (useLastPointer below).
const fineMq = typeof window !== 'undefined' ? window.matchMedia('(any-pointer: fine)') : null

function subscribeFine(onChange: () => void) {
  fineMq?.addEventListener('change', onChange)
  return () => fineMq?.removeEventListener('change', onChange)
}

export function useFinePointer(): boolean {
  return useSyncExternalStore(subscribeFine, () => fineMq?.matches ?? false, () => false)
}

// The last pointer that touched the page. A finger is the only trustworthy
// "this is a phone" signal: some Android builds advertise a virtual fine
// pointer (a stylus, or an OEM mouse device), and the media queries above then
// report a desktop on a touchscreen-only phone. Real touch input is reported
// either way, so it overrides them.
type PointerKind = 'touch' | 'fine'
let lastPointer: PointerKind | null = null
const pointerSubs = new Set<() => void>()

function setPointer(next: PointerKind) {
  if (next === lastPointer) return
  lastPointer = next
  for (const onChange of pointerSubs) onChange()
}

function onPointerDown(e: PointerEvent) {
  if (e.pointerType === 'touch') setPointer('touch')
  else if (e.pointerType === 'mouse') setPointer('fine')
  // A pen is left alone: it says nothing about whether a hardware Enter key
  // is around, so the previous verdict stands.
}

function onTouchStart() { setPointer('touch') }

if (typeof window !== 'undefined') {
  // Capture phase: a handler that stops propagation must not hide the device.
  // touchstart rides along so a build that mislabels finger input as mouse in
  // pointer events still reports a finger.
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
}

function subscribePointer(onChange: () => void) {
  pointerSubs.add(onChange)
  return () => { pointerSubs.delete(onChange) }
}

/** 'touch' after the last finger tap, 'fine' after the last mouse click, null
 *  before any pointer input. */
export function useLastPointer(): PointerKind | null {
  return useSyncExternalStore(subscribePointer, () => lastPointer, () => null)
}

function subscribe(onChange: () => void) {
  mq?.addEventListener('change', onChange)
  return () => mq?.removeEventListener('change', onChange)
}

export function useTouchUi(): boolean {
  return useSyncExternalStore(subscribe, () => mq?.matches ?? false, () => false)
}
