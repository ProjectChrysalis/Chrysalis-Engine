import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { tr } from "@/i18n";
import { TooltipIconButton } from "./tooltip-icon-button";

export function VirtualThread({ Message, footer }: { Message: ComponentType; footer: ReactNode }) {
  const previousIds = useRef<readonly string[]>([]);
  const ids = useAuiState((s) => {
    const previous = previousIds.current;
    if (previous.length === s.thread.messages.length && previous.every((id, i) => id === s.thread.messages[i]?.id)) return previous;
    previousIds.current = s.thread.messages.map((m) => m.id);
    return previousIds.current;
  });
  const running = useAuiState((s) => s.thread.isRunning);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const components = useMemo(() => ({ Message }), [Message]);
  const virtualizer = useVirtualizer({
    count: ids.length,
    estimateSize: () => 240,
    getItemKey: (i) => ids[i] ?? i,
    getScrollElement: () => viewport.current,
    overscan: 5,
    scrollToFn: (offset, _options, instance) => {
      const el = instance.scrollElement;
      if (!el) return;
      const bottom = el.scrollHeight - el.clientHeight;
      // Measurement corrections must not pull a streaming reply off the bottom.
      if (following.current && bottom - el.scrollTop <= 4 && offset < bottom) return;
      el.scrollTo(0, offset);
    },
  });
  const jump = useCallback(() => {
    following.current = true;
    if (ids.length) virtualizer.scrollToIndex(ids.length - 1, { align: "end" });
    requestAnimationFrame(() => {
      if (viewport.current && following.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    });
  }, [ids.length, virtualizer]);

  useEffect(() => {
    const el = viewport.current;
    const body = content.current;
    if (!el || !body) return;
    let top = el.scrollTop, height = el.scrollHeight, client = el.clientHeight;
    const scroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
      if (bottom) following.current = true;
      else if (el.scrollTop < top && el.scrollHeight === height && Math.abs(client - el.clientHeight) <= 1) following.current = false;
      top = el.scrollTop; height = el.scrollHeight; client = el.clientHeight;
      setAtBottom(bottom);
    };
    const wheel = (e: WheelEvent) => { if (e.deltaY < 0) following.current = false; };
    const touch = () => { following.current = false; };
    const resize = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
    });
    resize.observe(body);
    resize.observe(el);
    el.addEventListener("scroll", scroll, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchmove", touch, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener("scroll", scroll);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchmove", touch);
    };
  }, []);

  const initialJump = useRef(false);
  const wasRunning = useRef(false);
  useLayoutEffect(() => {
    if ((!initialJump.current && ids.length) || (running && !wasRunning.current)) {
      initialJump.current = true;
      jump();
    }
    wasRunning.current = running;
  }, [ids.length, running, jump]);

  const items = virtualizer.getVirtualItems();
  return <>
    <div ref={viewport} data-slot="aui_thread-viewport" className="flex min-h-0 flex-1 overflow-y-auto overscroll-y-contain ps-[max(0.75rem,env(safe-area-inset-left))] pe-[max(0.75rem,env(safe-area-inset-right))] pt-5 sm:px-5">
      <div ref={content} className="mx-auto w-full max-w-(--thread-max-width) shrink-0" style={{ paddingTop: items[0]?.start ?? 0, paddingBottom: Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)) }}>
        {items.map((item) => {
          const id = ids[item.index];
          if (id === undefined) return null;
          return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="pb-5">
            <ThreadPrimitive.Unstable_MessageById messageId={id} components={components} />
          </div>;
        })}
      </div>
    </div>
    <div className="relative mx-auto flex w-full max-w-(--thread-max-width) shrink-0 flex-col gap-2 px-3 pt-1 pb-3 sm:px-5 sm:pb-4">
      {!atBottom && <TooltipIconButton tooltip={tr("Scroll to bottom")} variant="outline" onClick={jump} className="bg-card text-muted-foreground absolute -top-11 z-10 size-8 self-center rounded-full shadow-composer"><ArrowDown /></TooltipIconButton>}
      {footer}
    </div>
  </>;
}
