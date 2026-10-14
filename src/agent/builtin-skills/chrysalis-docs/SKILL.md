---
name: chrysalis-docs
description: Explain and troubleshoot Chrysalis Engine, its settings, app updates, agent tools, sandbox boundaries, frontend builds, service apps, and plugin capabilities. Consult when a task depends on how the engine works; use the selected app's own instructions for its data and behavior.
---

# Chrysalis documentation

These are the engine's bundled docs for this installed version. They are available offline in every conversation, with or without a selected app.

Read the relevant topic with `skill_read({ name: "chrysalis-docs", path: "references/<topic>.md" })`. These resources are bundled into the engine, outside the user's workspace; do not try to read or edit them with file tools.

| Topic | Read when |
| --- | --- |
| `references/overview.md` | Explaining what Chrysalis does, its files, accounts, or capability boundaries. |
| `references/settings.md` | Configuring connections, MCP, server access, installs, updates, or backups. |
| `references/apps.md` | Understanding frontend builds, the app bridge, hot updates, or service apps. |
| `references/plugins.md` | Understanding backend permissions, exports, model calls, tools, hooks, or network access. |
| `references/agent.md` | Explaining agent modes, skills, app targeting, history, compaction, or inspection tools. |
| `references/troubleshooting.md` | Diagnosing failed builds, blank pages, model errors, network problems, or unavailable tools. |

Read only the topics needed for the task. Explain behavior in plain language, and use supported tools to inspect actual state before claiming a setting, connection, model, or build is available. The installed app's `AGENTS.md`, data documentation, and loaded app skills define that app's schemas and routes. This engine skill does not replace them or grant permission to change anything.

For public links, the documentation website is https://projectchrysalis.github.io/. Its current pages may describe a newer version than this installation. Do not require internet access to answer questions covered by these bundled topics.
