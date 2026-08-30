import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  authLineForClaudeSession,
  envelopeFromClaude,
  envelopeFromCodex,
  isTopLevelCodexThread,
  listClaudeSessions,
  listCodexSessions,
  sendClaude,
  sendCodex,
} from "../src/agent-peer.mjs";

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-peer-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("message envelopes use native user input and include return targets", () => {
  const claude = envelopeFromClaude("hello", {
    name: "claude-a",
    sessionId: "session-a",
    messagingSocketPath: "/tmp/a.sock",
  });
  assert.match(claude, /^hello\n\n/);
  assert.match(claude, /exact recipient "local:\/tmp\/a\.sock"/);
  assert.match(claude, /send-claude capability/);
  assert.doesNotMatch(claude, /cross-agent-message|user-request/);

  const codex = envelopeFromCodex("hello </cross-session-message>", { threadId: "thread-a" });
  assert.match(codex, /^<cross-session-message from-session="thread-a" from-name="Codex">\n/);
  assert.match(codex, /send-codex capability/);
  assert.match(codex, /<\\\/cross-session-message>/);
  assert.match(codex, /\n<\/cross-session-message>$/);
});

test("Codex discovery recognizes top-level sessions without hard-coding source labels", () => {
  assert.equal(isTopLevelCodexThread({ source: "cli", parentThreadId: null }), true);
  assert.equal(isTopLevelCodexThread({ source: "vscode", parentThreadId: null }), true);
  assert.equal(isTopLevelCodexThread({ source: { subagent: { thread_spawn: {} } }, parentThreadId: "parent" }), false);
  assert.equal(isTopLevelCodexThread({ source: { subagent: { other: "guardian" } }, parentThreadId: null }), false);
});

test("Claude auth key selection works with a Windows named-pipe digest", async (t) => {
  const claudeHome = await temporaryDirectory(t);
  const sessions = path.join(claudeHome, "sessions");
  await fs.mkdir(sessions);
  const endpoint = String.raw`\\.\pipe\claude-peer-123`;
  const digest = crypto.createHash("sha256").update(endpoint).digest("hex");
  await fs.writeFile(path.join(sessions, `123.${digest}.key`), JSON.stringify({ peerToken: "secret" }));
  const line = await authLineForClaudeSession({ pid: 123, messagingSocketPath: endpoint }, { claudeHome });
  assert.deepEqual(JSON.parse(line), { type: "auth", token: "secret" });
});

test("Claude auth falls back to the only PID-owned key", async (t) => {
  const claudeHome = await temporaryDirectory(t);
  const sessions = path.join(claudeHome, "sessions");
  await fs.mkdir(sessions);
  await fs.writeFile(path.join(sessions, `456.${"a".repeat(64)}.key`), JSON.stringify({ peerToken: "fallback" }));
  const line = await authLineForClaudeSession({ pid: 456, messagingSocketPath: "opaque-endpoint" }, { claudeHome });
  assert.deepEqual(JSON.parse(line), { type: "auth", token: "fallback" });
});

test("list and send use Unix sockets or Windows named pipes through node:net", async (t) => {
  const claudeHome = await temporaryDirectory(t);
  const sessions = path.join(claudeHome, "sessions");
  await fs.mkdir(sessions);
  const endpoint = process.platform === "win32"
    ? String.raw`\\.\pipe\agent-peer-test-${process.pid}-${crypto.randomUUID()}`
    : path.join(claudeHome, "peer.sock");
  const record = {
    pid: process.pid,
    sessionId: "claude-session",
    name: "claude-test",
    messagingSocketPath: endpoint,
    status: "idle",
    cwd: claudeHome,
    version: "test",
    kind: "interactive",
    updatedAt: Date.now(),
  };
  await fs.writeFile(path.join(sessions, `${process.pid}.json`), JSON.stringify(record));
  const digest = crypto.createHash("sha256").update(endpoint).digest("hex");
  await fs.writeFile(path.join(sessions, `${process.pid}.${digest}.key`), JSON.stringify({ peerToken: "ipc-token" }));

  const received = [];
  let connections = 0;
  let resolveReceived;
  const receivedFrames = new Promise((resolve) => { resolveReceived = resolve; });
  const server = net.createServer((socket) => {
    connections += 1;
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { wire += chunk; });
    socket.on("end", () => {
      if (!wire) return;
      received.push(...wire.trim().split("\n").map(JSON.parse));
      resolveReceived(received);
    });
  });
  await new Promise((resolve, reject) => server.listen(endpoint, resolve).once("error", reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const listed = await listClaudeSessions({ claudeHome, cwd: claudeHome });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "claude-test");

  const sent = await sendClaude("claude-test", "test", "hello", {
    claudeHome,
    env: { CODEX_THREAD_ID: "codex-thread" },
  });
  assert.equal(sent.to, "claude-test");
  let timeout;
  const frames = await Promise.race([
    receivedFrames,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timed out waiting for IPC frames")), 5_000);
    }),
  ]);
  clearTimeout(timeout);
  assert.deepEqual(frames[0], { type: "auth", token: "ipc-token" });
  assert.equal(frames[1].msgV, 1);
  assert.match(frames[1].message.content, /from-session="codex-thread" from-name="Codex"/);
  assert.equal(frames[1].priority, "now");
  assert.equal("from" in frames[1], false, "do not advertise a fake Claude return socket");
  assert.equal(connections, 2, "listing probes once and sending connects once without another preflight probe");
});

