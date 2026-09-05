import crypto from "node:crypto";
import readline from "node:readline";

const status = process.env.FAKE_CODEX_STATUS || "idle";
const threadId = process.env.FAKE_CODEX_THREAD_ID;
const lines = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id == null) return;
  if (frame.method === "initialize") respond(frame.id, { userAgent: "fake" });
  else if (frame.method === "thread/list") respond(frame.id, {
    data: process.env.FAKE_CODEX_THREADS ? JSON.parse(process.env.FAKE_CODEX_THREADS) : [{ id: threadId, name: "fake-codex", status: { type: status }, cwd: process.cwd(), updatedAt: 1, source: "cli", parentThreadId: null }],
    nextCursor: null,
  });
  else if (frame.method === "thread/loaded/list") respond(frame.id, {
    data: [threadId],
    nextCursor: null,
  });
  else if (frame.method === "thread/read") respond(frame.id, {
    thread: { id: threadId, name: "fake-codex", status: { type: status }, cwd: process.cwd(), updatedAt: 1 },
  });
  else if (frame.method === "thread/turns/list") respond(frame.id, {
    data: [{ id: "turn-active", status: "inProgress", items: [] }],
    nextCursor: null,
  });
  else if (frame.method === "turn/steer") {
    if (frame.params.expectedTurnId !== "turn-active") throw new Error("wrong expected turn");
    respond(frame.id, { turnId: "turn-active" });
  } else if (frame.method === "thread/queue/add") respond(frame.id, {
    queuedSubmission: { id: crypto.randomUUID(), clientUserMessageId: frame.params.clientUserMessageId, input: frame.params.input },
  });
  else process.stdout.write(`${JSON.stringify({ id: frame.id, error: { message: `unexpected method ${frame.method}` } })}\n`);
});
