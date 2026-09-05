import assert from "node:assert/strict";
import test from "node:test";
import { createRpcClient } from "../src/rpc.mjs";

test("RPC correlates out-of-order replies and ignores unrelated input", async () => {
  const sent = [];
  const rpc = createRpcClient((message) => sent.push(message));
  const first = rpc.request("first", {});
  const second = rpc.request("second", {});
  for (const payload of ["null", "not JSON", '{"method":"notification"}', '{"id":999,"result":0}']) rpc.receive(payload);
  rpc.receive(JSON.stringify({ id: sent[1].id, result: "second result" }));
  rpc.receive(JSON.stringify({ id: sent[0].id, result: "first result" }));
  assert.deepEqual(await Promise.all([first, second]), ["first result", "second result"]);
  rpc.close();
});

test("RPC errors reject only their matching request", async () => {
  const sent = [];
  const rpc = createRpcClient((message) => sent.push(message));
  const failed = assert.rejects(rpc.request("failed", {}), /request rejected/);
  const successful = rpc.request("successful", {});
  rpc.receive(JSON.stringify({ id: sent[0].id, error: { message: "request rejected" } }));
  rpc.receive(JSON.stringify({ id: sent[1].id, result: true }));
  await failed;
  assert.equal(await successful, true);
  rpc.close();
});

test("closing RPC rejects outstanding and future requests with the original failure", async () => {
  let writes = 0;
  const rpc = createRpcClient(() => { writes++; });
  const error = new Error("connection lost");
  const first = assert.rejects(rpc.request("first", {}), (actual) => actual === error);
  const second = assert.rejects(rpc.request("second", {}), (actual) => actual === error);
  rpc.close(error);
  rpc.close(new Error("cleanup"));
  await Promise.all([first, second]);
  await assert.rejects(rpc.request("later", {}), (actual) => actual === error);
  assert.throws(() => rpc.notify("later", {}), (actual) => actual === error);
  assert.equal(writes, 2);
});

test("a synchronous transport write failure closes RPC without leaving pending requests", async () => {
  const rpc = createRpcClient(() => { throw new Error("write failed"); });
  await assert.rejects(rpc.request("first", {}), /write failed/);
  await assert.rejects(rpc.request("second", {}), /write failed/);
});

test("late replies after a deadline do not interfere with subsequent requests", async () => {
  const sent = [];
  const rpc = createRpcClient((message) => sent.push(message), 20);
  await assert.rejects(rpc.request("slow", {}), /timed out.*slow/);
  const next = rpc.request("next", {});
  rpc.receive(JSON.stringify({ id: sent[0].id, result: "late" }));
  rpc.receive(JSON.stringify({ id: sent[1].id, result: "on time" }));
  assert.equal(await next, "on time");
  rpc.close();
});
