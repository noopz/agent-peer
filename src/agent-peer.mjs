import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRpcClient } from "./rpc.mjs";
import { createWebSocketDecoder, validateWebSocketUpgrade, websocketFrame } from "./websocket.mjs";

const { version: AGENT_PEER_VERSION } = await readJson(new URL("../package.json", import.meta.url));
const MAX_WEBSOCKET_HEADER_BYTES = 16 * 1024;

export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function defaultClaudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeAttribute(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function safeBody(message, tag) {
  return String(message).replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

function safeXmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function localAddress(endpoint) {
  return `local:${endpoint}`;
}

export function envelopeFromClaude(message, origin) {
  const name = origin?.name || "unknown-claude-session";
  const endpoint = origin?.messagingSocketPath || "unknown";
  const returnTarget = endpoint === "unknown" ? name : localAddress(endpoint);
  return [
    String(message),
    "",
    `If this request asks for a reply to the originating Claude Code session, use Agent Peer's send-claude capability with exact recipient ${JSON.stringify(returnTarget)}.`,
  ].join("\n");
}

export function codexDelegationFromClaude(message, origin) {
  const source = origin?.sessionId || origin?.name || "unknown-claude-session";
  return [
    "<codex_delegation>",
    `  <source_thread_id>${safeXmlText(`claude:${source}`)}</source_thread_id>`,
    `  <input>${safeXmlText(envelopeFromClaude(message, origin))}</input>`,
    "</codex_delegation>",
  ].join("\n");
}

export function envelopeFromCodex(message, origin) {
  const tag = "cross-session-message";
  const threadId = origin?.threadId || "unknown";
  return [
    `<${tag} from-session="${safeAttribute(threadId)}" from-name="Codex">`,
    safeBody(message, tag),
    "",
    `To reply, use Agent Peer's send-codex capability with exact thread ID ${JSON.stringify(threadId)}.`,
    `</${tag}>`,
  ].join("\n");
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function directoryNames(directory) {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function canonicalPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let resolved;
  try {
    resolved = await fs.realpath(value);
  } catch {
    resolved = path.resolve(value);
  }
  const normalized = path.normalize(resolved);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function pathsMatch(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalPath(left),
    canonicalPath(right),
  ]);
  return canonicalLeft !== null && canonicalLeft === canonicalRight;
}

async function endpointIsLive(endpoint, timeoutMs = 350) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(error?.code === "EBUSY"));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function claudeSessionsDirectory(options) {
  const claudeHome = options.claudeHome || defaultClaudeHome(options.env);
  return path.join(claudeHome, "sessions");
}

async function readClaudeSessionRecords(options) {
  const directory = claudeSessionsDirectory(options);
  const records = [];
  for (const filename of await directoryNames(directory)) {
    if (!/^\d+\.json$/.test(filename)) continue;
    try {
      const record = await readJson(path.join(directory, filename));
      if (record && typeof record === "object") records.push(record);
    } catch {
      // Registrations can disappear or be partially written during discovery.
    }
  }
  return records;
}

async function registeredClaudeSessions(options) {
  const records = await readClaudeSessionRecords(options);
  return records.filter((record) => typeof record.messagingSocketPath === "string");
}

export async function listClaudeSessions(options = {}) {
  const records = [];
  for (const record of await registeredClaudeSessions(options)) {
    if (options.cwd && !await pathsMatch(record.cwd, options.cwd)) continue;
    const live = await endpointIsLive(record.messagingSocketPath, options.timeoutMs).catch(() => false);
    if (!live) continue;
    records.push({
      name: record.name,
      address: localAddress(record.messagingSocketPath),
      status: record.status,
      cwd: record.cwd,
      pid: record.pid,
      sessionId: record.sessionId,
      version: record.version,
      kind: record.kind,
      updatedAt: record.updatedAt,
      _record: record,
    });
  }
  return records.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export async function currentClaudeSession(options = {}) {
  const env = options.env || process.env;
  const requestedId = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (!requestedId) return null;
  const records = await readClaudeSessionRecords(options);
  return records.find((record) => record.sessionId === requestedId) || null;
}

function endpointDigests(endpoint) {
  const candidates = [endpoint];
  if (process.platform !== "win32") candidates.push(path.resolve(endpoint));
  return [...new Set(candidates)].map((value) => crypto.createHash("sha256").update(value).digest("hex"));
}

export async function authLineForClaudeSession(record, options = {}) {
  const sessionsDirectory = claudeSessionsDirectory(options);
  const names = await directoryNames(sessionsDirectory);
  const pidKeys = names.filter((name) => name.startsWith(`${record.pid}.`) && /^[0-9]+\.[0-9a-f]{64}\.key$/i.test(name));
  const preferred = endpointDigests(record.messagingSocketPath)
    .map((digest) => `${record.pid}.${digest}.key`)
    .find((name) => pidKeys.includes(name));
  let keyName = preferred;
  if (!keyName && pidKeys.length === 1) keyName = pidKeys[0];
  if (!keyName && pidKeys.length > 1) {
    const ranked = await Promise.all(pidKeys.map(async (name) => ({ name, mtime: (await fs.stat(path.join(sessionsDirectory, name))).mtimeMs })));
    keyName = ranked.sort((left, right) => right.mtime - left.mtime)[0]?.name;
  }
  if (!keyName) return "";
  try {
    const key = await readJson(path.join(sessionsDirectory, keyName));
    return typeof key.peerToken === "string" ? `${JSON.stringify({ type: "auth", token: key.peerToken })}\n` : "";
  } catch {
    return "";
  }
}

async function writeClaudeFrame(record, frame, options = {}) {
  const wire = `${await authLineForClaudeSession(record, options)}${JSON.stringify(frame)}\n`;
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: record.messagingSocketPath });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5_000, () => fail(new Error(`timed out sending to ${record.messagingSocketPath}`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.end(wire, () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

export async function sendClaude(target, summary, message, options = {}) {
  const sessions = await registeredClaudeSessions(options);
  const matches = sessions.filter((record) => record.name === target || localAddress(record.messagingSocketPath) === target || record.messagingSocketPath === target);
  if (matches.length !== 1) throw new Error(`recipient does not identify exactly one registered local Claude session: ${target}`);
  const recipient = matches[0];
  const env = options.env || process.env;
  const origin = { threadId: env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || "unknown" };
  const messageId = crypto.randomUUID();
  const frame = {
    msgV: 1,
    msg_id: messageId,
    type: "user",
    message: { role: "user", content: envelopeFromCodex(message, origin) },
    priority: "now",
  };
  await writeClaudeFrame(recipient, frame, options);
  return { success: true, to: recipient.name, address: localAddress(recipient.messagingSocketPath), from: origin, summary, messageId };
}

async function withCodexWebSocket(callback, endpoint, options = {}) {
  const env = options.env || process.env;
  const codexBin = options.codexBin || env.AGENT_PEER_CODEX_BIN || "codex";
  const proxy = endpoint.proxy
    ? spawn(codexBin, options.codexProxyArgs || ["app-server", "proxy", "--sock", endpoint.path], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      })
    : null;
  let socket = proxy;
  if (!socket) {
    const address = endpoint.path ? { path: endpoint.path } : { host: endpoint.host, port: endpoint.port };
    socket = net.createConnection(address);
  }
  const readable = proxy ? proxy.stdout : socket;
  const writable = proxy ? proxy.stdin : socket;
  let stderr = "";
  if (proxy) {
    proxy.stderr.setEncoding("utf8");
    proxy.stderr.on("data", (chunk) => { stderr += chunk; });
  }
  const key = crypto.randomBytes(16).toString("base64");
  let wire = Buffer.alloc(0);
  let handshaken = false;
  const rpc = createRpcClient((message) => {
    writable.write(websocketFrame(JSON.stringify(message)));
  }, options.timeoutMs);
  let rejectOpened;
  const decode = createWebSocketDecoder(rpc.receive, (payload) => {
    writable.write(websocketFrame(payload, 0xA));
  });
  const stop = () => {
    if (proxy) {
      proxy.stdin.destroy();
      proxy.stdout.destroy();
      proxy.stderr.destroy();
      proxy.kill();
    } else socket.destroy();
  };
  const fail = (error) => {
    rejectOpened(error);
    rpc.close(error);
    stop();
  };
  const opened = new Promise((resolve, reject) => {
    rejectOpened = reject;
    socket.once("error", fail);
    if (proxy) {
      readable.once("error", fail);
      writable.once("error", fail);
    }
    socket.once(proxy ? "exit" : "close", (code) => {
      const detail = proxy && stderr.trim() ? `: ${stderr.trim()}` : "";
      fail(new Error(`codex app-server websocket disconnected${proxy ? ` (${code})` : ""}${detail}`));
    });
    socket.once(proxy ? "spawn" : "connect", () => {
      const headers = [
        "GET / HTTP/1.1",
        `Host: ${endpoint.host || "localhost"}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...(endpoint.token ? [`Authorization: Bearer ${endpoint.token}`] : []),
        "",
        "",
      ];
      writable.write(headers.join("\r\n"));
    });
    readable.on("data", (chunk) => {
      try {
        wire = Buffer.concat([wire, chunk]);
        if (!handshaken) {
          const boundary = wire.indexOf("\r\n\r\n");
          if ((boundary < 0 ? wire.length : boundary) > MAX_WEBSOCKET_HEADER_BYTES) {
            throw new Error("oversized app-server websocket upgrade headers");
          }
          if (boundary < 0) return;
          validateWebSocketUpgrade(wire.subarray(0, boundary).toString("utf8"), key);
          handshaken = true;
          wire = wire.subarray(boundary + 4);
          resolve();
        }
        decode(wire);
        wire = Buffer.alloc(0);
      } catch (error) {
        fail(error);
      }
    });
  });
  const upgradeTimeout = setTimeout(() => fail(new Error("timed out upgrading codex app-server websocket")), options.timeoutMs ?? 10_000);
  try {
    await opened;
    clearTimeout(upgradeTimeout);
    await initializeCodexClient(rpc);
    return await callback(rpc.request);
  } finally {
    clearTimeout(upgradeTimeout);
    rpc.close();
    stop();
  }
}

async function codexWebSocketEndpoint(options = {}) {
  if (options.codexWebSocketEndpoint) return options.codexWebSocketEndpoint;
  const env = options.env || process.env;
  if (env.AGENT_PEER_CODEX_REMOTE) {
    const url = new URL(env.AGENT_PEER_CODEX_REMOTE);
    if (url.protocol !== "ws:") throw new Error("AGENT_PEER_CODEX_REMOTE currently requires ws://");
    return { host: url.hostname, port: Number(url.port || 80), token: env.AGENT_PEER_CODEX_REMOTE_TOKEN };
  }
  const codexHome = options.codexHome || defaultCodexHome(env);
  const socketPath = path.join(codexHome, "app-server-control", "app-server-control.sock");
  try {
    await fs.stat(socketPath);
    return { path: socketPath, proxy: options.forceCodexProxy || process.platform === "win32" };
  } catch {
    return null;
  }
}

async function initializeCodexClient(rpc) {
  await rpc.request("initialize", {
    clientInfo: { name: "agent-peer", version: AGENT_PEER_VERSION },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});
}

async function withCodexAppServer(callback, options = {}) {
  const env = options.env || process.env;
  const codexBin = options.codexBin || env.AGENT_PEER_CODEX_BIN || "codex";
  const child = spawn(codexBin, options.codexAppServerArgs || ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  const rpc = createRpcClient((message) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }, options.timeoutMs);
  lines.on("line", rpc.receive);
  child.once("error", rpc.close);
  child.stdin.once("error", rpc.close);
  child.stdout.once("error", rpc.close);
  child.once("exit", (code) => {
    rpc.close(new Error(`codex app-server exited with ${code}`));
  });
  try {
    await initializeCodexClient(rpc);
    return await callback(rpc.request);
  } catch (error) {
    const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  } finally {
    const closed = child.exitCode === null && child.signalCode === null
      ? new Promise((resolve) => child.once("close", resolve))
      : Promise.resolve();
    rpc.close();
    lines.close();
    child.stdin.end();
    child.kill();
    await closed;
  }
}

async function* codexPages(request, method, params = {}) {
  const seenCursors = new Set();
  let cursor;
  do {
    const result = await request(method, { limit: 100, ...params, cursor });
    yield Array.isArray(result?.data) ? result.data : [];
    cursor = result?.nextCursor || null;
    if (cursor && seenCursors.has(cursor)) throw new Error(`repeated cursor from codex app-server method ${method}`);
    seenCursors.add(cursor);
  } while (cursor);
}

async function loadedCodexThreads(options = {}) {
  if (options.loadedCodexThreads) return await options.loadedCodexThreads();
  const endpoint = await codexWebSocketEndpoint(options);
  if (!endpoint) return null;
  try {
    return await withCodexWebSocket(async (request) => {
      const ids = [];
      for await (const page of codexPages(request, "thread/loaded/list")) ids.push(...page);
      return await Promise.all(ids.map(async (threadId) => {
        const result = await request("thread/read", { threadId, includeTurns: false });
        return result?.thread || null;
      }));
    }, endpoint, options);
  } catch (error) {
    if ((options.env || process.env).AGENT_PEER_DEBUG) {
      process.stderr.write(`Codex live-session discovery unavailable; using lock registry: ${errorMessage(error)}\n`);
    }
    return null;
  }
}

async function runningCodexProcessCwds(options = {}) {
  if (options.codexProcessCwds) return await options.codexProcessCwds();
  if (process.platform === "win32") return null;
  let processes;
  try {
    processes = await spawnCapture("ps", ["-axo", "pid=,comm=,args="], options);
  } catch {
    return null;
  }
  const pids = processes.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || path.basename(match[2]) !== "codex") return [];
    const args = match[3];
    if (/\s(?:app-server|app|cloud|completion|exec|mcp-server|plugin|queue)(?:\s|$)/.test(args)) return [];
    return [Number(match[1])];
  });
  const cwds = [];
  for (const pid of pids) {
    try {
      if (process.platform === "linux") {
        cwds.push(await fs.realpath(`/proc/${pid}/cwd`));
      } else if (process.platform === "darwin") {
        const result = await spawnCapture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], options);
        const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
        if (cwd) cwds.push(cwd);
      }
    } catch {}
  }
  return cwds;
}

async function selectThreadsForRunningCodexProcesses(threads, options = {}) {
  const processCwds = await runningCodexProcessCwds(options);
  if (processCwds === null) return threads;
  const counts = new Map();
  for (const cwd of processCwds) {
    const canonical = await canonicalPath(cwd);
    if (canonical) counts.set(canonical, (counts.get(canonical) || 0) + 1);
  }
  const grouped = new Map();
  for (const thread of threads) {
    const canonical = await canonicalPath(thread?.cwd);
    if (!canonical || !counts.has(canonical)) continue;
    if (!grouped.has(canonical)) grouped.set(canonical, []);
    grouped.get(canonical).push(thread);
  }
  const selected = [];
  for (const [canonical, candidates] of grouped) {
    candidates.sort((left, right) => {
      const leftActive = left.status?.type === "active" ? 1 : 0;
      const rightActive = right.status?.type === "active" ? 1 : 0;
      return rightActive - leftActive || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });
    selected.push(...candidates.slice(0, counts.get(canonical)));
  }
  return selected;
}

export async function listCodexSessions(options = {}) {
  const env = options.env || process.env;
  const codexHome = options.codexHome || defaultCodexHome(env);
  const loadedThreads = await loadedCodexThreads(options);
  if (loadedThreads !== null) {
    const userThreads = loadedThreads.filter(isUserCodexThread);
    const liveThreads = await selectThreadsForRunningCodexProcesses(userThreads, options);
    return await summarizeCodexSessions(liveThreads, options.cwd);
  }
  const activeIds = new Set(
    (await directoryNames(path.join(codexHome, "thread-writer-locks")))
      .filter((name) => /^[0-9a-f-]{36}\.lock$/i.test(name))
      .map((name) => name.slice(0, -5)),
  );
  if (activeIds.size === 0) return [];
  const threads = await withCodexAppServer(async (request) => {
    const found = [];
    const missingIds = new Set(activeIds);
    const params = {
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      cwd: options.cwd || undefined,
      useStateDbOnly: true,
    };
    for await (const page of codexPages(request, "thread/list", params)) {
      for (const thread of page) {
        if (!thread || !missingIds.delete(thread.id)) continue;
        found.push(thread);
      }
      if (missingIds.size === 0) break;
    }
    return found;
  }, options);
  return await summarizeCodexSessions(threads.filter(isUserCodexThread), options.cwd);
}

function isUserCodexThread(thread) {
  if (!isTopLevelCodexThread(thread)) return false;
  return !thread.threadSource || thread.threadSource === "user";
}

async function summarizeCodexSessions(threads, cwd) {
  const matching = [];
  for (const thread of threads) {
    if (cwd && !await pathsMatch(thread.cwd, cwd)) continue;
    matching.push(codexSessionSummary(thread));
  }
  return matching;
}

function codexSessionSummary(thread) {
  return {
    id: thread.id,
    name: thread.name || null,
    status: thread.status?.type || thread.status || "unknown",
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || null,
  };
}

export function isTopLevelCodexThread(thread) {
  if (!thread || thread.parentThreadId != null) return false;
  const source = thread.source;
  if (!source || typeof source !== "object") return true;
  return !("subagent" in source);
}

async function spawnCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: options.env || process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function steerCodexCurrentTurn(threadId, content, options = {}) {
  const endpoint = await codexWebSocketEndpoint(options);
  if (!endpoint) return null;
  return await withCodexWebSocket(async (request) => {
    let isLoaded = false;
    for await (const ids of codexPages(request, "thread/loaded/list")) {
      if (!ids.includes(threadId)) continue;
      isLoaded = true;
      break;
    }
    if (!isLoaded) return null;
    const turns = await request("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const activeTurn = turns?.data?.find((turn) => turn.status === "inProgress");
    if (!activeTurn) return null;
    const steered = await request("turn/steer", {
      threadId,
      expectedTurnId: activeTurn.id,
      input: [{ type: "text", text: content, text_elements: [] }],
      clientUserMessageId: crypto.randomUUID(),
    });
    return { turnId: steered.turnId || activeTurn.id };
  }, endpoint, options);
}

async function startNativeCodexDelegation(threadId, message, origin, options = {}) {
  const endpoint = await codexWebSocketEndpoint(options);
  if (!endpoint) throw new Error("the running Codex session does not expose an app-server control endpoint");
  return await withCodexWebSocket(async (request) => {
    const started = await request("turn/start", {
      threadId,
      input: [],
      toolOutput: {
        name: "send_message_to_thread",
        namespace: "codex_app",
        output: codexDelegationFromClaude(message, origin),
      },
    });
    return { turnId: started?.turn?.id || null };
  }, endpoint, options);
}

export async function sendCodex(target, summary, message, options = {}) {
  const sessions = await listCodexSessions(options);
  const matches = sessions.filter((session) => session.id === target || session.name === target);
  if (matches.length !== 1) throw new Error(`recipient is not exactly one active Codex session: ${target}`);
  const env = options.env || process.env;
  const origin = await currentClaudeSession(options) || {
    name: env.CLAUDE_CODE_SESSION_NAME,
    sessionId: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID,
  };
  const recipient = matches[0];
  const result = {
    success: true,
    to: recipient,
    from: {
      name: origin.name || null,
      sessionId: origin.sessionId || null,
      endpoint: origin.messagingSocketPath || null,
    },
    summary,
    turnId: null,
    queueItemId: null,
  };
  if (options.delivery === undefined || options.delivery === "native") {
    try {
      const delegated = options.delegateCodex
        ? await options.delegateCodex(recipient.id, message, origin)
        : await startNativeCodexDelegation(recipient.id, message, origin, options);
      return { ...result, delivery: "native", turnId: delegated.turnId };
    } catch (error) {
      if (options.delivery === "native") throw error;
      if (env.AGENT_PEER_DEBUG) process.stderr.write(`Native Codex delegation unavailable; using queue: ${errorMessage(error)}\n`);
    }
  }
  const content = envelopeFromClaude(message, origin);
  if (options.delivery === "steer") {
    let steered = null;
    try {
      steered = options.steerCodex
        ? await options.steerCodex(recipient.id, content)
        : await steerCodexCurrentTurn(recipient.id, content, options);
    } catch (error) {
      if (env.AGENT_PEER_DEBUG) process.stderr.write(`Codex steering unavailable; using queue: ${errorMessage(error)}\n`);
    }
    if (steered) return { ...result, delivery: "steered", turnId: steered.turnId };
  }
  const codexBin = options.codexBin || env.AGENT_PEER_CODEX_BIN || "codex";
  const queued = options.queueCodex
    ? await options.queueCodex(recipient.id, content)
    : await spawnCapture(codexBin, ["queue", "--thread", recipient.id, "--message", content], options);
  const stdout = queued.stdout || "";
  return {
    ...result,
    delivery: "queued",
    queueItemId: stdout.match(/Queued message ([0-9a-f-]{36})/i)?.[1] || queued.queueItemId || null,
    output: stdout.trim(),
  };
}

function usage() {
  return [
    "usage:",
    "  agent-peer codex list [--all]",
    "  agent-peer codex send <exact-id-or-name> <summary> <message>",
    "  agent-peer codex send --native <exact-id-or-name> <summary> <message>",
    "  agent-peer codex send --queue <exact-id-or-name> <summary> <message>",
    "  agent-peer codex send --steer <exact-id-or-name> <summary> <message>",
    "  agent-peer claude list [--all]",
    "  agent-peer claude send <exact-name-or-address> <summary> <message>",
  ].join("\n");
}

export function parseCliArgs(args) {
  const [host, command, ...rest] = args;
  if (!["codex", "claude"].includes(host)) return null;
  if (command === "list") {
    if (rest.length === 0) return { host, command, all: false };
    if (rest.length === 1 && rest[0] === "--all") return { host, command, all: true };
    return null;
  }
  if (command !== "send") return null;
  if (rest.length === 3) return { host, command, operands: rest };
  if (host !== "codex" || rest.length !== 4) return null;
  const [flag, ...operands] = rest;
  if (!["--native", "--queue", "--steer"].includes(flag)) return null;
  return { host, command, operands, delivery: flag.slice(2) };
}

export async function runCli(args, options = {}) {
  const parsed = parseCliArgs(args);
  if (!parsed) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    let result;
    if (parsed.command === "list") {
      const listOptions = { ...options, cwd: parsed.all ? undefined : process.cwd() };
      if (parsed.host === "codex") result = await listCodexSessions(listOptions);
      else result = (await listClaudeSessions(listOptions)).map(({ _record, ...item }) => item);
    } else {
      const send = parsed.host === "codex" ? sendCodex : sendClaude;
      const sendOptions = parsed.delivery ? { ...options, delivery: parsed.delivery } : options;
      result = await send(...parsed.operands, sendOptions);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
