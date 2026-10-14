# Apps, builds, and service programs

## Web apps

`app_create` scaffolds a React + Tailwind web app by default. Source lives under `apps/<id>/`. `package.json` lists real dependencies; run `app_deps` after changing them. Packages install engine-side through the engine's Bun runtime with lifecycle scripts disabled. The browser shell does not run npm.

The browser builder supports TS/TSX/JSX, ordinary JavaScript, CSS and CSS modules, JSON, imported assets, `?raw`, `?url`, `?inline`, `?worker`, `import.meta.glob`, `import.meta.env` for `.env` `VITE_*` values, tsconfig paths, and the `@` alias for `src`. `public/` is copied as-is. Tailwind v4 is built in; start app CSS with `@import "tailwindcss";`. Bundler config and compiler plugins do not execute, so formats requiring those plugins are unsupported.

Saving source updates an open app through hot refresh. React component state usually survives; module state does not. An app with no open page builds when next opened. Run `app_check` after source or dependency edits; inspect the real result instead of assuming a successful build. Use `app_rebuild` to force a fresh build and `app_console` to read messages captured from an open page. `dist/.chrysalis-build.json` contains the last build report.

## Frame and engine bridge

Web app pages run in opaque-origin sandboxed frames, without server cookies or direct network access. The engine bridge supplies app `fetch`, sockets, and engine-backed storage. Derive the installed app ID from the page rather than hardcoding the source repository's name:

```js
const appId = decodeURIComponent(location.pathname.split("/").filter(Boolean)[2]);
const response = await fetch(`/v1/apps/${appId}/notes`);
if (!response.ok) throw new Error(`Notes request failed (${response.status})`);
const notes = await response.json();
```

Allowed engine routes include the app's own `/v1/apps/<id>/*`, models, images, audio, embeddings, assets, and read-only connection/provider/plugin catalogs. Agent, shell, settings, admin, and MCP management routes are outside the app contract. Requests are checked again server-side. Do not widen the bridge to implement an app feature.

Remote images use the app's `/img?url=...` route with an eligible plugin's declared network hosts. Other remote media needs a plugin route. Direct remote scripts, styles, images, fetches, and sockets do not bypass the frame policy. Worker code remains under the same network restrictions.

## Service apps

A manifest with `kind: "service"` runs a program outside the plugin sandbox after an administrator approves it. Its `service` object declares `command`, `cwd`, optional `setup`/`setupOn`, `env`, and `reloadOn`/`patchOn`/`restartOn`. Changing launch configuration can require approval again. Explain the actual change; do not edit it merely to bypass approval.

The engine runs the program on loopback and gives its owner a front port. In command and env values, `{port}` is its assigned port, `{port2}` is a second free port, `{data}` is its data folder, and `{models}`/`{models_key}` supply OpenAI-compatible model access. `PORT` defaults to `{port}` unless explicitly configured. Model ID `default` uses the account default. Command `bun` uses the engine's own runtime, including in packaged installs.

`setup` runs before first start and again when a `setupOn` file changes. `reloadOn` swaps changed styles and reloads other pages; `restartOn` restarts the program. `patchOn` can replace function bodies in scripts served directly from disk; changes outside functions require reload. For an app with its own build pipeline, run its development server so its native hot updates reach the page.

Use `app_request` to call the running program's API, with a cookie jar kept per app. Read its `AGENTS.md` and skills for real routes. `reload: true` refreshes open pages when the API change would otherwise remain invisible. `app_inspect` cannot inspect a service app's cross-origin page. Do not invent an API or try to start a server inside the browser command shell.
