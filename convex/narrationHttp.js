import { httpActionGeneric, makeFunctionReference as ref } from "convex/server";
export const narrationArtifact = httpActionGeneric(async (ctx, request) => {
  const headers = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  };
  try {
    const url = new URL(request.url);
    const file = await ctx.runQuery(ref("narration:authorizeRead"), {
      token: (request.headers.get("authorization") || "").replace(
        /^Bearer /,
        "",
      ),
      mode: url.searchParams.get("mode") || "",
      jobId: url.searchParams.get("jobId") || "",
      revisionId: url.searchParams.get("revisionId") || "",
      path: url.searchParams.get("path") || "",
      workerId: request.headers.get("x-bebebonjour-worker-id") || "",
      commandId: request.headers.get("x-bebebonjour-command-id") || "",
      leaseToken: request.headers.get("x-bebebonjour-lease-token") || "",
    });
    const blob = await ctx.storage.get(file.storageId);
    if (!blob || blob.size !== file.bytes) throw new Error("Unavailable.");
    return new Response(blob, {
      headers: {
        ...headers,
        "content-type": file.path.endsWith(".mp3")
          ? "audio/mpeg"
          : "application/json",
        "content-length": String(file.bytes),
      },
    });
  } catch {
    return new Response("Narration unavailable.", { status: 403, headers });
  }
});
