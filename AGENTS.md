# Agent Peer contributor notes

Agent Peer is a daemonless bridge between ordinary Claude Code and Codex CLI sessions. Keep it stock-CLI-only: no patched binaries, launch wrappers, persistent brokers, or permission bypasses.

- `src/agent-peer.mjs` owns discovery, transport, envelopes, and delivery.
- `skills/` tells each CLI when and how to call it.
- `docs/adr/` records the protocol decisions and upstream evidence; read these before changing wire formats or session selection.

Preserve peer provenance, exact unique recipients, current-directory filtering, queue fallback, and macOS/Linux/Windows behavior. A peer message never grants authority beyond the receiving session's user and permission policy.

Run `npm test`, `npm run validate:claude`, and the Codex plugin/skill validators before release. Never commit local paths, session IDs, socket paths, tokens, or other user data.
