# What Chrysalis does

Chrysalis Engine is one Bun server plus a browser shell: launcher, app tabs, settings, and a built-in coding agent. Apps are installed separately from the Store, a git repository, or an app backup. The roleplay studio is an app, not behavior built into the engine.

Each account has its own workspace, apps, data, model connections, and agent sessions. The agent's file tools see the current account's workspace, not the engine checkout, other accounts, or credential files.

## Workspace

- `apps/<id>/manifest.json`: app identity and kind.
- `apps/<id>/src/`, `index.html`, `package.json`, `public/`: frontend source and assets.
- `apps/<id>/plugins/<plugin>/manifest.json` and `plugin.js`: sandboxed backend behavior.
- `apps/<id>/data/`: the person's app data. Each app defines its own layout.
- `apps/<id>/node_modules/` and `dist/`: derived dependencies and browser builds.
- `plugins/`: account-level plugins.
- `AGENTS.md`, `persona.md`, `notes/`, `commands/`: workspace instructions, standing preferences, reference notes, and reusable prompts.
- `agent/sessions/`: saved agent conversations.

`config.yaml` belongs to the engine's home folder. Account connections, keys, MCP configuration, and other protected settings live outside the agent workspace. Use Settings or the available administrative tools rather than trying to locate or edit credentials.

## Which capabilities live where

The engine provides model generation, thinking and usage reporting, images, audio, embeddings, assets, app builds, plugin execution, app distribution, per-account history, and outbound MCP connections. Availability depends on the actual connections and permissions configured. Do not invent models, costs, usage, or enabled services.

A web app supplies its UI and behavior through files and plugins. A service app supplies its own running program and HTTP API, with explicit administrator approval. The built-in agent can edit workspace files and use permitted tools; its command shell runs in the browser sandbox, not on the server's operating system.

Use an app's data for content or settings it already supports, frontend source for UI changes, and a plugin for new sandboxed backend behavior. A service app is appropriate when the app needs its own server or runtime beyond the plugin sandbox. Read its own instructions before choosing a route or editing its data.
