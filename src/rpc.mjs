// The transports supply encoding; request IDs, replies, deadlines, and failure
// propagation have the same lifecycle for both WebSocket and stdio.
export function createRpcClient(send, timeoutMs = 10_000) {
  let nextId = 1;
  let failure;
  const pending = new Map();

  function settle(id, error, result) {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timeout);
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }

  function close(error = new Error("codex app-server connection finished")) {
    failure ||= error;
    for (const id of pending.keys()) settle(id, failure);
  }

  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(() => {
        settle(id, new Error(`timed out waiting for codex app-server method ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try {
        send({ id, method, params });
      } catch (error) {
        close(error);
      }
    });
  }

  function receive(payload) {
    let message;
    try { message = JSON.parse(payload); } catch { return; }
    if (message?.id == null) return;
    const error = message.error
      ? new Error(message.error.message || JSON.stringify(message.error))
      : null;
    settle(message.id, error, message.result);
  }

  function notify(method, params) {
    if (failure) throw failure;
    send({ method, params });
  }

  return { request, receive, notify, close };
}
