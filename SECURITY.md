# Security

Chrysalis runs code written by an AI agent and by other people (shared apps,
plugins, character cards), so its sandbox, network allowlist and account
boundaries matter. Reports about any of them are welcome.

## How Chrysalis is protected

- **API keys never leave the server.** They live in a credentials folder
  outside the workspace, are write-only over the API, and are never sent to
  the browser, apps, plugins or the agent. The server adds a key to a
  provider call itself, and only for the address the key was saved for.
- **App pages are sandboxed.** Each app runs in a cookieless, opaque-origin
  frame whose content security policy allows no network connections. It
  reaches the engine only through a bridge with a short allowlist (its own
  plugins, generation, its own assets), and the server enforces the same
  allowlist again.
- **Plugins are sandboxed.** Server-side plugin code runs in QuickJS
  (WebAssembly) on a worker thread with no fetch, file system or processes.
  Each capability is a permission the user approves; file access is limited
  to the app's data folder, and network access to the hosts the plugin's
  manifest lists, re-checked on every redirect.
- **Updates ask before they take more.** A community app's update stops for
  review when it adds a plugin permission, a network host or packages.
  Package install scripts never run, and apps build in a browser sandbox.
- **The agent's shell runs in the browser**, in WebAssembly, not on the
  host. Server settings changes and new accounts need the user's approval.

`test/malicious-plugin.test.ts` and `test/security.test.ts` try to break each
of these on every push.

## Reporting a vulnerability

Please report privately through
[GitHub's security advisories](https://github.com/ProjectChrysalis/Chrysalis-Engine/security/advisories/new),
not in a public issue. Include the version (`chrysalis --version`), how you run
it (download, Android, Docker, source) and the steps to reproduce.

## Supported versions

Fixes go into `staging` first and ship in the next stable release. Only the
latest stable release is supported.
