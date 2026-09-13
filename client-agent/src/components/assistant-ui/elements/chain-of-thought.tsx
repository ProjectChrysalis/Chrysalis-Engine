"use client";

import { useEffect, useRef, useState, type FC, type PropsWithChildren } from "react";
import { Brain, CaretDown, CircleNotch, Wrench } from "@phosphor-icons/react";
import { useAuiState } from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { visibleParts } from "@/runs";
import { useAgent } from "@/store";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;

const formatSeconds = (ms: number) => {
  const s = ms / 1000;
  if (s < 1) return "<1s";
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

/** Measured thinking time of the reasoning parts at these indices, from the
 *  engine's per-phase timings; null while no phase has reported one. */
function useThinkingMs(indices: readonly number[]): number | null {
  const messageId = useAuiState((s) => s.message.id);
  return useAgent((s) => {
    const msg = s.msgs.find((m) => m.id === messageId);
    if (!msg) return null;
    const parts = visibleParts(msg);
    let total = 0;
    let measured = false;
    for (const i of indices) {
      const p = parts[i];
      if (p?.kind === "think" && p.ms !== undefined) {
        total += p.ms;
        measured = true;
      }
    }
    return measured ? total : null;
  });
}

/**
 * A run of reasoning and tool calls between two pieces of the answer, as one
 * step list in the order it happened. A list that appears while the model is
 * working opens so the reader watches it happen, and stays open when that
 * stretch ends: folding it then would pull the text out from under someone
 * reading it. Lists loaded from history start folded to their summary line.
 */
export const ChainOfThought: FC<
  PropsWithChildren<{ indices: readonly number[]; running: boolean }>
> = ({ indices, running, children }) => {
  const [open, setOpen] = useState(running);
  const toolCount = useAuiState((s) =>
    indices.reduce((n, i) => n + (s.message.parts[i]?.type === "tool-call" ? 1 : 0), 0),
  );
  const thinkingMs = useThinkingMs(indices);

  const summary = [
    running ? "Working" : thinkingMs !== null ? `Thought for ${formatSeconds(thinkingMs)}` : toolCount ? "" : "Thought",
    toolCount ? `${toolCount} tool ${toolCount === 1 ? "call" : "calls"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = running ? CircleNotch : toolCount ? Wrench : Brain;

  return (
    <Collapsible
      data-slot="chain-of-thought"
      open={open}
      onOpenChange={setOpen}
      className="group/cot my-1 w-full"
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
    >
      <CollapsibleTrigger
        className="group/trigger text-muted-foreground hover:text-foreground flex max-w-full items-center gap-2 py-1.5 text-sm transition-colors"
      >
        <Icon
          aria-hidden
          className={cn("size-4 shrink-0", running && "animate-spin [animation-duration:0.8s]")}
        />
        <span className={cn("truncate leading-none", running && "shimmer motion-reduce:animate-none")}>
          {summary}
        </span>
        <CaretDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 -rotate-90 transition-transform duration-(--animation-duration) motion-reduce:transition-none",
            "group-data-panel-open/trigger:rotate-0",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden",
          "data-open:animate-collapsible-down data-closed:animate-collapsible-up data-closed:fill-mode-forwards",
          "[--tw-duration:var(--animation-duration)] motion-reduce:animate-none",
        )}
      >
        <div className="border-border/70 ms-2 flex flex-col gap-1 border-s ps-4 pt-0.5 pb-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/**
 * One reasoning phase inside the step list. The text shows in full up to a
 * bounded height and scrolls past it; while the phase streams, that box keeps
 * its newest line in view unless the reader scrolls up inside it.
 */
export const ReasoningStep: FC<{ running: boolean }> = ({ running }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastTop = scrollEl.scrollTop;
    let lastHeight = scrollEl.scrollHeight;
    const atBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= 1;
    const pin = () => {
      if (pinned) scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // a pin's own scroll event can land after new text grew the box; only an
    // upward move at an unchanged height is the reader scrolling
    const onScroll = () => {
      if (atBottom()) pinned = true;
      else if (scrollEl.scrollTop < lastTop && scrollEl.scrollHeight === lastHeight) pinned = false;
      lastTop = scrollEl.scrollTop;
      lastHeight = scrollEl.scrollHeight;
    };
    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [running]);

  return (
    <div className="flex gap-2 py-1">
      <Brain aria-hidden className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Reasoning"
        aria-busy={running}
        className="text-muted-foreground max-h-72 min-w-0 flex-1 overflow-y-auto overscroll-contain text-sm leading-relaxed"
      >
        <div ref={contentRef}>
          <MarkdownText />
        </div>
      </div>
    </div>
  );
};
