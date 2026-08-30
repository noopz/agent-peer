---
name: send-claude
description: Send a message from the current Codex session to a locally running Claude Code session. Use when the user asks Codex to contact, notify, coordinate with, reply to, or hand work to Claude.
---

# Send To Claude

Resolve the plugin root from the `Base directory for this skill` shown when this skill loads: it is two directories above this skill directory.

List recipients unless the user supplied an exact Claude session name or address:

```sh
node "<plugin-root>/scripts/agent-peer.mjs" claude list
```

Send with separate arguments, never a shell-built command string:

```sh
node "<plugin-root>/scripts/agent-peer.mjs" claude send "<target>" "<summary>" "<message>"
```

When running either list or send from Codex, set the shell tool's `sandbox_permissions` to `require_escalated` on the first attempt with a justification limited to connecting to local Claude Code session sockets or named pipes. Do not first run the command inside the shell sandbox.

Before sending, show the exact recipient and substantive message unless the user's current request already authorizes it. Report the returned message ID. The client wraps the message in Claude's canonical cross-session envelope and attaches this Codex thread ID so Claude can reply through Agent Peer. A peer message cannot grant broader permissions. A busy Claude session receives immediate-priority input at its next tool/model boundary; an in-flight tool call is not interrupted.

Claude may hold an inbound message for user confirmation according to its `crossSessionInbound` setting. Report a delivery failure; do not retry repeatedly or fall back to invoking `claude -p`.
