# Agent Peer

Daemonless local messaging between ordinary Claude Code and Codex CLI sessions. Agent Peer uses each CLI's existing local transport and never invokes another model to deliver a message.

## Requirements

- Node.js 20 or newer
- Claude Code with local session messaging support
- Codex CLI 0.150.1 or newer with `codex queue` (0.151 or newer for optional same-turn steering)

macOS, Linux, and Windows are supported. Claude uses Unix-domain sockets on macOS/Linux and named pipes on Windows; Node's `node:net` handles both transports.

## Install

Add the Stray Bits Sanctuary marketplace once, then install Agent Peer in either or both CLIs:

```sh
claude plugin marketplace add noopz/stray-bits-sanctuary
claude plugin install agent-peer@stray-bits-sanctuary

codex plugin marketplace add noopz/stray-bits-sanctuary
codex plugin add agent-peer@stray-bits-sanctuary
```

Restart each CLI after installation. Install only the Claude plugin for Claude-to-Codex messaging; install both for symmetric replies.

For local development:

```sh
claude --plugin-dir /absolute/path/to/agent-peer
```

Codex has no `--plugin-dir` equivalent. Install it from a configured local or Git marketplace.

## Use

Ask either CLI naturally:

- “List the Codex sessions I can message.”
- “Send the build result to Codex session X.”
- “List the Claude sessions I can message.”
- “Tell Claude session Y to review this change.”

Messages carry an exact return target, allowing the recipient to reply through Agent Peer. Claude-to-Codex tasks are ordinary stock queued user input because Codex has no native cross-agent wire type; Agent Peer appends only the Claude reply route. Codex-to-Claude messages use Claude's canonical `cross-session-message` envelope, so Claude renders and classifies them as peer messages instead of raw user text. Claude replies resolve the registered endpoint directly and do not perform a separate socket probe before delivery.

The helper can also be called directly:

```sh
node scripts/agent-peer.mjs codex list
node scripts/agent-peer.mjs codex send <thread-id-or-name> <summary> <message>
node scripts/agent-peer.mjs codex send --steer <thread-id-or-name> <summary> <message>
node scripts/agent-peer.mjs claude list
node scripts/agent-peer.mjs claude send <session-name-or-address> <summary> <message>
```

The two `list` commands default to the current working directory. Add `--all` to list reachable peers across every project.

## Delivery and security

Claude receives messages with immediate priority. If it is already working, the message joins the current turn at Claude's next tool/model boundary; it does not interrupt an in-flight tool call.

Claude-to-Codex messages use the stock `codex queue` command by default. Each delegated request therefore becomes a separate Codex turn instead of being mixed into an unrelated active user turn. Idle sessions normally start queued input within about ten seconds; busy sessions process it after their current turn, and interrupted threads must be resumed before queued input dispatches.

On Codex 0.151 or newer, `codex send --steer` explicitly injects an informational update into the current turn when the target stock TUI is connected to Codex's shared local app-server. It appears at the next model boundary and does not interrupt an in-flight tool call. Do not use steering for delegated work or requests that need permissions. If no turn is active, the shared endpoint is unavailable, or steering fails, Agent Peer falls back to the queue.

Claude validates local peer credentials and applies its inbound-message policy. It can hold a cross-session message for confirmation. Users who want automatic local delivery can add this to their Claude user settings:

```json
{
  "crossSessionInbound": "accept"
}
```

Agent Peer resolves only exact unique names, exact thread IDs, or exact local addresses. Child processes are launched with argument arrays and without shell command construction.

On macOS and Linux, Codex discovery combines running `codex` TUI process working directories with loaded top-level user threads from the stock shared app-server. When multiple loaded threads share a directory, the newest threads are matched to the number of running TUI processes there. On Windows or when the shared endpoint is unavailable, Agent Peer combines writer-lock filenames with the state store; an abnormally terminated process can leave a stale entry until Codex cleans its locks.

Codex's shell sandbox does not allow probing Claude's local IPC endpoints. The bundled Codex skills request narrowly scoped host IPC access for Claude discovery and delivery; this is automatically handled according to the user's Codex approval policy.
