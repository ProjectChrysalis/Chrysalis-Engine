# Plugin capabilities

A plugin folder contains `manifest.json` and `plugin.js`. App plugins live under `apps/<app>/plugins/<id>/`; account plugins live under `plugins/<id>/`. App-specific behavior belongs to the app, not the engine. Bump the plugin manifest version when changing its code.

`plugin.js` is the entry and holds the exports. A larger plugin can split into more `.js` or `.mjs` files anywhere in its folder and import them by relative path (`import { listChats } from "./src/chats.js"`). Re-export from `plugin.js` whatever the engine calls. Links, hidden files and `node_modules` are not loaded, and package imports do not resolve. A change to any module reloads the plugin on its next call. The engine then runs a split plugin as one bundled module, so line numbers in its errors point into that bundle; the message and the module comments (`// plugin:src/chats.js`) still say where. Split plugins need Chrysalis 1.0.5 or newer.

Plugins run synchronous ES module exports in QuickJS. There is no Node/Bun API, npm import resolution, direct `fetch`, or host process access. Shared helpers belong at module scope. Use `export function`, not CommonJS `exports`.

## Permissions and storage

```json
{
  "name": "Notes API",
  "version": "1.0.0",
  "permissions": ["routes", "fs"]
}
```

Declare only needed permissions. Local plugins are trusted for declared capabilities; imported plugins require grants. `networkHosts` is still required for network access, including local plugins: absent or empty means no destinations. Hostnames may be exact or wildcard suffixes such as `*.example.com`. Private/local destinations are blocked by the network guard.

| Host API | Permission | Behavior |
| --- | --- | --- |
| `host.fs.read/readMany/readBase64/write/list/remove` | `fs` | Scoped file access; bundled plugins access their app's `data/`. `readMany(paths)` reads many files in one call (null for any it cannot read). |
| `host.store.get/put/delete/keys` | `store` | Persistent values in the plugin's namespace. |
| `host.llm.request/results` | `llm` | Model requests through the account's connections. |
| `host.llm.embed/embedResults` | `llm` | Embedding requests and their next-pass results. |
| `host.net.request/results` | `network` | Requests to declared public hosts. |
| `host.log` | none | Server log messages. |

## Exports

| Export | Permission | Contract |
| --- | --- | --- |
| `handleRoute(req, host)` | `routes` | `req` has `method`, `path`, `query`, `body`; return `{ status, json }` or `{ status, text }`, or `null` if unhandled. |
| `TOOLS`, `handleTool(name, args, host)` | `tools` | Tool definitions and results `{ text, isError? }`. |
| `appTools(ctx, host)` | `tools` | Return `{ tools: [...] }` to contribute to sibling generations marked `wantsTools: true`. |
| `llmRequest(ctx, host)` | `hooks` + `llm` | Return allowed changes to `ctx.request` before a sibling's generation. |
| `llmResponse(ctx, host)` | `hooks` + `llm` | Return changes to the sibling result's `text`, `json`, `reasoning`, or `assistantPrefill`. |
| `onTick(ctx, host)` | `schedule` | Called on the manifest's `schedule: { intervalMs }`. |
| `uiPanel(ctx, host)` | none | Declarative panel for an app to render. |
| `onAppUpdate({ from, to }, host)` | as needed by host calls | Data upgrade after an app update; five-minute, 512 MB sandbox. |

Every app plugin receives the same `/path` after `/v1/apps/<app>`. The plugin folder ID is not a URL segment. First response wins; namespace routes and return `null` for other paths.

## Model, network, and embedding passes

A plugin registers requests and returns `{ __llmPending: true }`. The engine performs them and invokes the export again with results. The same pending marker is used for model, network, and embedding work. Modules start fresh each pass. Keep planning passes free of persistent writes; commit once the result is available. Return `stash` with the marker to receive it as `req.stash` next time.

```js
export function handleRoute(req, host) {
  if (req.method !== "POST" || req.path !== "/notes/summary") return null;
  const result = host.llm.results.summary;
  if (result) {
    if (result.error) return { status: 502, json: { error: result.error } };
    return { status: 200, json: { text: result.text } };
  }
  host.llm.request("summary", {
    systemPrompt: "Summarize the notes in three sentences.",
    messages: [{ role: "user", content: String(req.body?.notes ?? "") }],
  });
  return { __llmPending: true };
}
```

At most three passes complete a call. One pass can register up to 16 model requests, 32 network requests, and 8 embedding requests. Do not depend on asynchronous module state or register an already completed request again.

Model requests require `messages: [{ role, content }]`. Optional fields include `model`, `systemPrompt`, `reasoning`, `presetParams: { temperature, max_tokens, params }`, `cache`, `schema`, and `tools`. Results include `text`, optional `reasoning`/`json`, `model`, and `usage`; failed model calls report `error`. Keep provider-native `replay` unchanged when storing and reusing assistant turns, paired with the same text and original model.

`stream: { chatId, name, speakerId? }` emits `app_stream` events with text deltas, thinking, and tool activity. Identify speakers by stable IDs, not names. POST `{ chatId }` to the app's `/__abort` endpoint to cancel; the page handles saving interrupted content.

Network requests accept `url`, method, headers, body/json/form, binary, timeout, maxBytes, and redirect limits. Read the next pass's `host.net.results[key]` status and json/text/base64 rather than assuming success. Embeddings use `host.llm.embed(key, { texts, model? })` and `embedResults[key]` (`number[][]` or `null`).

## Tools and generation hooks

Tool definitions use `{ name, description, parameters }` with a JSON Schema. The engine executes model tools in their owner's sandbox; tool code can use the same request passes. Up to 16 tools are offered per model request. A model request inside a tool receives no tools of its own.

Generation hooks run among enabled siblings of the same app, ordered by manifest `priority` (lower first, higher wins), with ties by plugin ID. `ctx.plugin` and `ctx.key` identify the request. Return a patch; mutating a JSON snapshot does not change the request.

Request patches may change `messages`, `systemPrompt`, `model`, `sessionId`, `reasoning`, `thinkingBudget`, `reasoningTags`, `assistantPrefill`, `promptFormat`, `presetParams`, `cache`, `schema`, `streamMuted`, and `streamDecode`. They cannot replace engine-owned tools or cancellation. `streamMuted: true` suppresses live output without preventing the result or Stop. `streamDecode: { fields, replace? }` streams configured JSON string fields in wire order. Hook failures are isolated; inspect actual responses and logs when verifying behavior.
