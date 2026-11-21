// Only for fixed bridge-owned requests. Never copy hosted request metadata.
export function invokeInternalRequest({ child, request, pending, reservedIds, timeoutMs }) {
  const id = request.id;
  if (reservedIds.has(id) || reservedIds.size >= 1024) return Promise.reject(Error("INTERNAL_REQUEST_LIMIT"));
  reservedIds.add(id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Keep the reservation until the late response or child exit. Otherwise a
      // private action response could be forwarded to the hosted MCP client.
      reject(Error("Browser action timed out"));
    }, Math.max(1, timeoutMs));
    pending.set(id, {
      resolve: message => { clearTimeout(timer); resolve(message); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    const failWrite = error => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      // A partial write can still produce a response: retain the tombstone.
      reject(error);
    };
    try { child.stdin.write(JSON.stringify(request) + "\n", failWrite); }
    catch (error) { failWrite(error); }
  });
}

export function consumeInternalResponse(message, pending, reservedIds) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      !reservedIds.has(message.id) || typeof message.method === "string" ||
      (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) return false;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  reservedIds.delete(message.id);
  waiter?.resolve(message);
  return true;
}
