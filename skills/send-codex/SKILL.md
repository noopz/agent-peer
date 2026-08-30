---
name: send-codex
description: Send a message from the current Claude Code session to a locally running Codex CLI session. Use when the user asks Claude to contact, notify, coordinate with, or hand work to Codex.
---

# Send To Codex

First list sessions unless the user supplied an exact Codex thread ID or exact unique name:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex list
```

Send with separate arguments. Do not use a shell-built command string:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex send "<target>" "<summary>" "<message>"
```

Before sending, show the exact recipient and substantive message unless the user's current request already authorizes that communication. Report whether the result's `delivery` is `steered` or `queued`, plus the returned turn or queue item ID.

The client sends the task through Codex's stock user-input queue and appends this Claude session's exact return address. It must not wrap the task in `cross-agent-message`; Codex has no native wire type by that name, and treating it as one causes valid delegated work to be classified as untrusted. The transport does not change Codex permissions. An idle session normally starts the task within about ten seconds; a busy session processes it as a separate turn after its current turn.

Only when the user explicitly asks to inject an informational update into Codex's current turn, use:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex send --steer "<target>" "<summary>" "<message>"
```

Do not use `--steer` for delegated work or any request that may require tools, filesystem access, network access, or other permissions. Steering falls back to the queue when no turn is active.
