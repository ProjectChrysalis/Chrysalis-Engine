declare module "diff3" {
  type Block<T> = { ok: T[]; conflict?: undefined } | { ok?: undefined; conflict: { a: T[]; aIndex: number; o: T[]; oIndex: number; b: T[]; bIndex: number } };
  /** Merge `a` and `b`, both derived from `o`, into ok and conflict blocks. */
  export default function diff3Merge<T>(a: T[], o: T[], b: T[]): Block<T>[];
}
