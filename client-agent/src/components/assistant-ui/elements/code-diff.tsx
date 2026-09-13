"use client";

import { useState, type ComponentProps } from "react";
import { FilePlus, FileText, Minus, Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, mono, paper } from "./surfaces";

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line in the file before the edit; absent on added lines. */
  oldLine?: number;
  /** 1-based line in the file after the edit; absent on removed lines. */
  newLine?: number;
}

export interface DiffHunk {
  /** First line this hunk covers in the file after the edit. */
  at: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Every line the file has is an addition — the write created it. */
  created: boolean;
  /** The engine cut the patch short (very large write). */
  truncated: boolean;
}

/** Rows shown before the card folds the rest behind a toggle. Two screenfuls
 *  of diff is already more than a transcript wants to spend on one edit. */
const FOLD_AT = 24;

/** Unified diff text → hunks carrying real file line numbers.
 *  Everything jsdiff writes around the hunks (`---`/`+++`, the no-newline
 *  marker) is scaffolding, not content, and never reaches a row. */
export function parseDiff(diff: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let contextOrRemoved = 0;
  let truncated = false;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunkAt = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkAt) {
      oldLine = Number(hunkAt[1]);
      newLine = Number(hunkAt[2]);
      current = { at: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("… ")) {
      truncated = true;
      continue;
    }
    if (!current) continue; // preamble before the first hunk
    if (line.startsWith("+")) {
      additions++;
      current.lines.push({ kind: "added", text: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      deletions++;
      contextOrRemoved++;
      current.lines.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++ });
    } else {
      contextOrRemoved++;
      current.lines.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { hunks, additions, deletions, created: additions > 0 && contextOrRemoved === 0, truncated };
}

const GUTTER: Record<DiffKind, string> = {
  context: " ",
  added: "+",
  removed: "−",
};

/** `dir/` and `name` render at different weights, so the eye lands on the
 *  file rather than the path it sits under. */
function splitPath(filename: string): { dir: string; name: string } {
  const cut = filename.lastIndexOf("/");
  return cut < 0
    ? { dir: "", name: filename }
    : { dir: filename.slice(0, cut + 1), name: filename.slice(cut + 1) };
}

function DiffRow({ line, numbers }: { line: DiffLine; numbers: boolean }) {
  return (
    <div
      className={cn(
        "flex px-3 leading-relaxed whitespace-pre",
        line.kind === "context" && "text-foreground/55",
        line.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        line.kind === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300",
      )}
    >
      {numbers && (
        <span className="mr-3 shrink-0 select-none text-right tabular-nums text-foreground/25">
          <span className="inline-block w-9">{line.oldLine ?? ""}</span>
          <span className="ml-1 inline-block w-9">{line.newLine ?? ""}</span>
        </span>
      )}
      <span className="w-3 shrink-0 select-none opacity-70">{GUTTER[line.kind]}</span>
      <span>{line.text}</span>
    </div>
  );
}

export function CodeDiff({
  filename,
  diff,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "filename" | "diff"> & {
  filename: string;
  diff: ParsedDiff;
}) {
  const [expanded, setExpanded] = useState(false);
  const { dir, name } = splitPath(filename);
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  const folded = !expanded && total > FOLD_AT;
  // A created file has no "before" side to number against, and every row is
  // an addition — the number columns would be a column of blanks and a
  // column counting from 1.
  const numbers = !diff.created;

  let budget = folded ? FOLD_AT : Infinity;
  const Icon = diff.created ? FilePlus : FileText;

  return (
    <div
      data-slot="code-diff"
      className={cn(paper, "w-full overflow-hidden rounded-xl font-mono text-xs", className)}
      {...props}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 truncate" title={filename}>
          <span className="text-muted-foreground">{dir}</span>
          <span className="text-foreground/90">{name}</span>
        </span>
        {diff.created && (
          <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
            new
          </span>
        )}
        <span className={cn(mono, "ml-auto flex shrink-0 items-center gap-1.5 tabular-nums")}>
          {diff.additions > 0 && (
            <span className="flex items-center text-emerald-600 dark:text-emerald-400">
              <Plus className="size-3" aria-hidden="true" />
              {diff.additions}
            </span>
          )}
          {diff.deletions > 0 && (
            <span className="flex items-center text-red-600 dark:text-red-400">
              <Minus className="size-3" aria-hidden="true" />
              {diff.deletions}
            </span>
          )}
        </span>
      </div>
      <div className={cn(codeScroll, "max-h-80 overflow-y-auto overscroll-contain")} tabIndex={0} role="region" aria-label="File changes">
        <div className={cn(codeSurface, "border-t border-border/60 py-1")}>
          {diff.hunks.map((hunk, h) => {
            if (budget <= 0) return null;
            const shown = hunk.lines.slice(0, budget);
            budget -= shown.length;
            return (
              <div key={hunk.at}>
                {h > 0 && (
                  <div className="px-3 py-0.5 text-foreground/30 select-none">⋯</div>
                )}
                {shown.map((line, i) => (
                  <DiffRow key={`${hunk.at}-${i}`} line={line} numbers={numbers} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {(folded || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full border-t border-border/60 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
        >
          {folded ? `Show all ${total} lines` : "Show less"}
        </button>
      )}
      {diff.truncated && (
        <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          Diff truncated — the write was larger than the card shows.
        </div>
      )}
    </div>
  );
}
