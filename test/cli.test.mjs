import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/agent-peer.mjs";

for (const host of ["claude", "codex"]) {
  test(`${host} CLI accepts local/all listings and preserves message arguments`, () => {
    assert.deepEqual(parseCliArgs([host, "list"]), { host, command: "list", all: false });
    assert.deepEqual(parseCliArgs([host, "list", "--all"]), { host, command: "list", all: true });
    const operands = ["exact recipient", "summary", "line one\nline two --queue"];
    assert.deepEqual(parseCliArgs([host, "send", ...operands]), { host, command: "send", operands });
  });
}

test("Codex delivery flags are parsed only in the option position", () => {
  const operands = ["recipient", "summary", "message"];
  for (const delivery of ["native", "queue", "steer"]) {
    assert.deepEqual(parseCliArgs(["codex", "send", `--${delivery}`, ...operands]), {
      host: "codex", command: "send", operands, delivery,
    });
  }
  assert.deepEqual(parseCliArgs(["codex", "send", "--queue", "summary", "message"]).operands, ["--queue", "summary", "message"]);
});

test("CLI rejects unknown hosts, commands, flags, and incorrect argument counts", () => {
  for (const args of [
    [], ["other", "list"], ["codex", "unknown"],
    ["claude", "list", "extra"], ["codex", "list", "--all", "extra"],
    ["codex", "send", "recipient", "summary"],
    ["claude", "send", "--queue", "recipient", "summary", "message"],
    ["codex", "send", "--unknown", "recipient", "summary", "message"],
  ]) assert.equal(parseCliArgs(args), null, JSON.stringify(args));
});
