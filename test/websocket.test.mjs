import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listCodexSessions, sendCodex } from "../src/agent-peer.mjs";

function frame(payload, opcode = 1, fin = true) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

async function controlServer(t, { upgrade, respond } = {}) {
  const sockets = new Set();
  const requests = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let wire = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      wire = Buffer.concat([wire, chunk]);
      if (!upgraded) {
        const boundary = wire.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const key = wire.toString().match(/Sec-WebSocket-Key: (.*)\r\n/)[1];
        const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        const headers = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        if (upgrade) upgrade(socket, headers);
        else socket.write(headers);
        wire = wire.subarray(boundary + 4);
        upgraded = true;
      }
      while (wire.length >= 2) {
        let length = wire[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (wire.length < 4) return;
          length = wire.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (wire.length < 10) return;
          length = Number(wire.readBigUInt64BE(2));
          offset = 10;
        }
        if (wire.length < offset + 4 + length) return;
        assert.ok(wire[1] & 0x80, "client frames must be masked");
        const opcode = wire[0] & 0x0f;
        const mask = wire.subarray(offset, offset + 4);
        const body = Buffer.from(wire.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        wire = wire.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const request = JSON.parse(body.toString());
        requests.push(request);
        if (request.id == null) continue;
        if (respond) respond(socket, request);
        else socket.write(frame(JSON.stringify({ id: request.id, result: { turn: { id: "test-turn" } } })));
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    requests,
    options: {
      codexWebSocketEndpoint: { host: "127.0.0.1", port: server.address().port },
      loadedCodexThreads: async () => [{ id: "test-thread", cwd: process.cwd() }],
      codexProcessCwds: async () => null,
      env: {},
      delivery: "native",
      timeoutMs: 1_000,
    },
  };
}

test("native delivery uses the real WebSocket transport and preserves tool provenance", async (t) => {
  const { options, requests } = await controlServer(t);
  const result = await sendCodex("test-thread", "test", "hello <peer>", options);
  assert.equal(result.turnId, "test-turn");
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "turn/start"]);
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(requests[0].params.clientInfo.version, manifest.version);
  const { params } = requests.at(-1);
  assert.deepEqual(params.input, []);
  assert.equal(params.toolOutput.namespace, "codex_app");
  assert.equal(params.toolOutput.name, "send_message_to_thread");
  assert.match(params.toolOutput.output, /hello &lt;peer&gt;/);
});

test("fragmented WebSocket responses allow interleaved ping frames and split UTF-8", async (t) => {
  const { options } = await controlServer(t, {
    respond(socket, request) {
      const body = Buffer.from(JSON.stringify({ id: request.id, result: { turn: { id: "turn-🍀" } } }));
      const split = body.indexOf(Buffer.from("🍀")) + 1;
      socket.write(Buffer.concat([frame(body.subarray(0, split), 1, false), frame("ping", 9), frame(body.subarray(split), 0)]));
    },
  });
  assert.equal((await sendCodex("test-thread", "test", "hello", options)).turnId, "turn-🍀");
});

for (const [name, behavior, expected] of [
  ["silent upgrade", { upgrade() {} }, /timed out upgrading/],
  ["invalid upgrade", { upgrade(socket, headers) { socket.write(headers.replace("Sec-WebSocket-Accept:", "X-Sec-WebSocket-Accept:")); } }, /upgrade failed/],
  ["oversized headers", { upgrade(socket) { socket.write("x".repeat(16 * 1024 + 1)); } }, /oversized.*headers/],
  ["oversized frame", { respond(socket) {
    const header = Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 0, 0]);
    header.writeBigUInt64BE(2n ** 54n, 2);
    socket.write(header);
  } }, /oversized.*frame/],
  ["unexpected continuation", { respond(socket) { socket.write(frame("{}", 0)); } }, /invalid.*continuation/],
  ["peer disconnect", { respond(socket) { socket.destroy(); } }, /disconnected/],
]) {
  test(`WebSocket ${name} rejects cleanly`, async (t) => {
    const { options } = await controlServer(t, behavior);
    await assert.rejects(sendCodex("test-thread", "test", "hello", { ...options, timeoutMs: 100 }), expected);
  });
}

test("failed WebSocket upgrade falls back to the queue once", async (t) => {
  const { options } = await controlServer(t, { upgrade() {} });
  let queued = 0;
  const result = await sendCodex("test-thread", "test", "hello", {
    ...options,
    timeoutMs: 100,
    delivery: undefined,
    queueCodex: async () => { queued++; return { queueItemId: "queued-item" }; },
  });
  assert.equal(result.delivery, "queued");
  assert.equal(queued, 1);
});

