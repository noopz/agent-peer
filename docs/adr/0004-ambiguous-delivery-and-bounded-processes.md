# 0004 — Ambiguous delivery and bounded subprocesses

Status: accepted

## Decision

Treat `turn/start` and `turn/steer` as mutating RPC requests. Once a write is attempted, a timeout, disconnect, malformed response, or transport failure without an acknowledgement yields `DELIVERY_UNKNOWN`. Do not fall back to the queue in that case. Preserve automatic fallback when the endpoint is unavailable before submission or Codex explicitly rejects the request. Explicit `--native` continues to prohibit fallback.

An acknowledgement settles the request permanently; a subsequent disconnect or cleanup event cannot replace its result. An RPC ID without a result or error is not an acknowledgement. A synchronous write failure is conservatively ambiguous because the transport may have partially written the request.

A queue subprocess that starts and then fails also reports unknown delivery. Failure to spawn the executable remains an ordinary error. Neither case is automatically retried. Users should inspect the recipient before retrying an unknown outcome.

All subprocesses share a Node supervisor with a 30-second operation deadline, a combined 16 MiB stdout/stderr limit, and stream error handling. Cleanup closes pipes and requests termination, escalates with Node's `child.kill("SIGKILL")` after one second, and stops waiting after one further second. If termination still cannot be observed, the child handle is unreferenced; the operating system may still retain the process. No platform branches, process-tree commands, or OS-specific hooks are added.

## Consequences

This prevents the client's automatic fallback from duplicating an ambiguously delivered request. It does not provide exactly-once delivery, infer what the recipient did, or deduplicate a later manual retry. An explicit server rejection is treated as evidence that the request failed; this relies on the server reporting mutation errors accurately.

The subprocess deadline and output cap may reject exceptionally slow or large discovery operations. Internal options `processTimeoutMs`, `maxOutputBytes`, and `killGraceMs` permit focused tests and embedding adjustments. RPC requests retain their own 10-second timeout.

## Evidence

- [RPC lifecycle tests](../../test/rpc.test.mjs)
- [Socket-level delivery and proxy tests](../../test/websocket.test.mjs)
- [Subprocess lifecycle tests](../../test/process.test.mjs)
- [Stdio discovery tests](../../test/agent-peer.test.mjs)
