import router from "./routes.js";

export function createHttpHandler(runtime, { interest } = {}) {
  return async request => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/version") return Response.json({ ok: true });
    const match = /^\/api\/(query|mutation|action)$/.exec(url.pathname);
    if (request.method === "POST" && match) {
      try {
        const reader = request.body?.getReader(); const chunks = []; let size = 0;
        if (reader) for (;;) { const {value, done} = await reader.read(); if (done) break; size += value.byteLength; if (size > 8 * 1024 * 1024) { await reader.cancel(); return new Response("Payload too large", {status:413}); } chunks.push(value); }
        const body = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString());
        if (!Array.isArray(body.args) || body.args.length !== 1 || typeof body.path !== "string") throw new Error("invalid_request");
        const value = await runtime.call(match[1], body.path, body.args[0], false);
        return Response.json({status:"success", value:value, logLines:[]});
      } catch (error) { return Response.json({status:"error", errorMessage: error.name === "ArgumentValidationError" ? "Error ArgumentValidationError" : `Uncaught Error: ${error.message}`, logLines:[]}); }
    }
    if (interest && url.pathname.startsWith("/interest/")) return interest.handle(request);
    if (url.pathname !== "/delivery" && !url.pathname.startsWith("/delivery/") && !url.pathname.startsWith("/announcements/")) return new Response("Not found", {status:404});
    const handler = router.lookup(url.pathname, request.method)?.[0];
    if (!handler) return new Response("Not found", {status:404});
    try { return await handler.handler(runtime.actionContext(), request); } catch { return new Response("Internal server error", {status:500}); }
  };
}
