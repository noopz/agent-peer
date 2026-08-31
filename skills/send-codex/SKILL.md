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

Before sending, show the exact recipient and substantive message unless the user's current request already authorizes that communication. Report whether the result's `delivery` is `native`, `queued`, or `steered`, plus the returned turn or queue item ID.

The client normally uses Codex's native delegated-turn contract: a standalone `codex_app.send_message_to_thread` tool output carrying Codex's recognized `codex_delegation` envelope and this Claude session's exact return address. An idle session starts a turn immediately; a busy session receives the message within its active turn at the next model boundary. Do not construct the envelope manually.

When the running Codex TUI does not expose its stock shared control endpoint, the client automatically falls back to `codex queue`. On Windows, the client reaches the same native endpoint through the stock `codex app-server proxy` command. To require a separate queued turn even when native delivery is available, use:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex send --queue "<target>" "<summary>" "<message>"
```

To require native delivery and fail instead of falling back, use `--native`. Never use `cross-agent-message`; it is not a Codex wire type. Neither delivery path broadens the target session's permissions.

Only when the user explicitly asks to inject an informational update into Codex's current turn, use:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-peer.mjs" codex send --steer "<target>" "<summary>" "<message>"
```

Do not use `--steer` for delegated work or any request that may require tools, filesystem access, network access, or other permissions. Steering falls back to the queue when no turn is active.
