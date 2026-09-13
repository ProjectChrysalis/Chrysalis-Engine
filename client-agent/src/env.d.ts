/** client-agent is built by the repo's build script (scripts/build-frontends.ts),
 *  which bundles the engine's own pipeline; only CSS enters the module graph. */
declare module "*.css";
