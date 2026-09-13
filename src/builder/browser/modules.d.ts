// Untyped modules the builder's browser bundles import.
declare module "@babel/standalone" {
  export function transform(code: string, options: Record<string, unknown>): { code?: string | null };
}
declare module "react-refresh/babel" {
  const plugin: unknown;
  export default plugin;
}
declare module "react-refresh/runtime" {
  const runtime: {
    injectIntoGlobalHook(win: Window): void;
    register(type: unknown, id: string): void;
    createSignatureFunctionForTransform(): unknown;
    isLikelyComponentType(value: unknown): boolean;
    performReactRefresh(): unknown;
  };
  export default runtime;
}
// tailwindcss sheets, bundled as text (esbuild loader ".css": "text")
declare module "*.css" {
  const text: string;
  export default text;
}
