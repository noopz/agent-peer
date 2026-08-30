---
name: list-codex
description: List locally running Codex CLI sessions that Claude can contact. Use when the user asks which Codex agents or sessions are available, active, or reachable.
---

# List Codex Sessions

Run the bundled client and present its JSON output concisely. By default it lists peers in the current working directory, which is the normal side-by-side project workflow:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex list
```

Only when the user explicitly asks for sessions across every project, add `--all`.

Use the exact `id` as the safest send target. An exact unique `name` is also accepted. On macOS and Linux, entries combine running Codex TUI process working directories with the stock shared app-server's loaded-thread metadata. On Windows or when that endpoint is unavailable, Agent Peer falls back to Codex's writer-lock registry and state store.
