# 0001 — Daemonless native transports

Status: accepted

## Decision

Use the CLIs' existing local transports. Claude uses its registered Unix socket or Windows named pipe. Codex uses the running app-server's WebSocket-over-control-socket transport; Node connects directly on macOS/Linux, while Windows uses a short-lived stock `codex app-server proxy` process. Nothing persists after an operation.

Do not add an Agent Peer daemon, require a special launcher, or patch either CLI. Native delivery falls back to `codex queue` when Codex's control endpoint is unavailable.

## Why

Users can start ordinary side-by-side `claude` and `codex` terminals. Codex already owns the cross-platform socket adapter, so its proxy is the portable Windows bridge rather than a second broker.

## Sources

- Codex [control transport and proxy contract](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server/README.md#L20-L44)
- Codex [stdio-to-socket proxy implementation](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/stdio-to-uds/src/lib.rs#L10-L45)
- Codex [Windows `uds_windows` adapter](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/uds/src/lib.rs#L162-L220)
