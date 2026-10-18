import type { Stats } from "node:fs";

export const INDEX_DIR: string;
export function signature(st: Stats): string;

type Condition = unknown | unknown[] | { contains?: string; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown; exists?: boolean; not?: Condition };
type Sort = string | [string, "asc" | "desc"] | [string, "asc" | "desc"][];
export type QueryRow = { path: string; keys: string[]; data: Record<string, unknown>; error?: string };

export function query(
  root: string,
  spec: { files: string; fields: Record<string, string> },
  options?: { where?: Record<string, Condition>; sort?: Sort; offset?: number; limit?: number },
  track?: { dir(dir: string): void; file(full: string): void },
): { rows: QueryRow[]; total: number };
export function lines(full: string, from?: number, to?: number): { lines: string[]; from: number; total: number; version: string | null };
export function splice(full: string, from: number, replacement: string[]): { total: number; version: string };
