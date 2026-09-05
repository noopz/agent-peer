# Implementation review

Scope: source, CLI entry point, fixtures, tests, skills, manifests, CI, and architecture decisions. Review based on repository code and local fixture execution; no messages were sent to live peers.

## Implemented

- Bound WebSocket upgrades with a deadline, including silent endpoints. Previously, discovery and delivery could wait indefinitely before request timeouts started.
- Reassemble fragmented text messages before UTF-8 decoding and JSON parsing, including interleaved ping/pong frames. Previously, continuation frames were ignored.
- Catch frame-decoder failures inside the data listener and reject the operation. Previously, an oversized length could throw outside the promise error path and terminate the CLI.
- Validate upgrade headers by name and exact accept value. Previously, substring matching accepted an unrelated header containing the expected header name.
- Limit incoming upgrade headers to 16 KiB and messages to 16 MiB; reject unsupported and malformed frames.
- Close transports on initialization failure, callback failure, and completion; handle proxy input/output errors and missing executables.
- Apply user-thread and canonical-directory checks to fallback discovery, and reject null thread records in the top-level predicate.
- Correct the list-codex skill's Windows discovery description.

The test suite now exercises the actual WebSocket delivery path and a fixture proxy, instead of only injecting a successful delegate function.

## Structural quality pass

- Consolidated three Claude registration scans into one reader, with separate endpoint eligibility and liveness checks. Origin lookup still accepts a registration without a messaging endpoint.
- Extracted shared RPC request IDs, deadlines, reply matching, notifications, and terminal failure state into `src/rpc.mjs`. Both transports now use it, including initialization; stdio stream errors are handled.
- Moved frame encoding, decoding, upgrade validation, and message assembly into `src/websocket.mjs`. Connection management stays in `src/agent-peer.mjs`. Explicit frame cases replace the compound continuation condition.
- Consolidated pagination into one async iterator. Callers keep their own early-stop conditions, and repeated cursors now fail instead of looping indefinitely.
- Replaced fallback discovery's repeated nested scans with a set of outstanding IDs. Both discovery paths share user-thread filtering and directory-aware summaries.
- Built common delivery metadata once and separated CLI argument parsing from execution. Host and command checks no longer repeat in every delivery-option branch.
- Consolidated repeated delivery-test fixture setup and isolated those fixtures from live discovery and the user's Claude registration directory.
- Read the runtime client version from package.json, removing the fourth manually maintained version declaration. Package and plugin versions are synchronized at 0.1.8.

Regression coverage includes RPC response ordering, failures and late replies, CLI argument boundaries, malformed registrations, and paginated discovery.

## Remaining priorities

1. **High: distinguish failed delivery from unknown delivery.** `sendCodex` queues after any native error. If `turn/start` or `turn/steer` reaches Codex but its response is lost, fallback can submit the message twice. Introduce a typed delivery outcome: fallback is safe before submitting the mutation or after an explicit rejection; loss after submission should report an unknown outcome. Cross-transport deduplication would require an upstream-supported idempotency contract. Record the chosen semantics in an ADR and test an accepted request followed by disconnect. This review preserves the existing automatic fallback policy.

2. **Medium: bound subprocess operations.** `spawnCapture` has no deadline or output cap. The stdio app-server cleanup waits for termination without an escalation deadline. A stuck queue/process-inspection command or an app-server that ignores termination can keep the CLI alive. Add bounded subprocess teardown with fixtures for stalled commands and ignored termination. Shared RPC tracking and stdio stream error handling are now implemented.

3. **Medium: expose discovery uncertainty.** Matching the newest loaded threads to a count of processes in a directory is heuristic. A busy older thread is preferred by the implementation even though the README only describes newest-thread selection. Writer locks are also explicitly weaker evidence. Return the discovery evidence with each candidate, document the active-first ranking, and prefer exact IDs. Do not treat process counts or stale locks as proof that a particular thread has a live TUI.

## Validation

- 35 tests passed locally on macOS, including local TCP/socket and subprocess fixtures.
- Claude plugin validation passed with a warning about the pre-existing untracked root CLAUDE.md.
- Codex plugin validator and all four skill validators passed.
- Linux and Windows execution remains covered by the configured CI matrix, but was not run in this local review. The fixture proxy tests do not validate the stock Windows adapter itself.
