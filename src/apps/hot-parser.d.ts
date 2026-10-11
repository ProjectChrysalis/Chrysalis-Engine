// The parser the builder's browser bundles ship, as the engine itself calls it.
declare module "@babel/standalone" {
  export const packages: {
    parser: { parse(code: string, options: Record<string, unknown>): { program: unknown } };
  };
}
