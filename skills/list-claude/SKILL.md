---
name: list-claude
description: List locally running Claude Code sessions that Codex can contact. Use when the user asks which Claude agents or sessions are available, active, or reachable.
---

# List Claude Sessions

Resolve the plugin root from the `Base directory for this skill` shown when this skill loads: it is two directories above this skill directory. By default the command lists peers in the current working directory, which is the normal side-by-side project workflow. Run:

```sh
node "<plugin-root>/scripts/agent-peer.mjs" claude list
```

Only when the user explicitly asks for sessions across every project, add `--all`.

When running this command from Codex, set the shell tool's `sandbox_permissions` to `require_escalated` on the first attempt with a justification limited to probing local Claude Code session sockets or named pipes. The IPC endpoints are outside Codex's shell sandbox; an unprivileged probe can otherwise turn every live session into an empty list.

Present the JSON output concisely. Use an exact unique `name` as the normal send target; the exact `address` is also accepted.
