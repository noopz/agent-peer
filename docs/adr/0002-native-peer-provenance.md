# 0002 — Preserve native peer provenance

Status: accepted

## Decision

Codex-to-Claude delivery uses Claude's peer-message frame and canonical `cross-session-message` body. Claude-to-Codex delivery starts a turn with empty `input` and a standalone `codex_app.send_message_to_thread` tool output containing Codex's exact `<codex_delegation>` envelope.

Do not substitute ordinary user text for native delegated work. `--queue` is an explicit/fallback separate turn; `--steer` is only for user-authorized informational input.

## Why

The native shapes retain peer/tool provenance, render correctly, and join an active turn at a model boundary. Plain user wrappers lose that distinction and can trigger the wrong trust classification.

## Sources

- Codex [`turn/start` standalone tool-output contract](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/app-server/README.md#L1061-L1075)
- Codex [delegation envelope parser and accepted namespaces](https://github.com/openai/codex/blob/78c290807ce710180111df227df3b7a4fe845452/codex-rs/tui/src/dynamic_tools.rs#L1161-L1197)
- Claude Code [peer-origin message semantics](https://code.claude.com/docs/en/agent-sdk/typescript#sdkmessageorigin)
- Claude Code [automatic teammate delivery](https://code.claude.com/docs/en/agent-teams#context-and-communication)
- Agent Peer [wire-contract tests](../../test/agent-peer.test.mjs)
