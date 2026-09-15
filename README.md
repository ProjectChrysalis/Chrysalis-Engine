<p align="center"><img src="client/public/chrysalis_logo.png" width="128" alt="Chrysalis" /></p>

<p align="center">
  <a href="https://github.com/ProjectChrysalis/Chrysalis-Engine/releases/latest"><img src="https://img.shields.io/github/v/release/ProjectChrysalis/Chrysalis-Engine?label=Release" alt="Latest release" /></a>
  <a href="https://www.npmjs.com/package/chrysalis-engine"><img src="https://img.shields.io/npm/v/chrysalis-engine?logo=npm&label=npm" alt="npm version" /></a>
  <a href="https://github.com/ProjectChrysalis/Chrysalis-Engine/stargazers"><img src="https://img.shields.io/github/stars/ProjectChrysalis/Chrysalis-Engine?style=flat&logo=github&label=Stars" alt="GitHub stars" /></a>
  <a href="https://discord.gg/maFVqyeD4Q"><img src="https://img.shields.io/discord/1548807690380255262?logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ProjectChrysalis/Chrysalis-Engine?label=License" alt="License" /></a>
  <a href="https://github.com/ProjectChrysalis/Chrysalis-Engine/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/ProjectChrysalis/Chrysalis-Engine/ci.yml?branch=main&label=CI" alt="CI status" /></a>
</p>

# Chrysalis

**The AI frontend you can reshape just by asking.**

Chrysalis runs on your own computer or phone and opens in your browser. Pick the
apps you want from the built-in Store, and every one of them is files the
built-in agent can change while you watch. Ask for a feature and it builds it.
Your chats, characters and keys are stored on your device.

<p align="center"><img src="https://github.com/ProjectChrysalis/projectchrysalis.github.io/raw/main/assets/showcase.gif" alt="Chrysalis showcase: the agent editing the roleplay app live, character search, building a visual novel app, tool calling, mobile layout and model providers" /></p>

## Install

