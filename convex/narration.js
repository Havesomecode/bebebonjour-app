import {
  internalQueryGeneric,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import {
  assertNarrationToken,
  assertNarrationCommand,
} from "./narrationScope.js";
import { enqueuePaidNarrationProgression } from "./operations.js";
export const insertFictionalTest = internalMutationGeneric({
  args: { operatorToken: v.string(), aggregate: v.any(), language: v.string() },
  handler: async (ctx, args) => {
    assertTestOperator(args.operatorToken);
    const aggregate = args.aggregate;
    if (
      aggregate.product !== "operator_narration_test" ||
      aggregate.state !== "content_review_required" ||
      aggregate.payment !== null
    )
      throw new Error("Invalid fictional test.");
    if (
      await ctx.db
        .query("fulfillmentJobs")
        .withIndex("by_job_id", (q) => q.eq("jobId", aggregate.jobId))
        .unique()
    )
      throw new Error("Test job exists.");
    await verifyStoredArtifact(ctx, aggregate.artifactSets[0]);
    const job = {
      schemaVersion: "1.0",
      jobId: aggregate.jobId,
      version: 1,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt,
      intakeDigest: aggregate.artifactSets[0].pageDigest,
      intake: {
        baby: { firstName: "Fictional narration test" },
        languages: [args.language],
        voicePreference: { enabled: true, gender: "male" },
        request:
          "Fictional operator-authored narration check; not a paid order or Codex generation proof.",
      },
      payment: { status: "not_applicable", paidAt: null, checkout: null },
      events: [],
    };
    await ctx.db.insert("customerFlowJobs", { jobId: job.jobId, job });
    await ctx.db.insert("fulfillmentJobs", { jobId: job.jobId, aggregate });
    return { jobId: job.jobId };
  },
});
export function assertTestOperator(token) {
  if (
    process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED !== "true" ||
    !token ||
    token.length < 32 ||
    token !== process.env.BEBEBONJOUR_OPERATIONS_TOKEN ||
    token === process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN
  )
    throw new Error("Fictional test creation disabled or unauthorized.");
}
export const authorityArgs = {
  workerToken: v.string(),
  workerId: v.string(),
  commandId: v.string(),
  leaseToken: v.string(),
  jobId: v.string(),
};
export async function claimed(context, args, { effect = false } = {}) {
  assertNarrationToken(args.workerToken);
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
    .unique();
  assertNarrationCommand(command, args);
  if (
    command.jobId !== args.jobId ||
    command.state !== "running" ||
    command.claim?.workerId !== args.workerId ||
    command.claim?.leaseToken !== args.leaseToken ||
    command.claim.leaseExpiresAtMs <= Date.now() ||
    (effect && !Number.isFinite(command.claim.effectStartedAtMs))
  )
    throw new Error("Inactive narration claim.");
  const document = await context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
    .unique();
  if (!document || document.aggregate.narrationRequired !== true)
    throw new Error("Narration must be requested on the canonical job.");
  return { command, document };
}
export const readClaim = internalQueryGeneric({
  args: authorityArgs,
  handler: async (ctx, args) => {
    const { command, document } = await claimed(ctx, args);
    return { command, job: document.aggregate };
  },
});
// No public arbitrary aggregate replacement. Only the server-side canonical reducer action calls this CAS.
export const commitTransition = internalMutationGeneric({
  args: { ...authorityArgs, expectedVersion: v.number(), aggregate: v.any() },
  handler: async (ctx, args) => {
    const { command, document } = await claimed(ctx, args);
    if (
      document.aggregate.version !== args.expectedVersion ||
      args.aggregate.version !== args.expectedVersion + 1
    )
      throw new Error("Narration version conflict.");
    for (const artifact of args.aggregate.artifactSets.slice(
      document.aggregate.artifactSets.length,
    ))
      await verifyStoredArtifact(ctx, artifact);
    await enqueuePaidNarrationProgression(ctx, command, document.aggregate, args.aggregate);
    await ctx.db.patch(document._id, { aggregate: args.aggregate });
    return null;
  },
});
export const createUploadUrl = mutationGeneric({
  args: authorityArgs,
  handler: async (ctx, args) => {
    const { command, document } = await claimed(ctx, args, { effect: true });
    if (
      command.action !== "generate_narration" ||
      document.aggregate.state !== "tts_generating"
    )
      throw new Error("Only fenced narration may upload.");
    return ctx.storage.generateUploadUrl();
  },
});
export const readPrepared = queryGeneric({
  args: authorityArgs,
  handler: async (ctx, args) => {
    const { command, document } = await claimed(ctx, args);
    if (command.action !== "generate_narration")
      throw new Error("Narration input scope rejected.");
    return latest(document.aggregate, "prepared_bundle");
  },
});
export const authorizeRead = internalQueryGeneric({
  args: {
    token: v.string(),
    mode: v.string(),
    jobId: v.string(),
    revisionId: v.string(),
    path: v.string(),
    commandId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    let job;
    if (args.mode === "worker") {
      const { command, document } = await claimed(ctx, {
        ...args,
        workerToken: args.token,
      });
      if (command.action !== "generate_narration")
        throw new Error("Read scope rejected.");
      job = document.aggregate;
    } else if (args.mode === "operator") {
      const expected = process.env.BEBEBONJOUR_OPERATIONS_TOKEN;
      if (!expected || expected.length < 32 || args.token !== expected)
        throw new Error("Unauthorized.");
      job = (
        await ctx.db
          .query("fulfillmentJobs")
          .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
          .unique()
      )?.aggregate;
    } else throw new Error("Read mode rejected.");
    if (!job || job.currentRevisionId !== args.revisionId)
      throw new Error("Stale narration revision.");
    const artifact = latest(
      job,
      args.mode === "worker"
        ? "prepared_bundle"
        : args.path === "artifacts/current/page.json"
          ? "private_review"
          : "narration_review",
    );
    const file = artifact?.files.find((f) => f.path === args.path);
    if (
      !file ||
      (args.mode === "operator" &&
        !/^artifacts\/(audio\/[a-z]{2}\/[A-Za-z0-9_-]+\.mp3|transcript\.json|current\/page\.json)$/.test(
          file.path,
        ))
    )
      throw new Error("File scope rejected.");
    return file;
  },
});
export function latest(job, kind) {
  return [...job.artifactSets]
    .reverse()
    .find((a) => a.kind === kind && a.revisionId === job.currentRevisionId);
}
async function verifyStoredArtifact(ctx, artifact) {
  if (
    !Array.isArray(artifact.files) ||
    !artifact.files.length ||
    artifact.files.length > 2048
  )
    throw new Error("Invalid artifact inventory.");
  let bytes = 0;
  const paths = new Set();
  for (const file of artifact.files) {
    if (
      Object.keys(file).sort().join() !== "bytes,path,sha256,storageId" ||
      typeof file.path !== "string" ||
      file.path.length > 512 ||
      file.path.includes("\\") ||
      file.path.split("/").some((p) => !p || p === "." || p === "..") ||
      paths.has(file.path) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid artifact file.");
    paths.add(file.path);
    bytes += file.bytes;
    if (bytes > 64 * 1024 * 1024)
      throw new Error("Artifact inventory too large.");
    const id = ctx.db.system.normalizeId("_storage", file.storageId);
    const meta = id ? await ctx.db.system.get(id) : null;
    const base64 = btoa(
      String.fromCharCode(
        ...file.sha256.match(/../g).map((x) => parseInt(x, 16)),
      ),
    );
    if (
      !meta ||
      meta.size !== file.bytes ||
      (meta.sha256 !== file.sha256 && meta.sha256 !== base64)
    )
      throw new Error("Durable artifact integrity mismatch.");
  }
}
