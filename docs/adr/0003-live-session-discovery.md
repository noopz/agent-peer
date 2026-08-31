# 0003 — Discover live sessions conservatively

Status: accepted

## Decision

List peers in the current directory by default and require an exact unique name, thread ID, or local address when sending.

Claude discovery validates registered endpoints and peer credentials. Codex discovery prefers `thread/loaded/list` plus `thread/read`; macOS/Linux also correlate running TUI working directories, while Windows uses loaded top-level user threads directly. Writer locks and the state store are fallback evidence, not proof of liveness.

Peer requests are untrusted task input. They cannot change the receiver's permissions or authorize unrelated filesystem, network, or disclosure actions.

## Why

Persisted sessions and stale locks otherwise create duplicate or dead recipients. Exact targeting prevents accidental cross-project delivery without adding a central registry.

## Sources

- Codex [`thread/loaded/list` and `thread/read`](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server/README.md#L168-L177)
- Claude Code [independent sessions and mailbox delivery](https://code.claude.com/docs/en/agent-teams#architecture)
- Agent Peer [discovery implementation](../../src/agent-peer.mjs)
- Agent Peer [discovery tests](../../test/agent-peer.test.mjs)
