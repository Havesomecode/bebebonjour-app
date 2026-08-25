import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const createJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const existing = await findJob(context, args.jobId);
    if (existing) return { created: false, aggregate: existing.aggregate };
    await context.db.insert("fulfillmentJobs", {
      jobId: args.jobId,
      aggregate: args.aggregate,
    });
    return { created: true, aggregate: args.aggregate };
  },
});

export const getJob = queryGeneric({
  args: { backendToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    const document = await findJob(context, args.jobId);
    return document?.aggregate || null;
  },
});

export const saveReviewApproval = mutationGeneric({
  args: {
    backendToken: v.string(),
    approval: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertReviewApproval(args.approval);
    const existing = await findReviewApproval(context, args.approval.approvalId);
    if (existing) return { created: false, approval: existing.approval };
    await context.db.insert("fulfillmentReviewApprovals", {
      approvalId: args.approval.approvalId,
      approval: args.approval,
    });
    return { created: true, approval: args.approval };
  },
});

export const getReviewApproval = queryGeneric({
  args: { backendToken: v.string(), approvalId: v.string() },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertApprovalId(args.approvalId);
    const document = await findReviewApproval(context, args.approvalId);
    return document?.approval || null;
  },
});

export const replaceJob = mutationGeneric({
  args: {
    backendToken: v.string(),
    jobId: v.string(),
    expectedVersion: v.number(),
    aggregate: v.any(),
  },
  handler: async (context, args) => {
    assertBackendToken(args.backendToken);
    assertAggregateIdentity(args.jobId, args.aggregate);
    const document = await findJob(context, args.jobId);
    if (!document) return { updated: false, current: null };
    if (document.aggregate.version !== args.expectedVersion) {
      return { updated: false, current: document.aggregate };
    }
    if (args.aggregate.version !== args.expectedVersion + 1) {
      throw new Error("Fulfillment replacement must increment version exactly once.");
    }
    await context.db.patch(document._id, { aggregate: args.aggregate });
    return { updated: true, aggregate: args.aggregate };
  },
});

function findJob(context, jobId) {
  return context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findReviewApproval(context, approvalId) {
  return context.db
    .query("fulfillmentReviewApprovals")
    .withIndex("by_approval_id", (query) => query.eq("approvalId", approvalId))
    .unique();
}

function assertAggregateIdentity(jobId, aggregate) {
  if (!aggregate || aggregate.jobId !== jobId) {
    throw new Error("Fulfillment aggregate must preserve the canonical job id.");
  }
}

function assertReviewApproval(approval) {
  const allowedFields = ["schemaVersion", "approvalId", "binding", "decision", "signature"];
  assertOnlyFields(approval, allowedFields);
  assertOnlyFields(
    approval.binding,
    ["jobId", "intakeDigest", "environment", "product", "revisionId", "runId", "artifactManifestDigest"],
  );
  assertOnlyFields(approval.decision, [
    "commandId",
    "decisionType",
    "revisionId",
    "outcome",
    "policyVersion",
    "rubricVersion",
    "reviewer",
    "decidedAt",
    "artifactDigests",
    "reasons",
  ]);
  if (approval.decision.reviewer) {
    assertOnlyFields(approval.decision.reviewer, ["id", "role", "competencies"]);
  }
  if (approval.decision.artifactDigests) {
    assertOnlyFields(
      approval.decision.artifactDigests,
      ["pageDigest", "transcriptDigest", "assetManifestDigest"],
    );
  }
  assertApprovalId(approval?.approvalId);
  if (
    approval.schemaVersion !== "1.0"
    || !approval.binding
    || !approval.decision
    || typeof approval.signature !== "string"
    || !/^[a-f0-9]{64}$/.test(approval.signature)
  ) {
    throw new Error("Fulfillment review approval is invalid.");
  }
}

function assertOnlyFields(value, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((field) => !allowedFields.includes(field))) {
    throw new Error("Fulfillment review approval contains unexpected fields.");
  }
}

function assertApprovalId(value) {
  if (typeof value !== "string" || !/^approval_[a-f0-9]{24}$/.test(value)) {
    throw new Error("Fulfillment review approval id is invalid.");
  }
}

function assertBackendToken(value) {
  const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Customer-flow backend authorization failed.");
  }
}
