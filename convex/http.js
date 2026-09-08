import {
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
} from "convex/server";

const MAX_PRIVATE_ARTIFACT_BYTES = 20 * 1024 * 1024;
const authorizeArtifactRead = makeFunctionReference("generation:authorizeArtifactRead");
const authorizeCompletionArtifactRead = makeFunctionReference("fulfillment:authorizeCompletionArtifactRead");
const http = httpRouter();

http.route({
  path: "/generation/artifact",
  method: "GET",
  handler: httpActionGeneric(async (context, request) => {
    try {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") || "";
      const file = await context.runQuery(authorizeArtifactRead, {
        workerToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
        workerId: request.headers.get("x-bebebonjour-worker-id") || "",
        commandId: request.headers.get("x-bebebonjour-command-id") || "",
        leaseToken: request.headers.get("x-bebebonjour-lease-token") || "",
        jobId: url.searchParams.get("jobId") || "",
        revisionId: url.searchParams.get("revisionId") || "",
        kind: url.searchParams.get("kind") || "",
        path: url.searchParams.get("path") || "",
      });
      if (file.bytes > MAX_PRIVATE_ARTIFACT_BYTES) {
        return privateResponse("artifact_too_large", 413);
      }
      const blob = await context.storage.get(file.storageId);
      if (blob === null || blob.size !== file.bytes) {
        return privateResponse("artifact_unavailable", 404);
      }
      return new Response(blob, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-length": String(blob.size),
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return privateResponse("forbidden", 403);
    }
  }),
});

http.route({
  path: "/completion/artifact",
  method: "GET",
  handler: httpActionGeneric(async (context, request) => {
    try {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") || "";
      const file = await context.runQuery(authorizeCompletionArtifactRead, {
        completionToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
        workerId: request.headers.get("x-bebebonjour-worker-id") || "",
        commandId: request.headers.get("x-bebebonjour-command-id") || "",
        leaseToken: request.headers.get("x-bebebonjour-lease-token") || "",
        jobId: url.searchParams.get("jobId") || "",
        revisionId: url.searchParams.get("revisionId") || "",
        storageId: url.searchParams.get("storageId") || "",
      });
      if (file.bytes > MAX_PRIVATE_ARTIFACT_BYTES) {
        return privateResponse("artifact_too_large", 413);
      }
      const blob = await context.storage.get(file.storageId);
      if (blob === null || blob.size !== file.bytes) {
        return privateResponse("artifact_unavailable", 404);
      }
      return new Response(blob, {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-length": String(blob.size),
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return privateResponse("forbidden", 403);
    }
  }),
});

function privateResponse(code, status) {
  return new Response(JSON.stringify({ status: "error", code }), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export default http;
