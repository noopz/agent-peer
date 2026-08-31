# Architecture decisions

- [0001 — Daemonless native transports](0001-daemonless-native-transports.md)
- [0002 — Preserve native peer provenance](0002-native-peer-provenance.md)
- [0003 — Discover live sessions conservatively](0003-live-session-discovery.md)

Upstream Codex links are pinned to commit `78c290807ce710180111df227df3b7a4fe845452`. Claude's public documentation describes peer-message semantics but not its local IPC framing; executable tests therefore lock down that observed contract.