Pick the download for your system from the
[releases page](https://github.com/ProjectChrysalis/Chrysalis-Engine/releases).
Nothing else needs to be installed.

| System | Download | Start it |
| --- | --- | --- |
| Windows | `Chrysalis-<version>-windows-x64.zip` | Unzip, double-click `chrysalis.exe` |
| macOS (Apple silicon) | `Chrysalis-<version>-macos-arm64.tar.gz` | Unpack, double-click `start.command` |
| macOS (Intel) | `Chrysalis-<version>-macos-x64.tar.gz` | Unpack, double-click `start.command` |
| Linux | `Chrysalis-<version>-linux-x64.tar.gz` (or `-arm64`) | Unpack, run `./chrysalis` |
| Android 9+ | `Chrysalis-<version>-android-arm64.apk` | Install, open the app |
| Docker | `ghcr.io/projectchrysalis/chrysalis-engine` | `docker compose up -d` with this repository's `docker-compose.yml` |

Want new features before they are stable? The
[staging pre-release](https://github.com/ProjectChrysalis/Chrysalis-Engine/releases/tag/staging-latest)
is rebuilt from the `staging` branch on every change. It can break. On Android it
installs as a separate *Chrysalis Staging* app with its own data, so your stable
app is untouched.

Already have [Bun](https://bun.sh)? `bun install -g chrysalis-engine`, then run `chrysalis`.

On macOS, start with `start.command`, not `chrysalis`. These builds do not carry
a signature macOS accepts, so opening `chrysalis` directly is blocked or closes
straight away with `killed`. `start.command`
clears the download flag, signs the program for that Mac and starts it — use it
again after each update. The Bun install above avoids this.

## First start

Chrysalis opens your browser (or prints a link) with a one-time setup address.
Open it, create your account, and add a model connection in
**Settings > API connections**. The first account is the admin: it can add
more people, each with their own workspace, agent and apps.

Lost the link? It is in the window where Chrysalis started and in
`data/logs/chrysalis.log`. Forgot a password? Stop Chrysalis and run
`chrysalis reset-password <name>`.

## Settings file

Server settings live in `config.yaml`, created on first start with a note on
every line. `chrysalis paths` prints where it is:

| Install | config.yaml and data |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Chrysalis` |
| macOS | `~/Library/Application Support/Chrysalis` |
| Linux | `~/.local/share/chrysalis` |
| Docker | the `/chrysalis` volume (`./chrysalis-data`) |
| From source | the repository folder |

Put a `config.yaml` next to the program to keep everything in that folder instead
(a portable copy, for example on a USB drive).

```yaml
port: 8788
lan: false          # true: phones and other computers on your network can open it
allowedHosts: []    # extra names, like chrysalis.home or a Tailscale name
ssl:
  enabled: false    # HTTPS: phones need it for the microphone and installing as an app
```

Admins can change the same settings in **Settings > Server**, which applies them
right away, shows a QR code for your phone, and tells you when a new version is
out. You can also ask the agent ("let my phone connect"); it shows you exactly
what will change and waits for you to approve.

Every setting also works for a single run as an environment variable or a flag:

```sh
CHRYSALIS_PORT=9000 chrysalis
chrysalis --lan --port 9000 --no-open-browser
chrysalis --help
```

## Using it from your phone

- **Chrysalis on your computer, phone on the same Wi-Fi:** turn on
  *Allow other devices on my network* in Settings > Server and scan the QR code.
- **Chrysalis on the phone itself:** install the Android app. It runs the server
  on the phone and opens it in your browser. Uninstalling the app deletes its
  data, so export backups from your apps first.
- **Away from home:** put both devices on [Tailscale](https://tailscale.com) and
  use the computer's Tailscale address. `tailscale cert` gives you HTTPS files
  for `ssl.certPath` and `ssl.keyPath`.

## Updating

Chrysalis keeps your data in its own folder, so an update never touches it.

- Downloads (Windows, macOS, Linux, portable): when a new version is out, an
  **Update to X** button appears at the bottom of the **Where to?** page (the
  page every new tab opens on) and in **Settings > Server**. Click it: Chrysalis
  downloads the update, restarts, and reloads the page.
- Android: install the new APK over the old one.
- Bun: `bun add -g chrysalis-engine@latest`.
- Docker: `docker compose pull && docker compose up -d` (the `:staging` tag for
  staging), or `git pull && docker compose up -d --build` to build it yourself.
- From source: `git pull && bun install && (cd client-agent && bun install) && bun run build:client`, then restart.

Apps you have changed are never overwritten: the **Where to?** page marks apps
with an update, and updating merges it with your edits. To move an app to another device, or keep a copy
before uninstalling, use **Export app** in its info pane, then **Import app >
Backup file** on the other side. The backup carries the app's data and keeps
updating from where it came from.

## Running from source

```sh
git clone https://github.com/ProjectChrysalis/Chrysalis-Engine
cd Chrysalis-Engine
bun install
(cd client-agent && bun install)
bun run build:client
bun start
```

`bun run dev` restarts on every change. `bun test` runs the suite and
`bun run typecheck` checks every project.

### Release builds

```sh
bun run dist                      # every platform, from any one machine
bun run dist linux-x64 npm        # some of them
ANDROID_HOME=~/android-sdk bun run dist android-apk   # the APK (JDK 17+)
```

Output lands in `out/dist/`. Set `CHRYSALIS_ANDROID_KEYSTORE`,
`CHRYSALIS_ANDROID_KEYSTORE_PASSWORD`, `CHRYSALIS_ANDROID_KEY_ALIAS` and
`CHRYSALIS_ANDROID_KEY_PASSWORD` to sign the APK for release; keep that keystore,
since Android only updates an app signed with the same key.

## Community

Questions, ideas and apps you have built: join the
[Project Chrysalis Discord](https://discord.gg/maFVqyeD4Q). Bugs go in
[GitHub issues](https://github.com/ProjectChrysalis/Chrysalis-Engine/issues).

<a href="https://www.star-history.com/#projectchrysalis/chrysalis-engine&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=projectchrysalis/chrysalis-engine&type=Date&theme=dark" />
    <img src="https://api.star-history.com/svg?repos=projectchrysalis/chrysalis-engine&type=Date" alt="Star history chart" width="600" />
  </picture>
</a>

## Branches and contributing

- `main` is stable. Releases are tagged here.
- `staging` is where new work lands first. Open pull requests against `staging`.

Every push and pull request runs the tests and builds every download, then
starts each one on Windows, macOS, Linux and in Docker. To release, merge
`staging` into `main`, set the version in `package.json`, and push a tag:
`git tag v1.2.3 && git push origin v1.2.3`.

## License

Licensed under the **GNU Affero General Public License v3.0 only** (AGPL-3.0-only).
See [LICENSE](LICENSE) for the full text.

## Inspiration

Chrysalis was inspired by [pi](https://pi.dev), the minimal coding agent you
adapt by asking it to build what you need. Chrysalis brings that idea to an AI
frontend, and its agent runs on pi's own libraries.

## Built on

| Project | Used for | License |
| --- | --- | --- |
| [Bun](https://bun.sh) | The runtime: HTTP and WebSocket server, bundler, package manager, test runner | MIT |
| [pi-ai / pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/ai) | The LLM kernel — provider catalog, auth formats, generation, agent loop | MIT |
| [Hono](https://hono.dev) | HTTP server and routing | MIT |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Connecting to external MCP servers for agent tools | MIT |
| [QuickJS-ng](https://github.com/quickjs-ng/quickjs) via [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) | The app plugin sandbox | MIT |
| [wasmsh](https://github.com/mayflower/wasmsh) with [Pyodide](https://pyodide.org) | The agent's in-browser sandbox: an actual shell and a Python runtime, both in wasm | Apache-2.0 |
| [isomorphic-git](https://isomorphic-git.org) | Workspace version control, and installing apps from git without a git program | MIT |
| [esbuild](https://esbuild.github.io) | Bundling app frontends and app builds (WASM inside the browser builder) | MIT |
| [React](https://react.dev) | The web client shell and the agent chat UI | MIT |
| [Base UI](https://base-ui.com) | Component behaviour in the client shell | MIT |
| [assistant-ui](https://assistant-ui.com) | The agent chat UI | MIT |
| [Tailwind CSS](https://tailwindcss.com) | Styling, including the in-browser compiler for apps | MIT |
| [Phosphor Icons](https://phosphoricons.com) | Iconography in the client shell and agent UI | MIT |
| [Zod](https://zod.dev) | Schema validation | MIT |

Every other dependency is MIT, BSD, ISC, Apache-2.0, or OFL-1.1.
