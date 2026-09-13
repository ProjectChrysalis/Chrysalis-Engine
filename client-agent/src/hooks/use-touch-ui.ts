import { useSyncExternalStore } from "react";

// Narrow layouts and touch devices keep Enter available for multiline input.
// Subscribed LIVE, not snapshotted at load: DevTools device emulation flipped
// on after page load changes these media queries, and the composer has to
// switch its Enter behavior with them.
const mq =
  typeof window !== "undefined"
    ? window.matchMedia("(max-width: 767px), (pointer: coarse), (hover: none)")
    : null;

// A fine pointer (mouse, trackpad, stylus) means a hardware keyboard is
// around: a narrow desktop pane is not a phone, and Enter must still send.
// Both queries are only a guess about the device; the real pointer takes the
// last word (lastPointer below).
const fineMq = typeof window !== "undefined" ? window.matchMedia("(any-pointer: fine)") : null;

// The last pointer that touched the page. A finger is the only trustworthy
// "this is a phone" signal: some Android builds advertise a virtual fine
// pointer (a stylus, or an OEM mouse device), and the media queries above then
// report a desktop on a touchscreen-only phone. Real touch input is reported
// either way, so it overrides them.
type PointerKind = "touch" | "fine";
let lastPointer: PointerKind | null = null;
const pointerSubs = new Set<() => void>();

function setPointer(next: PointerKind) {
  if (next === lastPointer) return;
  lastPointer = next;
  for (const onChange of pointerSubs) onChange();
}

if (typeof window !== "undefined") {
  // Capture phase: a handler that stops propagation must not hide the device.
  // touchstart rides along so a build that mislabels finger input as mouse in
  // pointer events still reports a finger. A pen says nothing about whether a
  // hardware Enter key is around, so it leaves the verdict where it was.
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") setPointer("touch");
      else if (e.pointerType === "mouse") setPointer("fine");
    },
    { capture: true, passive: true },
  );
  window.addEventListener("touchstart", () => setPointer("touch"), { capture: true, passive: true });
}

function subscribe(onChange: () => void) {
  mq?.addEventListener("change", onChange);
  fineMq?.addEventListener("change", onChange);
  pointerSubs.add(onChange);
  return () => {
    mq?.removeEventListener("change", onChange);
    fineMq?.removeEventListener("change", onChange);
    pointerSubs.delete(onChange);
  };
}

const enterSendsNow = () =>
  lastPointer !== "touch" && (!(mq?.matches ?? false) || (fineMq?.matches ?? false));

/** Enter sends (Shift+Enter is a newline) where a hardware keyboard is around;
 *  on a phone Enter is a newline and the send button sends. */
export function useEnterSends(): boolean {
  return useSyncExternalStore(subscribe, enterSendsNow, () => true);
}
