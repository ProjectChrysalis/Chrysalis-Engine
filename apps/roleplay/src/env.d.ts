/**
 * What the engine's builder (src/builder) gives app code: `import.meta.env`
 * carries the .env VITE_* values plus the mode flags, and `import.meta.hot` is
 * the dev runtime's HMR context (accept / dispose / prune / invalidate / on).
 * Plain CSS is a build input.
 */
declare module "*.css";

interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMetaHotContext {
  accept(cb?: (mod: unknown) => void): void;
  accept(deps: string | string[], cb: (mods: unknown[]) => void): void;
  dispose(cb: (data: Record<string, unknown>) => void): void;
  prune(cb: (data: Record<string, unknown>) => void): void;
  invalidate(message?: string): void;
  on(event: string, cb: (payload: unknown) => void): void;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: ImportMetaHotContext;
}
