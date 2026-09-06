import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { spawnCapture, superviseProcess } from "../src/process.mjs";

const options = { processTimeoutMs: 1_000, killGraceMs: 50 };

test("captured subprocess output preserves UTF-8 and separate streams", async () => {
  const result = await spawnCapture(process.execPath, ["-e", 'process.stdout.write("hello 🍀"); process.stderr.write("diagnostic")'], options);
  assert.deepEqual(result, { stdout: "hello 🍀", stderr: "diagnostic" });
});

test("a stalled subprocess hits its deadline and is reaped", async () => {
  await assert.rejects(spawnCapture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    ...options, processTimeoutMs: 100,
  }), /subprocess timed out/);
});

for (const stream of ["stdout", "stderr"]) {
  test(`subprocess ${stream} is bounded even without a newline`, async () => {
    await assert.rejects(spawnCapture(process.execPath, ["-e", `process.${stream}.write('x'.repeat(10000)); setInterval(() => {}, 1000)`], {
      ...options, maxOutputBytes: 100,
    }), /output exceeded 100 bytes/);
  });
}

test("nonzero exit and missing executables fail promptly", async () => {
  await assert.rejects(spawnCapture(process.execPath, ["-e", 'process.stderr.write("failed"); process.exit(2)'], options), /exited with 2: failed/);
  await assert.rejects(spawnCapture("agent-peer-nonexistent-test-executable", [], options), { code: "ENOENT" });
});

test("cleanup is idempotent and bounded for a process that ignores graceful termination", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const managed = superviseProcess(child, (error) => assert.fail(error.message), options);
  await once(child.stdout, "data");
  const first = managed.stop();
  assert.equal(managed.stop(), first);
  await first;
  assert.ok(child.exitCode !== null || child.signalCode !== null, "child termination was observed");
});
