import { spawn } from "node:child_process";

// All subprocesses use the same Node lifecycle, including the stock proxy.
// Completion always resolves, so cleanup cannot replace a delivery outcome.
export function superviseProcess(child, onFailure, options = {}) {
  const timeoutMs = options.processTimeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const killGraceMs = options.killGraceMs ?? 1_000;
  let error;
  let outputBytes = 0;
  let stopping = false;
  let finished = false;
  let forceTimer;
  let abandonTimer;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const deadline = setTimeout(() => fail(new Error(`subprocess timed out after ${timeoutMs}ms`)), timeoutMs);

  function finish(code = child.exitCode, signal = child.signalCode) {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    clearTimeout(forceTimer);
    clearTimeout(abandonTimer);
    resolveClosed({ code, signal, error });
  }

  function stop() {
    if (stopping || finished) return closed;
    stopping = true;
    clearTimeout(deadline);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill();
    forceTimer = setTimeout(() => {
      child.kill("SIGKILL");
      abandonTimer = setTimeout(() => {
        // Do not keep the CLI alive if the OS cannot complete termination.
        child.unref();
        finish();
      }, killGraceMs);
    }, killGraceMs);
    return closed;
  }

  function fail(cause) {
    if (error || finished || stopping) return;
    error = cause;
    stop();
    onFailure(cause);
  }

  child.once("error", fail);
  child.once("close", finish);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", fail);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) fail(new Error(`subprocess output exceeded ${maxOutputBytes} bytes`));
    });
  }
  return { closed, stop, get error() { return error; } };
}

export async function spawnCapture(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: options.env || process.env,
  });
  const managed = superviseProcess(child, () => {}, options);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { if (!managed.error) stdout += chunk; });
  child.stderr.on("data", (chunk) => { if (!managed.error) stderr += chunk; });
  const { code, signal, error } = await managed.closed;
  if (!error && code === 0) return { stdout, stderr };
  const failure = error || new Error(`${command} exited with ${signal || code}: ${stderr.trim() || stdout.trim()}`);
  failure.commandStarted = child.pid !== undefined;
  throw failure;
}