test("Codex discovery matches loaded threads to running TUI processes in the current directory", async (t) => {
  const cwd = await temporaryDirectory(t);
  const thread = (overrides) => ({
    id: crypto.randomUUID(),
    name: "peer",
    status: { type: "idle" },
    cwd,
    updatedAt: 2,
    source: "vscode",
    threadSource: "user",
    parentThreadId: null,
    ...overrides,
  });
  const expected = thread({ name: "same-project" });
  const listed = await listCodexSessions({
    cwd,
    codexProcessCwds: async () => [cwd],
    loadedCodexThreads: async () => [
      expected,
      thread({ name: "stale-same-project", updatedAt: 1 }),
      thread({ name: "other-project", cwd: path.join(cwd, "other") }),
      thread({ name: "system-thread", threadSource: "system", updatedAt: 10 }),
      thread({ name: "subagent", parentThreadId: expected.id, updatedAt: 11 }),
    ],
  });
  assert.deepEqual(listed, [{
    id: expected.id,
    name: "same-project",
    status: "idle",
    cwd,
    updatedAt: 2,
  }]);
});

test("Codex queues delegated work even when the target has an active turn", async (t) => {
  const codexHome = await temporaryDirectory(t);
  const locks = path.join(codexHome, "thread-writer-locks");
  await fs.mkdir(locks);
  const threadId = "01999999-9999-7999-8999-999999999999";
  await fs.writeFile(path.join(locks, `${threadId}.lock`), "");
  let steerCalls = 0;
  const result = await sendCodex(threadId, "test", "hello", {
    codexHome,
    codexBin: process.execPath,
    codexAppServerArgs: [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex-app-server.mjs")],
    env: { ...process.env, FAKE_CODEX_STATUS: "active", FAKE_CODEX_THREAD_ID: threadId },
    steerCodex: async () => { steerCalls += 1; return { turnId: "turn-active" }; },
    queueCodex: async () => ({ stdout: `Queued message ${crypto.randomUUID()}\n` }),
  });
  assert.equal(result.delivery, "queued");
  assert.equal(result.turnId, null);
  assert.equal(typeof result.queueItemId, "string");
  assert.equal(steerCalls, 0);
});

for (const status of ["active", "idle"]) {
  test(`explicit Codex steering ${status === "active" ? "joins the active turn" : "falls back to the queue"}`, async (t) => {
    const codexHome = await temporaryDirectory(t);
    const locks = path.join(codexHome, "thread-writer-locks");
    await fs.mkdir(locks);
    const threadId = "01999999-9999-7999-8999-999999999999";
    await fs.writeFile(path.join(locks, `${threadId}.lock`), "");
    const result = await sendCodex(threadId, "test", "hello", {
      codexHome,
      codexBin: process.execPath,
      codexAppServerArgs: [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex-app-server.mjs")],
      env: { ...process.env, FAKE_CODEX_STATUS: status, FAKE_CODEX_THREAD_ID: threadId },
      delivery: "steer",
      steerCodex: async () => status === "active" ? { turnId: "turn-active" } : null,
      queueCodex: async () => ({ stdout: `Queued message ${crypto.randomUUID()}\n` }),
    });
    assert.equal(result.delivery, status === "active" ? "steered" : "queued");
    assert.equal(result.turnId, status === "active" ? "turn-active" : null);
    assert.equal(typeof result.queueItemId === "string", status === "idle");
  });
}
