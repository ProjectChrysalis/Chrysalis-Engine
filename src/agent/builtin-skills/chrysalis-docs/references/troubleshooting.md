# Troubleshooting

Inspect evidence before changing files. For an app problem, select its target, read its instructions, then use the appropriate build, console, inspection, or service API tool. Report the actual error and distinguish what was checked from what remains unknown.

| Symptom | Inspect or explain |
| --- | --- |
| Web app blank or stale | `app_check`, `app_console`, `app_inspect`; use `app_rebuild` for a stale build. A page must be open for browser builds and captured logs. |
| Dependency import fails | Actual `package.json`, `app_deps`, and build errors. Install scripts and bundler plugins do not run. |
| Plugin route missing or wrong | Plugin manifest permissions, exported ESM function, exact app-scoped path, and whether another plugin answered first. |
| Plugin helper undefined | Put shared helpers at module scope. Browser/Bun execution alone does not prove QuickJS compatibility. |
| Model or network result missing | Request keys, next-pass results, manifest permissions, network hosts, and reported errors; do not use native fetch inside plugins. |
| Remote image or socket blocked | Frame/bridge allowed routes and plugin proxy/host declarations. Do not weaken the sandbox policy. |
| Service app not running | The user starts it from its tab; administrator approval and startup/setup reports apply. Its page is not available to `app_inspect`. |
| Model generation fails | Provider's error, HTTP status, model ID, and available connection/catalog state. Do not invent a stop reason or silently replace the requested model. |
| Speech returns HTTP 403 | Report the service rejection. A failed external speech service is separate from app build or typecheck failures. |
| Phone cannot connect | Server LAN setting, same network, firewall, and allowed hostname. Service apps also use front ports among the 16 ports after the engine port. |
| Microphone unavailable on phone | HTTPS is required by the browser. Check Server HTTPS configuration. |
| App update conflicts | Nothing changes until the conflict choice; preserve app data and explain keep mine, take update, or agent merge. |
| Shell or MCP unavailable | Actual settings/permissions and configured tools. The shell is not the host machine; an app cannot register an MCP server. |

Host-side logs are in the engine's terminal, `data/logs/chrysalis.log`, and Android's Logs view. Those locations are outside the agent workspace; ask the host operator for the relevant error when no supported tool exposes it. Include installed version, platform/install kind, and the concrete failure when helping with an issue report.