test("native delivery works through a short-lived proxy process", async (t) => {
  const { options } = await controlServer(t);
  const result = await sendCodex("test-thread", "test", "hello", {
    ...options,
    codexBin: process.execPath,
    codexProxyArgs: [fileURLToPath(new URL("../fixtures/fake-codex-proxy.mjs", import.meta.url)), String(options.codexWebSocketEndpoint.port)],
    codexWebSocketEndpoint: { path: "test-control-endpoint", proxy: true },
  });
  assert.equal(result.turnId, "test-turn");
});

test("a missing proxy executable rejects cleanly", async (t) => {
  const { options } = await controlServer(t);
  await assert.rejects(sendCodex("test-thread", "test", "hello", {
    ...options,
    codexBin: "agent-peer-nonexistent-test-executable",
    codexWebSocketEndpoint: { path: "test-control-endpoint", proxy: true },
  }), /ENOENT/);
});


test("live discovery reads all pages before fetching thread metadata", async (t) => {
  const { options, requests } = await controlServer(t, {
    respond(socket, request) {
      let result = {};
      if (request.method === "thread/loaded/list") {
        result = request.params.cursor
          ? { data: ["second"], nextCursor: null }
          : { data: ["first"], nextCursor: "page-two" };
      }
      if (request.method === "thread/read") result = { thread: { id: request.params.threadId, cwd: process.cwd() } };
      socket.write(frame(JSON.stringify({ id: request.id, result })));
    },
  });
  const listed = await listCodexSessions({ ...options, loadedCodexThreads: undefined });
  assert.deepEqual(listed.map((thread) => thread.id), ["first", "second"]);
  assert.deepEqual(requests.filter((request) => request.method === "thread/loaded/list").map((request) => request.params.cursor), [undefined, "page-two"]);
});

test("a repeated discovery cursor stops pagination and permits registry fallback", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-peer-pagination-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const { options, requests } = await controlServer(t, {
    respond(socket, request) {
      const result = request.method === "thread/loaded/list" ? { data: [], nextCursor: "same-page" } : {};
      socket.write(frame(JSON.stringify({ id: request.id, result })));
    },
  });
  const listed = await listCodexSessions({ ...options, loadedCodexThreads: undefined, codexHome });
  assert.deepEqual(listed, []);
  assert.equal(requests.filter((request) => request.method === "thread/loaded/list").length, 2);
});

for (const delivery of [undefined, "steer"]) {
  for (const failure of ["disconnect", "timeout", "malformed reply"]) {
    test(`${delivery || "native"} delivery never queues after submission followed by ${failure}`, async (t) => {
      let submitted = 0;
      const { options } = await controlServer(t, {
        respond(socket, request) {
          if (["turn/start", "turn/steer"].includes(request.method)) {
            submitted++;
            if (failure === "disconnect") socket.destroy();
            if (failure === "malformed reply") socket.write(frame(JSON.stringify({ id: request.id })));
            return;
          }
          let result = {};
          if (request.method === "thread/loaded/list") result = { data: ["test-thread"] };
          if (request.method === "thread/turns/list") result = { data: [{ id: "active-turn", status: "inProgress" }] };
          socket.write(frame(JSON.stringify({ id: request.id, result })));
        },
      });
      await assert.rejects(sendCodex("test-thread", "test", "hello", {
        ...options,
        delivery,
        timeoutMs: 100,
        queueCodex: async () => assert.fail("must not queue an ambiguously delivered message"),
      }), { code: "DELIVERY_UNKNOWN" });
      assert.equal(submitted, 1);
    });
  }
}

for (const delivery of [undefined, "steer"]) {
  test(`${delivery || "native"} delivery still queues after an explicit rejection`, async (t) => {
    const { options } = await controlServer(t, {
      respond(socket, request) {
        if (["turn/start", "turn/steer"].includes(request.method)) {
          socket.write(frame(JSON.stringify({ id: request.id, error: { message: "unsupported request" } })));
          return;
        }
        let result = {};
        if (request.method === "thread/loaded/list") result = { data: ["test-thread"] };
        if (request.method === "thread/turns/list") result = { data: [{ id: "active-turn", status: "inProgress" }] };
        socket.write(frame(JSON.stringify({ id: request.id, result })));
      },
    });
    let queued = 0;
    const result = await sendCodex("test-thread", "test", "hello", {
      ...options,
      delivery,
      queueCodex: async () => { queued++; return { queueItemId: "queued" }; },
    });
    assert.equal(result.delivery, "queued");
    assert.equal(queued, 1);
  });
}

test("a noisy proxy rejects through the shared subprocess output limit", async (t) => {
  const { options } = await controlServer(t);
  await assert.rejects(sendCodex("test-thread", "test", "hello", {
    ...options,
    codexBin: process.execPath,
    codexProxyArgs: ["-e", "process.stderr.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
    codexWebSocketEndpoint: { path: "test-control-endpoint", proxy: true },
    maxOutputBytes: 100,
    killGraceMs: 50,
  }), /output exceeded/);
});
