import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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

export async function listClaudeSessions(options = {}) {
  const claudeHome = options.claudeHome || defaultClaudeHome(options.env);
  const sessionsDirectory = path.join(claudeHome, "sessions");
  const records = [];
  for (const filename of (await directoryNames(sessionsDirectory)).filter((name) => /^\d+\.json$/.test(name))) {
    try {
      const record = await readJson(path.join(sessionsDirectory, filename));
      const endpoint = record.messagingSocketPath;
      if (typeof endpoint !== "string" || !await endpointIsLive(endpoint, options.timeoutMs)) continue;
      if (options.cwd && !await pathsMatch(record.cwd, options.cwd)) continue;
      records.push({
        name: record.name,
        address: localAddress(endpoint),
        status: record.status,
        cwd: record.cwd,
        pid: record.pid,
        sessionId: record.sessionId,
        version: record.version,
        kind: record.kind,
        updatedAt: record.updatedAt,
        _record: record,
      });
    } catch {}
  }
  return records.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function registeredClaudeSessions(options = {}) {
  const claudeHome = options.claudeHome || defaultClaudeHome(options.env);
  const sessionsDirectory = path.join(claudeHome, "sessions");
  const records = [];
  for (const filename of (await directoryNames(sessionsDirectory)).filter((name) => /^\d+\.json$/.test(name))) {
    try {
      const record = await readJson(path.join(sessionsDirectory, filename));
      if (typeof record.messagingSocketPath === "string") records.push(record);
    } catch {}
  }
  return records;
}

export async function currentClaudeSession(options = {}) {
  const env = options.env || process.env;
  const requestedId = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (!requestedId) return null;
  const claudeHome = options.claudeHome || defaultClaudeHome(env);
  const sessionsDirectory = path.join(claudeHome, "sessions");
  for (const filename of (await directoryNames(sessionsDirectory)).filter((name) => /^\d+\.json$/.test(name))) {
    try {
      const record = await readJson(path.join(sessionsDirectory, filename));
      if (record.sessionId === requestedId) return record;
    } catch {}
  }
  return null;
}

function endpointDigests(endpoint) {
  const candidates = [endpoint];
  if (process.platform !== "win32") candidates.push(path.resolve(endpoint));
  return [...new Set(candidates)].map((value) => crypto.createHash("sha256").update(value).digest("hex"));
}

export async function authLineForClaudeSession(record, options = {}) {
  const claudeHome = options.claudeHome || defaultClaudeHome(options.env);
  const sessionsDirectory = path.join(claudeHome, "sessions");
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

function websocketFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function websocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const largeLength = buffer.readBigUInt64BE(offset + 2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized app-server websocket frame");
      length = Number(largeLength);
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const fullHeaderLength = headerLength + (masked ? 4 : 0);
    if (buffer.length - offset < fullHeaderLength + length) break;
    let payload = buffer.subarray(offset + fullHeaderLength, offset + fullHeaderLength + length);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset += fullHeaderLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function withCodexWebSocket(callback, endpoint, options = {}) {
  const socket = endpoint.path
    ? net.createConnection({ path: endpoint.path })
    : net.createConnection({ host: endpoint.host, port: endpoint.port });
  const key = crypto.randomBytes(16).toString("base64");
  let wire = Buffer.alloc(0);
  let handshaken = false;
  let nextId = 1;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };
  const opened = new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
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
      socket.write(headers.join("\r\n"));
    });
    socket.on("data", (chunk) => {
      wire = Buffer.concat([wire, chunk]);
      if (!handshaken) {
        const boundary = wire.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const header = wire.subarray(0, boundary).toString("utf8");
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        if (!header.startsWith("HTTP/1.1 101") || !header.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          reject(new Error(`app-server websocket upgrade failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }
        handshaken = true;
        wire = wire.subarray(boundary + 4);
        resolve();
      }
      if (!handshaken || wire.length === 0) return;
      const decoded = websocketFrames(wire);
      wire = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x9) {
          socket.write(websocketFrame(frame.payload, 0xA));
          continue;
        }
        if (frame.opcode === 0x8) {
          rejectAll(new Error("codex app-server websocket closed"));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        let message;
        try { message = JSON.parse(frame.payload.toString("utf8")); } catch { continue; }
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        clearTimeout(waiter.timeout);
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    });
  });
  socket.once("error", rejectAll);
  socket.once("close", () => rejectAll(new Error("codex app-server websocket disconnected")));
  await opened;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for codex app-server method ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    socket.write(websocketFrame(JSON.stringify({ id, method, params })));
  });
  try {
    await request("initialize", { clientInfo: { name: "agent-peer", version: "0.1.6" }, capabilities: { experimentalApi: true } });
    socket.write(websocketFrame(JSON.stringify({ method: "initialized", params: {} })));
    return await callback(request);
  } finally {
    socket.end(websocketFrame(Buffer.alloc(0), 0x8));
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
  if (process.platform === "win32") return null;
  const codexHome = options.codexHome || defaultCodexHome(env);
  const socketPath = path.join(codexHome, "app-server-control", "app-server-control.sock");
  try {
    await fs.stat(socketPath);
    return { path: socketPath };
  } catch {
    return null;
  }
}

async function withCodexAppServer(callback, options = {}) {
  const env = options.env || process.env;
  const codexBin = options.codexBin || env.AGENT_PEER_CODEX_BIN || "codex";
  const child = spawn(codexBin, options.codexAppServerArgs || ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  const rejectAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };
  lines.on("line", (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    clearTimeout(waiter.timeout);
    if (frame.error) waiter.reject(new Error(frame.error.message || JSON.stringify(frame.error)));
    else waiter.resolve(frame.result);
  });
  child.once("error", rejectAll);
  child.once("exit", (code) => {
    if (pending.size > 0) rejectAll(new Error(`codex app-server exited with ${code}: ${stderr.trim()}`));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for codex app-server method ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "agent-peer", version: "0.1.6" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    return await callback(request);
  } catch (error) {
    const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  } finally {
    const closed = child.exitCode === null && child.signalCode === null
      ? new Promise((resolve) => child.once("close", resolve))
      : Promise.resolve();
    lines.close();
    child.stdin.end();
    child.kill();
    await closed;
  }
}

async function loadedCodexThreads(options = {}) {
  if (options.loadedCodexThreads) return await options.loadedCodexThreads();
  const endpoint = await codexWebSocketEndpoint(options);
  if (!endpoint) return null;
  try {
    return await withCodexWebSocket(async (request) => {
      const ids = [];
      let cursor;
      do {
        const loaded = await request("thread/loaded/list", { limit: 100, cursor });
        ids.push(...(Array.isArray(loaded?.data) ? loaded.data : []));
        cursor = loaded?.nextCursor || null;
      } while (cursor);
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
    const userThreads = loadedThreads.filter((thread) =>
      thread
      && isTopLevelCodexThread(thread)
      && (!thread.threadSource || thread.threadSource === "user")
    );
    const liveThreads = await selectThreadsForRunningCodexProcesses(userThreads, options);
    const matching = [];
    for (const thread of liveThreads) {
      if (options.cwd && !await pathsMatch(thread.cwd, options.cwd)) continue;
      matching.push(thread);
    }
    return matching.map(codexSessionSummary);
  }
  const activeIds = new Set(
    (await directoryNames(path.join(codexHome, "thread-writer-locks")))
      .filter((name) => /^[0-9a-f-]{36}\.lock$/i.test(name))
      .map((name) => name.slice(0, -5)),
  );
  if (activeIds.size === 0) return [];
  const threads = await withCodexAppServer(async (request) => {
    const found = [];
    let cursor;
    do {
      const result = await request("thread/list", {
        limit: 100,
        cursor,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        cwd: options.cwd || undefined,
        useStateDbOnly: true,
      });
      found.push(...(Array.isArray(result?.data) ? result.data : []));
      cursor = result?.nextCursor || null;
    } while (cursor && ![...activeIds].every((id) => found.some((thread) => thread.id === id)));
    return found;
  }, options);
  return threads.filter((thread) => activeIds.has(thread.id) && isTopLevelCodexThread(thread)).map(codexSessionSummary);
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
  const sourceIsSubagent = thread?.source && typeof thread.source === "object" && "subagent" in thread.source;
  return thread?.parentThreadId == null && !sourceIsSubagent;
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
    const loadedIds = [];
    let cursor;
    do {
      const loaded = await request("thread/loaded/list", { limit: 100, cursor });
      loadedIds.push(...(Array.isArray(loaded?.data) ? loaded.data : []));
      cursor = loaded?.nextCursor || null;
    } while (cursor && !loadedIds.includes(threadId));
    if (!loadedIds.includes(threadId)) return null;
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

export async function sendCodex(target, summary, message, options = {}) {
  const sessions = await listCodexSessions(options);
  const matches = sessions.filter((session) => session.id === target || session.name === target);
  if (matches.length !== 1) throw new Error(`recipient is not exactly one active Codex session: ${target}`);
  const env = options.env || process.env;
  const origin = await currentClaudeSession(options) || {
    name: env.CLAUDE_CODE_SESSION_NAME,
    sessionId: env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID,
  };
  const content = envelopeFromClaude(message, origin);
  if (options.delivery === "steer") {
    let steered = null;
    try {
      steered = options.steerCodex
        ? await options.steerCodex(matches[0].id, content)
        : await steerCodexCurrentTurn(matches[0].id, content, options);
    } catch (error) {
      if (env.AGENT_PEER_DEBUG) process.stderr.write(`Codex steering unavailable; using queue: ${errorMessage(error)}\n`);
    }
    if (steered) return {
      success: true,
      to: matches[0],
      from: { name: origin.name || null, sessionId: origin.sessionId || null, endpoint: origin.messagingSocketPath || null },
      summary,
      delivery: "steered",
      turnId: steered.turnId,
      queueItemId: null,
    };
  }
  const codexBin = options.codexBin || env.AGENT_PEER_CODEX_BIN || "codex";
  const queued = options.queueCodex
    ? await options.queueCodex(matches[0].id, content)
    : await spawnCapture(codexBin, ["queue", "--thread", matches[0].id, "--message", content], options);
  const stdout = queued.stdout || "";
  return {
    success: true,
    to: matches[0],
    from: { name: origin.name || null, sessionId: origin.sessionId || null, endpoint: origin.messagingSocketPath || null },
    summary,
    delivery: "queued",
    turnId: null,
    queueItemId: stdout.match(/Queued message ([0-9a-f-]{36})/i)?.[1] || queued.queueItemId || null,
    output: stdout.trim(),
  };
}

function usage() {
  return [
    "usage:",
    "  agent-peer codex list [--all]",
    "  agent-peer codex send <exact-id-or-name> <summary> <message>",
    "  agent-peer codex send --steer <exact-id-or-name> <summary> <message>",
    "  agent-peer claude list [--all]",
    "  agent-peer claude send <exact-name-or-address> <summary> <message>",
  ].join("\n");
}

export async function runCli(args, options = {}) {
  const [host, command, ...rest] = args;
  try {
    let result;
    if (host === "codex" && command === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--all"))) {
      result = await listCodexSessions({ ...options, cwd: rest[0] === "--all" ? undefined : process.cwd() });
    }
    else if (host === "codex" && command === "send" && rest.length === 3) result = await sendCodex(...rest, options);
    else if (host === "codex" && command === "send" && rest.length === 4 && rest[0] === "--steer") {
      result = await sendCodex(...rest.slice(1), { ...options, delivery: "steer" });
    }
    else if (host === "claude" && command === "list" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--all"))) {
      result = (await listClaudeSessions({ ...options, cwd: rest[0] === "--all" ? undefined : process.cwd() })).map(({ _record, ...item }) => item);
    }
    else if (host === "claude" && command === "send" && rest.length === 3) result = await sendClaude(...rest, options);
    else {
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
