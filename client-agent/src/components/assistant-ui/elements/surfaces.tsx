"use client";

/** Shared surface tokens: the few class strings more than one element needs
 *  to agree on. Everything else styles at its own call site. */

export const paper = "bg-background border border-border/60 dark:bg-popover";

export const mono = "font-mono text-[11px] tracking-tight";

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";
