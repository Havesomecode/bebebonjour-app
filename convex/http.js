import {
  httpActionGeneric,
  httpRouter,
  makeFunctionReference,
} from "convex/server";

const MAX_PRIVATE_ARTIFACT_BYTES = 20 * 1024 * 1024;
const authorizeArtifactRead = makeFunctionReference("generation:authorizeArtifactRead");
const authorizeCompletionArtifactRead = makeFunctionReference("fulfillment:authorizeCompletionArtifactRead");
import { narrationArtifact } from "./narrationHttp.js";
import { intakePage, intakeSubmit, reviewPage, reviewSubmit, announcement, privatePreview, operatorPage, operatorSubmit } from "./deliveryLoopHttp.js";

const http = httpRouter();
import { dataControl, dataExport, dataOperatorPage, dataOperatorControl } from "./deliveryLoopDataHttp.js";
http.route({ path: "/delivery/data", method: "POST", handler: dataControl });
http.route({ path: "/delivery/export", method: "GET", handler: dataExport });
http.route({ path: "/delivery/data/operator", method: "GET", handler: dataOperatorPage });
http.route({ path: "/delivery/data/operator", method: "POST", handler: dataOperatorControl });
http.route({ path: "/delivery", method: "GET", handler: intakePage });
http.route({ path: "/delivery/intake", method: "POST", handler: intakeSubmit });
http.route({ path: "/delivery/review", method: "GET", handler: reviewPage });
http.route({ path: "/delivery/review", method: "POST", handler: reviewSubmit });
http.route({ path: "/delivery/preview", method: "GET", handler: privatePreview });
http.route({ path: "/delivery/operator", method: "GET", handler: operatorPage });
http.route({ path: "/delivery/operator", method: "POST", handler: operatorSubmit });
http.route({ pathPrefix: "/announcements/", method: "GET", handler: announcement });
http.route({path:"/narration/artifact",method:"GET",handler:narrationArtifact});

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
