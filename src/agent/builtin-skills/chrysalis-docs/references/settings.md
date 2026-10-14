# Settings, installs, and updates

## Account settings

Chrysalis Settings owns model connections and provider sign-in, MCP servers, speech endpoints, agent preferences, and account administration. Apps can use permitted engine services but cannot access connection keys. A plugin model request can omit `model` to use the account default or use a real `provider/model-id` from the model catalog.

MCP is an outbound client: the agent consumes configured external MCP servers. Saving a server or approving its host program is an administrative action. Installed apps opt into shared MCP servers separately; they cannot register their own servers.

## Server settings

Admins use Settings > Server, or the agent's `server_settings` tool when available. Read actual settings first. Changes are presented for exact approval, applied to the running engine, then saved to `config.yaml`. Do not bypass that tool by writing workspace files. Environment variables and command-line flags override values for the current run and appear locked in Settings.

Common settings: `port`, `lan`, `listenAddress`, `allowedHosts`, `ssl.enabled`, `ssl.certPath`, `ssl.keyPath`, `openBrowser`, `apps.packageDownloads`, `apps.store`, `agent.shell`, `agent.shellTimeoutSeconds`, and `defaultModel`. Account shell internet access is a separate agent setting.

`chrysalis paths` prints the config and data locations. Source installs use the checkout home; installed copies normally use `%LOCALAPPDATA%/Chrysalis`, `~/Library/Application Support/Chrysalis`, or `~/.local/share/chrysalis`. A config file beside the program selects a portable home. `--home` or `CHRYSALIS_HOME` selects an explicit home. These commands run on the machine hosting Chrysalis, not in the agent's browser shell.

First run prints a one-use setup link and records it in the server log. There is no generated admin password. For a lost password, an administrator can reset another account in Settings > Users, or the host operator can stop the engine and run `chrysalis reset-password <user>`.

## Engine updates

Settings > Server checks releases on demand. Packaged self-updates verify size and checksum, test the new executable, and supervise its first start with rollback on failure. Installs that require replacing the package or container use their platform's update path. A staging installation follows staging releases; stable installations follow stable releases. The staging downloads are at https://github.com/ProjectChrysalis/Chrysalis-Engine/releases/tag/staging-latest and the staging container tag is `:staging`. Confirm a build has been published before promising it contains a fix.

## App updates and backups

The launcher offers updates; app code is not replaced at engine boot. Updates merge local edits against the installed upstream baseline. Conflicting lines require the user's choice: keep mine, take update, or ask the agent to merge. Failed updates restore the writes. Dependencies install with lifecycle scripts disabled. The app's own `onAppUpdate` hooks upgrade data and failed upgrades are retried before the next request.

Updates preserve live app data. Missing underscore-prefixed data templates can be supplied by updates. App backups export code and data plus installation history needed for later merges. Re-importing an already installed source is refused; use Update instead. Do not overwrite a person's data with seed templates or a clean checkout.
