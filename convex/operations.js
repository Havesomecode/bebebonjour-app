import { mutationGeneric, paginationOptsValidator, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { TEST_A_PREPARE_REVIEW_RETRY_POLICY } from "../src/fulfillment/test-a-generation-policy.mjs";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const COMMAND_ID = /^command_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const ACTOR_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u;
const REASON_CODE = /^[a-z0-9][a-z0-9_]{2,63}$/u;
const SOURCE_HASH = /^[a-f0-9]{64}$/u;
const SOURCE_WINDOW_MS = 15 * 60 * 1_000;
const SOURCE_LIMIT = 8;
const SOURCE_BLOCK_MS = 15 * 60 * 1_000;
const GLOBAL_WINDOW_MS = 60 * 1_000;
const GLOBAL_LIMIT = 300;
const GLOBAL_BLOCK_MS = 30 * 1_000;
const EXTERNAL_EFFECT_ACTIONS = new Set(["create_checkout", "generate", "generate_narration", "publish", "deliver"]);
const ACTIONS_BY_STATE = Object.freeze({
  awaiting_payment: Object.freeze(["create_checkout"]),
  generation_queued: Object.freeze(["generate"]),
  content_review_required: Object.freeze([
    "approve_content",
    "request_content_changes",
    "reject_content",
  ]),
  render_queued: Object.freeze(["render"]),
  narration_review_required: Object.freeze([
    "approve_narration",
    "request_narration_changes",
    "reject_narration",
  ]),
  tts_queued: Object.freeze(["generate_narration"]),
  publish_ready: Object.freeze(["publish"]),
  published: Object.freeze(["queue_delivery"]),
  delivery_queued: Object.freeze(["deliver"]),
  retry_wait: Object.freeze(["retry"]),
  reconciliation_required: Object.freeze(["reconcile"]),
});
const ALL_ACTIONS = new Set(Object.values(ACTIONS_BY_STATE).flat());
const PAYLOAD_FIELDS_BY_ACTION = Object.freeze({
  create_checkout: Object.freeze([]),
  generate: Object.freeze([]),
  render: Object.freeze([]),
  generate_narration: Object.freeze([]),
  approve_content: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests"]),
  request_content_changes: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests", "reasonCodes"]),
  reject_content: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests", "reasonCodes"]),
  approve_narration: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests"]),
  request_narration_changes: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests", "reasonCodes"]),
  reject_narration: Object.freeze(["revisionId", "artifactManifestDigest", "artifactDigests", "reasonCodes"]),
  publish: Object.freeze(["revisionId", "artifactManifestDigest"]),
  queue_delivery: Object.freeze(["revisionId", "publicationId", "artifactManifestDigest"]),
  deliver: Object.freeze(["revisionId", "publicationId", "artifactManifestDigest"]),
  retry: Object.freeze([]),
  reconcile: Object.freeze(["sourceCommandId", "providerStatus"]),
});
const SAFE_OUTCOME_FIELDS = new Set([
  "code",
  "jobVersion",
  "revisionId",
  "artifactSetId",
  "decisionId",
  "checkoutSessionId",
  "checkoutUrl",
  "publicationId",
  "deploymentId",
  "productionUrl",
  "deliveryAttemptId",
  "providerMessageId",
  "reconciledState",
  "sourceCommandId",
  "providerStatus",
]);
const OUTCOME_CONTRACT_BY_ACTION = Object.freeze({
  create_checkout: Object.freeze({ code: "checkout_available", fields: ["checkoutSessionId", "checkoutUrl", "code", "jobVersion"] }),
  generate: Object.freeze({ code: "review_prepared", fields: ["artifactSetId", "code", "jobVersion", "revisionId"] }),
  approve_content: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  request_content_changes: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  reject_content: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  render: Object.freeze({ code: "release_rendered", fields: ["artifactSetId", "code", "jobVersion", "revisionId"] }),
  generate_narration: Object.freeze({ code: "narration_prepared", fields: ["artifactSetId", "code", "jobVersion", "revisionId"] }),
  approve_narration: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  request_narration_changes: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  reject_narration: Object.freeze({ code: "review_recorded", fields: ["code", "decisionId", "jobVersion"] }),
  publish: Object.freeze({ code: "published", fields: ["code", "deploymentId", "jobVersion", "productionUrl", "publicationId"] }),
  queue_delivery: Object.freeze({ code: "delivery_queued", fields: ["code", "jobVersion"] }),
  deliver: Object.freeze({ code: "delivered", fields: ["code", "deliveryAttemptId", "jobVersion", "providerMessageId"] }),
  retry: Object.freeze({ code: "retry_scheduled", fields: ["code", "jobVersion"] }),
  reconcile: Object.freeze({
    code: "reconciled",
    fields: ["code", "jobVersion", "providerStatus", "reconciledState", "sourceCommandId"],
  }),
});

export const operatorHealth = queryGeneric({
  args: { operatorToken: v.string() },
  handler: async (_context, args) => {
    assertOperatorToken(args.operatorToken);
    return { protocolVersion: "1.0", scope: "operator" };
  },
});

export const workerHealth = queryGeneric({
  args: { workerToken: v.string() },
  handler: async (_context, args) => {
    assertWorkerToken(args.workerToken);
    return { protocolVersion: "1.0", scope: "worker" };
  },
});

export const consumeLoginAttempt = mutationGeneric({
  args: { rateLimitToken: v.string(), sourceHash: v.string() },
  handler: async (context, args) => {
    assertRateLimitToken(args.rateLimitToken);
    if (!SOURCE_HASH.test(args.sourceHash)) throw new Error("Login throttle source hash is invalid.");
    const nowMs = Date.now();
    const source = await consumeThrottleBucket(context, `source:${args.sourceHash}`, {
      nowMs,
      windowMs: SOURCE_WINDOW_MS,
      limit: SOURCE_LIMIT,
      blockMs: SOURCE_BLOCK_MS,
    });
    const global = source.allowed
      ? await consumeThrottleBucket(context, "global", {
          nowMs,
          windowMs: GLOBAL_WINDOW_MS,
          limit: GLOBAL_LIMIT,
          blockMs: GLOBAL_BLOCK_MS,
        })
      : { allowed: true, retryAfterMs: 0 };
    const retryAfterMs = Math.max(source.retryAfterMs, global.retryAfterMs);
    return {
      allowed: source.allowed && global.allowed,
      retryAfterSeconds: retryAfterMs > 0 ? Math.max(1, Math.ceil(retryAfterMs / 1_000)) : 0,
    };
  },
});

export const resetLoginThrottle = mutationGeneric({
  args: { rateLimitToken: v.string(), sourceHash: v.string() },
  handler: async (context, args) => {
    assertRateLimitToken(args.rateLimitToken);
    if (!SOURCE_HASH.test(args.sourceHash)) throw new Error("Login throttle source hash is invalid.");
    const existing = await findThrottleBucket(context, `source:${args.sourceHash}`);
    if (existing) {
      await context.db.patch(existing._id, {
        attempts: 0,
        blockedUntilMs: 0,
        windowStartedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
    }
    return { reset: true };
  },
});

export const listJobs = queryGeneric({
  args: {
    operatorToken: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (context, args) => {
    assertOperatorToken(args.operatorToken);
    if (!Number.isInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems < 1
      || args.paginationOpts.numItems > 50) {
      throw new Error("Operator page size must be between 1 and 50.");
    }
    const result = await context.db
      .query("customerFlowJobs")
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await Promise.all(result.page.map(async (document) => {
      const [fulfillment, reconciliationCommand] = await Promise.all([
        findFulfillmentJob(context, document.jobId),
        findReconciliationCommand(context, document.jobId),
      ]);
      return summarizeJob(document.job, fulfillment?.aggregate || null, reconciliationCommand);
    }));
    return { ...result, page };
  },
});

export const getJob = queryGeneric({
  args: { operatorToken: v.string(), jobId: v.string() },
  handler: async (context, args) => {
    assertOperatorToken(args.operatorToken);
    assertJobId(args.jobId);
    const [customerDocument, fulfillmentDocument, commandDocuments, reconciliationCommand, pendingCommands, runningCommands] = await Promise.all([
      findCustomerJob(context, args.jobId),
      findFulfillmentJob(context, args.jobId),
      context.db
        .query("customerFlowOperationsCommands")
        .withIndex("by_job_id_and_requested_at", (query) => query.eq("jobId", args.jobId))
        .order("desc")
        .paginate({ cursor: null, numItems: 100 }),
      findReconciliationCommand(context, args.jobId),
      findCommandsByState(context, args.jobId, "pending"),
      findCommandsByState(context, args.jobId, "running"),
    ]);
    if (!customerDocument || !fulfillmentDocument) return null;
    const customer = projectCustomerJob(customerDocument.job);
    const fulfillment = fulfillmentDocument.aggregate;
    const commandsHasMore = !commandDocuments.isDone;
    const commandCursor = commandsHasMore ? commandDocuments.continueCursor : null;
    const commands = commandDocuments.page.map(projectCommand);
    const activeActions = new Set([...pendingCommands, ...runningCommands].map((command) => command.action));
    return {
      summary: summarizeJob(customerDocument.job, fulfillment, reconciliationCommand),
      customer,
      fulfillment,
      commands,
      commandsHasMore,
      commandCursor,
      availableActions: (reconciliationCommand ? ["reconcile"] : availableActions(customerDocument.job, fulfillment))
        .filter((action) => !activeActions.has(action)),
    };
  },
});

export const listJobCommands = queryGeneric({
  args: {
    operatorToken: v.string(),
    jobId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (context, args) => {
    assertOperatorToken(args.operatorToken);
    assertJobId(args.jobId);
    if (!Number.isInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems < 1
      || args.paginationOpts.numItems > 50) {
      throw new Error("Operator command page size must be between 1 and 50.");
    }
    const result = await context.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_job_id_and_requested_at", (query) => query.eq("jobId", args.jobId))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(projectCommand) };
  },
});

export const requestCommand = mutationGeneric({
  args: {
    operatorToken: v.string(),
    commandId: v.string(),
    jobId: v.string(),
    action: v.string(),
    expectedState: v.string(),
    expectedVersion: v.number(),
    payload: v.any(),
  },
  handler: async (context, args) => {
    assertOperatorToken(args.operatorToken);
    const request = {
      ...args,
      requestedAt: new Date(Date.now()).toISOString(),
      requestedBy: "primary_operator",
    };
    assertCommandInput(request);
    const existingById = await findCommand(context, args.commandId);
    if (existingById) {
      if (!sameCommandBinding(existingById, request)) {
        throw new Error("Operator command id conflict.");
      }
      return { created: false, command: projectCommand(existingById) };
    }

    const [customerDocument, fulfillmentDocument, reconciliationCommand] = await Promise.all([
      findCustomerJob(context, args.jobId),
      findFulfillmentJob(context, args.jobId),
      findReconciliationCommand(context, args.jobId),
    ]);
    if (!customerDocument || !fulfillmentDocument) {
      throw new Error("Operator job was not found.");
    }
    const aggregate = fulfillmentDocument.aggregate;
    if (aggregate.state !== args.expectedState || aggregate.version !== args.expectedVersion) {
      throw new Error("Operator job changed; refresh before requesting work.");
    }
    const actions = reconciliationCommand ? ["reconcile"] : availableActions(customerDocument.job, aggregate);
    if (!actions.includes(args.action)) {
      throw new Error(`Operator action ${args.action} is not available while job is ${aggregate.state}.`);
    }
    if (args.action === "reconcile" && args.payload.sourceCommandId !== reconciliationCommand?.commandId) {
      throw new Error("Operator reconciliation must bind the latest unresolved command.");
    }
    assertCanonicalActionBinding(args.action, args.payload, aggregate);

    const commandsForActionVersion = await context.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_job_action_version", (query) => query
        .eq("jobId", args.jobId)
        .eq("action", args.action)
        .eq("expectedVersion", args.expectedVersion))
      .collect();
    const replacementSource = commandsForActionVersion.length === 1
      && isAuditedNoEffectGenerateFailure(commandsForActionVersion[0], aggregate)
      ? commandsForActionVersion[0]
      : null;
    const existingForVersion = args.action === "reconcile"
      ? commandsForActionVersion.find((command) => command.state !== "failed")
      : replacementSource ? null : commandsForActionVersion[0];
    if (existingForVersion) {
      if (!sameCommandBinding(existingForVersion, request)) {
        throw new Error("A different operator command already exists for this job version.");
      }
      return { created: false, command: projectCommand(existingForVersion) };
    }
    const conflictGroup = commandConflictGroup(args.action);
    if (conflictGroup) {
      const commandsForVersion = await context.db.query("customerFlowOperationsCommands")
        .withIndex("by_job_version", (query) => query
          .eq("jobId", args.jobId)
          .eq("expectedVersion", args.expectedVersion))
        .collect();
      if (commandsForVersion.some((command) => commandConflictGroup(command.action) === conflictGroup)) {
        throw new Error("An operator review decision already exists for this job version.");
      }
    }

    const command = {
      commandId: args.commandId,
      ...(replacementSource ? { supersedesCommandId: replacementSource.commandId } : {}),
      jobId: args.jobId,
      action: args.action,
      expectedState: args.expectedState,
      expectedVersion: args.expectedVersion,
      payload: args.payload,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      state: "pending",
      attempts: 0,
      claim: null,
      lastFailureReason: null,
      outcome: null,
      updatedAt: request.requestedAt,
    };
    await context.db.insert("customerFlowOperationsCommands", command);
    return { created: true, command: projectCommand(command) };
  },
});

export const claimCommands = mutationGeneric({
  args: {
    workerToken: v.string(),
    workerId: v.string(),
    actions: v.array(v.string()),
    limit: v.number(),
    leaseMs: v.number(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertWorkerClaimInput(args);
    if (args.actions.length === 0) return [];
    const nowMs = Date.now();
    const actions = [...args.actions].sort();
    const pending = (await Promise.all(actions.map((action) => context.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_state_action_requested_at", (query) => query
        .eq("state", "pending")
        .eq("action", action))
      .order("asc")
      .take(args.limit)))).flat();
    const running = (await Promise.all(actions.map((action) => context.db
      .query("customerFlowOperationsCommands")
      .withIndex("by_state_action_claim_lease_expiry", (query) => query
        .eq("state", "running")
        .eq("action", action)
        .lte("claim.leaseExpiresAtMs", nowMs))
      .order("asc")
      .take(args.limit)))).flat();
    const candidates = [...running, ...pending]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)
        || left.commandId.localeCompare(right.commandId))
      .slice(0, args.limit);
    const claimed = [];

    for (const command of candidates) {
      if (command.state === "running"
          && EXTERNAL_EFFECT_ACTIONS.has(command.action)
          && command.claim?.effectStartedAtMs !== undefined) {
        await context.db.patch(command._id, {
          state: "reconciliation_required",
          claim: null,
          lastFailureReason: "external_effect_lease_expired",
          updatedAt: new Date(nowMs).toISOString(),
        });
        continue;
      }
      if (command.state === "running" && command.claim?.effectStartedAtMs === undefined) {
        const fulfillment = await findFulfillmentJob(context, command.jobId);
        if (await closeRejectedGenerateStage(context, fulfillment, command, nowMs)) {
          await context.db.patch(command._id, {
            state: "failed",
            claim: null,
            lastFailureReason: "command_lease_expired",
            outcome: null,
            updatedAt: new Date(nowMs).toISOString(),
          });
          continue;
        }
      }
      if (command.action === "create_checkout") {
        const customer = await findCustomerJob(context, command.jobId);
        if (customer?.job?.payment?.checkout) {
          const checkoutOutcome = canonicalCheckoutOutcome(customer.job, command.commandId);
          const next = checkoutOutcome ? {
            state: "completed",
            claim: null,
            lastFailureReason: null,
            outcome: checkoutOutcome,
            updatedAt: new Date(nowMs).toISOString(),
          } : {
            state: "failed",
            claim: null,
            lastFailureReason: "checkout_target_already_exists",
            outcome: null,
            updatedAt: new Date(nowMs).toISOString(),
          };
          await context.db.patch(command._id, next);
          continue;
        }
      }
      const fulfillment = await findFulfillmentJob(context, command.jobId);
      const stateMatches = fulfillment
        && fulfillment.aggregate.state === command.expectedState
        && fulfillment.aggregate.version === command.expectedVersion;
      let bindingMatches = false;
      if (stateMatches) {
        try {
          assertCanonicalActionBinding(command.action, command.payload, fulfillment.aggregate);
          bindingMatches = true;
        } catch {
          bindingMatches = false;
        }
      }
      if (!stateMatches || !bindingMatches) {
        await context.db.patch(command._id, {
          state: "failed",
          claim: null,
          lastFailureReason: stateMatches ? "stale_action_binding" : "stale_job_state",
          updatedAt: new Date(nowMs).toISOString(),
        });
        continue;
      }
      const attempts = command.attempts + 1;
      const claim = {
        workerId: args.workerId,
        leaseToken: `lease_${crypto.randomUUID().replaceAll("-", "")}`,
        claimedAtMs: nowMs,
        leaseExpiresAtMs: nowMs + args.leaseMs,
      };
      await context.db.patch(command._id, {
        state: "running",
        attempts,
        claim,
        updatedAt: new Date(nowMs).toISOString(),
      });
      claimed.push(projectClaimedCommand({ ...command, state: "running", attempts, claim }));
    }
    return claimed;
  },
});

export const fenceCommand = mutationGeneric({
  args: {
    workerToken: v.string(),
    commandId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    leaseMs: v.number(),
    effectMayBeIssued: v.boolean(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertCommandId(args.commandId);
    assertWorkerId(args.workerId);
    if (!Number.isInteger(args.leaseMs) || args.leaseMs < 1_000 || args.leaseMs > 600_000) {
      throw new Error("Operator command fence lease is invalid.");
    }
    const nowMs = Date.now();
    const command = await findCommand(context, args.commandId);
    if (command?.state !== "running"
      || command.claim?.workerId !== args.workerId
      || command.claim?.leaseToken !== args.leaseToken) {
      return { active: false, command: null };
    }
    if (command.claim.leaseExpiresAtMs <= nowMs) {
      const fulfillment = args.effectMayBeIssued
        ? await findFulfillmentJob(context, command.jobId)
        : null;
      const stageFailureHandled = await closeRejectedGenerateStage(
        context,
        fulfillment,
        command,
        nowMs,
      );
      const next = {
        state: stageFailureHandled
          ? "failed"
          : EXTERNAL_EFFECT_ACTIONS.has(command.action) && command.claim.effectStartedAtMs !== undefined
            ? "reconciliation_required"
            : "pending",
        claim: null,
        lastFailureReason: "command_lease_expired",
        outcome: null,
        updatedAt: new Date(nowMs).toISOString(),
      };
      await context.db.patch(command._id, next);
      return { active: false, command: projectCommand({ ...command, ...next }) };
    }
    if (args.effectMayBeIssued && !EXTERNAL_EFFECT_ACTIONS.has(command.action)) {
      throw new Error("Only external-effect commands may mark an effect fence.");
    }
    if (command.action === "create_checkout") {
      const customer = await findCustomerJob(context, command.jobId);
      if (customer?.job?.payment?.checkout) {
        const checkoutOutcome = canonicalCheckoutOutcome(customer.job, command.commandId);
        const next = checkoutOutcome ? {
          state: "completed",
          lastFailureReason: null,
          outcome: checkoutOutcome,
          updatedAt: new Date(nowMs).toISOString(),
        } : {
          state: "failed",
          claim: null,
          lastFailureReason: "checkout_target_already_exists",
          outcome: null,
          updatedAt: new Date(nowMs).toISOString(),
        };
        await context.db.patch(command._id, next);
        return { active: false, command: projectCommand({ ...command, ...next }) };
      }
    }
    const fulfillment = await findFulfillmentJob(context, command.jobId);
    const stateMatches = fulfillment
      && commandStateIsCurrent(command, fulfillment.aggregate, args.effectMayBeIssued, nowMs);
    let bindingMatches = false;
    if (stateMatches) {
      try {
        assertCanonicalActionBinding(command.action, command.payload, fulfillment.aggregate);
        bindingMatches = true;
      } catch {
        bindingMatches = false;
      }
    }
    if (!stateMatches || !bindingMatches) {
      if (args.effectMayBeIssued) {
        await closeRejectedGenerateStage(context, fulfillment, command, nowMs);
      }
      const next = {
        state: "failed",
        claim: null,
        lastFailureReason: stateMatches ? "stale_action_binding" : "stale_job_state",
        outcome: null,
        updatedAt: new Date(nowMs).toISOString(),
      };
      await context.db.patch(command._id, next);
      return { active: false, command: projectCommand({ ...command, ...next }) };
    }
    const claim = {
      ...command.claim,
      leaseExpiresAtMs: nowMs + args.leaseMs,
      ...(args.effectMayBeIssued && command.claim.effectStartedAtMs === undefined
        ? { effectStartedAtMs: nowMs }
        : {}),
    };
    const next = { claim, updatedAt: new Date(nowMs).toISOString() };
    await context.db.patch(command._id, next);
    return { active: true, command: projectClaimedCommand({ ...command, ...next }) };
  },
});

export const completeCommand = mutationGeneric({
  args: {
    workerToken: v.string(),
    commandId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    outcome: v.any(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertCommandId(args.commandId);
    assertWorkerId(args.workerId);
    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs).toISOString();
    const command = await findCommand(context, args.commandId);
    assertCommandOutcome(command, args.outcome);
    if (command?.state === "completed") {
      if (command.claim?.workerId !== args.workerId
        || command.claim?.leaseToken !== args.leaseToken
        || stableStringify(command.outcome) !== stableStringify(args.outcome)) {
        throw new Error("Operator command completion replay does not match the terminal command.");
      }
      return { completed: true, command: projectCommand(command) };
    }
    assertActiveClaim(command, args.workerId, args.leaseToken, completedAtMs);
    if (EXTERNAL_EFFECT_ACTIONS.has(command.action) && command.claim.effectStartedAtMs === undefined) {
      throw new Error("External-effect command completion requires a persisted effect fence.");
    }
    const [customerDocument, fulfillmentDocument] = await Promise.all([
      findCustomerJob(context, command.jobId),
      findFulfillmentJob(context, command.jobId),
    ]);
    if (!customerDocument || !fulfillmentDocument) {
      throw new Error("Operator command canonical job is missing.");
    }

    if (command.action === "reconcile") {
      await completeReconciliation(context, command, args.outcome, customerDocument.job, fulfillmentDocument.aggregate, completedAt);
    } else {
      const authoritativeOutcome = canonicalOutcomeForCommand(
        command,
        customerDocument.job,
        fulfillmentDocument.aggregate,
      );
      if (!authoritativeOutcome
        || stableStringify(authoritativeOutcome) !== stableStringify(args.outcome)) {
        throw new Error("Operator command does not match the authoritative fulfillment outcome.");
      }
    }
    const next = {
      state: "completed",
      claim: command.claim,
      lastFailureReason: null,
      outcome: args.outcome,
      updatedAt: completedAt,
    };
    await context.db.patch(command._id, next);
    return { completed: true, command: projectCommand({ ...command, ...next }) };
  },
});

export const failCommand = mutationGeneric({
  args: {
    workerToken: v.string(),
    commandId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    reasonCode: v.string(),
    retryable: v.boolean(),
  },
  handler: async (context, args) => {
    assertWorkerToken(args.workerToken);
    assertCommandId(args.commandId);
    assertWorkerId(args.workerId);
    const failedAtMs = Date.now();
    const failedAt = new Date(failedAtMs).toISOString();
    if (!REASON_CODE.test(args.reasonCode)) throw new Error("Operator failure reason code is invalid.");
    const command = await findCommand(context, args.commandId);
    assertClaimIdentity(command, args.workerId, args.leaseToken);
    const effectMayHaveOccurred = EXTERNAL_EFFECT_ACTIONS.has(command.action)
      && command.claim.effectStartedAtMs !== undefined;
    const next = {
      state: effectMayHaveOccurred
        ? "reconciliation_required"
        : args.retryable ? "pending" : "failed",
      claim: null,
      lastFailureReason: args.reasonCode,
      outcome: null,
      updatedAt: failedAt,
    };
    await context.db.patch(command._id, next);
    return { failed: true, command: projectCommand({ ...command, ...next }) };
  },
});

async function completeReconciliation(context, command, outcome, customer, aggregate, completedAt) {
  const source = await findCommand(context, command.payload.sourceCommandId);
  const latestSource = await findReconciliationCommand(context, command.jobId);
  if (!source
    || source.jobId !== command.jobId
    || source.state !== "reconciliation_required"
    || latestSource?.commandId !== source.commandId
    || !EXTERNAL_EFFECT_ACTIONS.has(source.action)) {
    throw new Error("Operator reconciliation source is no longer unresolved.");
  }
  const expected = {
    code: "reconciled",
    jobVersion: aggregate.version,
    reconciledState: aggregate.state,
    sourceCommandId: source.commandId,
    providerStatus: command.payload.providerStatus,
  };
  if (stableStringify(outcome) !== stableStringify(expected)) {
    throw new Error("Operator reconciliation does not match authoritative provider and fulfillment state.");
  }

  if (command.payload.providerStatus === "confirmed_absent") {
    if (aggregate.state !== source.expectedState || aggregate.version !== source.expectedVersion) {
      throw new Error("An absent external effect requires the unchanged authoritative fulfillment target.");
    }
    assertCanonicalActionBinding(source.action, source.payload, aggregate);
    await context.db.patch(source._id, {
      state: "pending",
      claim: null,
      lastFailureReason: "reconciliation_confirmed_absent",
      outcome: null,
      updatedAt: completedAt,
    });
    return;
  }

  const authoritativeSourceOutcome = canonicalOutcomeForCommand(source, customer, aggregate);
  if (!authoritativeSourceOutcome) {
    throw new Error("A succeeded external effect is not reflected by authoritative fulfillment state.");
  }
  await context.db.patch(source._id, {
    state: "completed",
    claim: null,
    lastFailureReason: null,
    outcome: authoritativeSourceOutcome,
    updatedAt: completedAt,
  });
}

function canonicalOutcomeForCommand(command, customer, aggregate) {
  if (!command || !aggregate || aggregate.jobId !== command.jobId) return null;
  const version = aggregate.version;
  if (!Number.isInteger(version) || version < 1) return null;

  if (command.action === "create_checkout") {
    return canonicalCheckoutOutcome(customer, command.commandId);
  }

  if (version <= command.expectedVersion) return null;
  try {
    assertCanonicalActionBinding(command.action, command.payload, aggregate);
  } catch {
    return null;
  }

  const artifactKindByAction = {
    generate: ["private_review", "review_prepared"],
    render: ["prepared_bundle", "release_rendered"],
    generate_narration: ["narration_review", "narration_prepared"],
  };
  const artifactContract = artifactKindByAction[command.action];
  if (artifactContract) {
    const artifact = latestArtifactForRevision(aggregate, artifactContract[0]);
    const expectedState = command.action === "generate" ? "content_review_required"
      : command.action === "generate_narration" ? "narration_review_required" : null;
    if (!artifact?.artifactSetId
      || !aggregate.currentRevisionId
      || artifact.operationsCommandId !== command.commandId
      || (expectedState && aggregate.state !== expectedState)
      || (command.action === "render" && !["tts_queued", "publish_ready"].includes(aggregate.state))) return null;
    return {
      code: artifactContract[1],
      revisionId: aggregate.currentRevisionId,
      artifactSetId: artifact.artifactSetId,
      jobVersion: version,
    };
  }

  const reviewContract = reviewOutcomeForAction(command.action);
  if (reviewContract) {
    const decision = (aggregate.reviewDecisions || []).at(-1);
    const expectedState = reviewContract.outcome === "rejected" ? "rejected"
      : reviewContract.outcome === "request_changes"
        ? reviewContract.decisionType === "content" ? "generation_queued" : "tts_queued"
        : reviewContract.decisionType === "content" ? "render_queued" : "publish_ready";
    if (!decision?.decisionId
      || aggregate.state !== expectedState
      || decision.operationsCommandId !== command.commandId
      || decision.decisionType !== reviewContract.decisionType
      || decision.outcome !== reviewContract.outcome
      || decision.revisionId !== command.payload.revisionId
      || stableStringify(decision.artifactDigests) !== stableStringify(command.payload.artifactDigests)) return null;
    return { code: "review_recorded", decisionId: decision.decisionId, jobVersion: version };
  }

  if (command.action === "publish") {
    const publication = aggregate.publication;
    const publicationId = canonicalPublicationId(publication);
    if (aggregate.state !== "published"
      || publication?.status !== "published"
      || publication.operationsCommandId !== command.commandId
      || publication.revisionId !== command.payload.revisionId
      || publication.artifactManifestDigest !== command.payload.artifactManifestDigest
      || !publicationId
      || !isHttpsUrl(publication.stableUrl)) return null;
    return {
      code: "published",
      deploymentId: publication.deploymentId || publicationId,
      jobVersion: version,
      productionUrl: publication.stableUrl,
      publicationId,
    };
  }

  if (command.action === "queue_delivery") {
    return aggregate.state === "delivery_queued"
      && hasOperationEvent(aggregate, command.commandId, "delivery_queued")
      ? { code: "delivery_queued", jobVersion: version }
      : null;
  }

  if (command.action === "deliver") {
    const delivery = (aggregate.deliveryAttempts || []).at(-1);
    if (!["sent", "complete"].includes(aggregate.state)
      || delivery?.revisionId !== command.payload.revisionId
      || delivery.operationsCommandId !== command.commandId
      || typeof delivery.providerMessageId !== "string"
      || typeof delivery.idempotencyKey !== "string") return null;
    return {
      code: "delivered",
      deliveryAttemptId: delivery.idempotencyKey,
      jobVersion: version,
      providerMessageId: delivery.providerMessageId,
    };
  }

  if (command.action === "retry") {
    const resumedStates = new Set(["generation_queued", "render_queued", "tts_queued", "publish_ready", "delivery_queued"]);
    return aggregate.retry === null
      && resumedStates.has(aggregate.state)
      && hasOperationEvent(aggregate, command.commandId, "retry_resumed")
      ? { code: "retry_scheduled", jobVersion: version }
      : null;
  }
  return null;
}

function canonicalCheckoutOutcome(customer, commandId) {
  const checkout = customer?.payment?.checkout;
  if (!checkout
    || typeof checkout.sessionId !== "string"
    || !isHttpsUrl(checkout.checkoutUrl)
    || checkout.operationsCommandId !== commandId
    || !Number.isInteger(customer.version)) return null;
  return {
    code: "checkout_available",
    checkoutSessionId: checkout.sessionId,
    checkoutUrl: checkout.checkoutUrl,
    jobVersion: customer.version,
  };
}

function hasOperationEvent(aggregate, commandId, eventType) {
  return (aggregate.events || []).some((event) => (
    event.commandId === commandId && event.type === eventType
  ));
}

function latestArtifactForRevision(aggregate, kind) {
  return [...(aggregate.artifactSets || [])].reverse().find((entry) => (
    entry.kind === kind && entry.revisionId === aggregate.currentRevisionId
  ));
}

function reviewOutcomeForAction(action) {
  const decisionType = action.endsWith("_content") ? "content"
    : action.endsWith("_narration") ? "narration" : null;
  if (!decisionType) return null;
  const outcome = action.startsWith("approve_") ? "approved"
    : action.startsWith("request_") ? "request_changes"
      : action.startsWith("reject_") ? "rejected" : null;
  return outcome ? { decisionType, outcome } : null;
}

function canonicalPublicationId(publication) {
  const value = publication?.providerReceiptId || publication?.publicationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function commandStateIsCurrent(command, aggregate, effectMayBeIssued, nowMs) {
  const expectedStateMatches = aggregate.state === command.expectedState
    && aggregate.version === command.expectedVersion;
  if (!effectMayBeIssued) return expectedStateMatches;
  if (command.action === "create_checkout") return expectedStateMatches;
  if (aggregate.version <= command.expectedVersion) return false;
  const runningStageByAction = {
    generate: ["generating", "prepare_review"],
    generate_narration: ["tts_generating", "generate_tts"],
    publish: ["publishing", "publish"],
    deliver: ["sending", "deliver"],
  };
  const binding = runningStageByAction[command.action];
  if (!binding || binding[0] !== aggregate.state) return false;
  const attempt = [...(aggregate.stageAttempts || [])].reverse().find((entry) => (
    entry.stage === binding[1] && entry.status === "running"
  ));
  const leaseExpiresAtMs = typeof attempt?.leaseExpiresAt === "string"
    ? Date.parse(attempt.leaseExpiresAt)
    : Number.NaN;
  return attempt?.operationsCommandId === command.commandId
    && Number.isFinite(leaseExpiresAtMs)
    && new Date(leaseExpiresAtMs).toISOString() === attempt.leaseExpiresAt
    && leaseExpiresAtMs > nowMs;
}

async function closeRejectedGenerateStage(context, fulfillment, command, nowMs) {
  const aggregate = fulfillment?.aggregate;
  const attempt = aggregate?.stageAttempts?.at(-1);
  const claimedEvent = aggregate?.events?.at(-1);
  const candidateNoEffectClaim = command.action === "generate"
    && command.claim?.effectStartedAtMs === undefined
    && aggregate?.jobId === command.jobId
    && aggregate.state === "generating"
    && aggregate.version === command.expectedVersion + 1
    && attempt?.stage === "prepare_review"
    && attempt.status === "running"
    && attempt.operationsCommandId === command.commandId
    && Number.isInteger(attempt.attemptNumber)
    && attempt.attemptNumber > 0
    && Number.isInteger(attempt.operationNumber)
    && attempt.operationNumber > 0
    && typeof attempt.leaseToken === "string"
    && attempt.leaseToken.length > 0
    && attempt.effectStartedAt === null
    && attempt.completedAt === null
    && attempt.failure === null;
  if (!candidateNoEffectClaim) return false;

  const updatedAtMs = Date.parse(aggregate.updatedAt);
  const startedAtMs = Date.parse(attempt.startedAt);
  const leaseExpiresAtMs = Date.parse(attempt.leaseExpiresAt);
  const leaseMs = leaseExpiresAtMs - startedAtMs;
  if (!Number.isFinite(updatedAtMs)
    || new Date(updatedAtMs).toISOString() !== aggregate.updatedAt
    || updatedAtMs > nowMs
    || !Number.isFinite(startedAtMs)
    || new Date(startedAtMs).toISOString() !== attempt.startedAt
    || !Number.isFinite(leaseExpiresAtMs)
    || new Date(leaseExpiresAtMs).toISOString() !== attempt.leaseExpiresAt
    || !Number.isInteger(leaseMs)
    || leaseMs !== TEST_A_PREPARE_REVIEW_RETRY_POLICY.leaseMs) {
    return false;
  }

  const priorAttempts = aggregate.stageAttempts.slice(0, -1);
  const matchingPriorAttempts = priorAttempts.filter((entry) => (
    entry.stage === "prepare_review" && entry.revisionId === aggregate.currentRevisionId
  ));
  const expectedAttemptNumber = matchingPriorAttempts.length + 1;
  const expectedOperationNumber = matchingPriorAttempts.filter((entry) => entry.status === "completed").length + 1;
  const exactClaimCommandId =
    `claim:${command.jobId}:${attempt.revisionId || "unassigned"}:prepare_review:${attempt.attemptNumber}`;
  const claimPayload = {
    commandId: exactClaimCommandId,
    stage: "prepare_review",
    leaseMs,
    maxAttempts: TEST_A_PREPARE_REVIEW_RETRY_POLICY.maxAttempts,
    operationBinding: null,
    operationsCommandId: command.commandId,
  };
  const [attemptIdDigest, idempotencyDigest, claimEventIdDigest, claimDigest] = await Promise.all([
    sha256Hex([
      aggregate.jobId,
      attempt.revisionId || "unassigned",
      "prepare_review",
      String(attempt.attemptNumber),
    ].join("\0")),
    sha256Hex([
      aggregate.jobId,
      attempt.revisionId || "unassigned",
      "prepare_review",
      String(attempt.operationNumber),
    ].join("\0")),
    sha256Hex(`${aggregate.jobId}\0${exactClaimCommandId}`),
    sha256Hex(`stage_claimed\0${stableStringify(claimPayload)}`),
  ]);
  const exactNoEffectClaim = attempt.revisionId === aggregate.currentRevisionId
    && attempt.attemptNumber === expectedAttemptNumber
    && attempt.operationNumber === expectedOperationNumber
    && attempt.attemptId === `attempt_${attemptIdDigest.slice(0, 24)}`
    && attempt.idempotencyKey === `bb_${idempotencyDigest}`
    && attempt.operationBinding === null
    && attempt.startedAt === aggregate.updatedAt
    && aggregate.retry === null
    && Object.keys(attempt).sort().join("\0") === [
      "attemptId",
      "attemptNumber",
      "completedAt",
      "effectStartedAt",
      "failure",
      "idempotencyKey",
      "leaseExpiresAt",
      "leaseToken",
      "operationBinding",
      "operationNumber",
      "operationsCommandId",
      "revisionId",
      "stage",
      "startedAt",
      "status",
    ].sort().join("\0")
    && Object.keys(claimedEvent || {}).sort().join("\0") === [
      "at", "commandDigest", "commandId", "eventId", "state", "type",
    ].sort().join("\0")
    && claimedEvent.eventId === `event_${claimEventIdDigest.slice(0, 24)}`
    && claimedEvent.commandId === exactClaimCommandId
    && claimedEvent.commandDigest === claimDigest
    && claimedEvent.type === "stage_claimed"
    && claimedEvent.at === aggregate.updatedAt
    && claimedEvent.state === "generating";
  if (!exactNoEffectClaim) return false;

  const at = new Date(nowMs).toISOString();
  const retryable = attempt.attemptNumber < TEST_A_PREPARE_REVIEW_RETRY_POLICY.maxAttempts;
  const recoveryCommandId = `operations-fence-rejected:${command.commandId}:${attempt.attemptId}`;
  const reasonCode = leaseExpiresAtMs <= nowMs
    ? "lease_expired"
    : "operations_effect_fence_rejected";
  const failure = {
    commandId: recoveryCommandId,
    stage: "prepare_review",
    leaseToken: attempt.leaseToken,
    retryable: true,
    reasonCode,
  };
  const eventIdDigest = await sha256Hex(`${aggregate.jobId}\0${recoveryCommandId}`);
  const commandDigest = await sha256Hex(`stage_failed\0${stableStringify(failure)}`);
  const recoveredAttempt = {
    ...attempt,
    status: retryable ? "retry_wait" : "failed",
    leaseToken: null,
    leaseExpiresAt: null,
    completedAt: at,
    failure: {
      retryable,
      reasonCode,
    },
  };
  const nextAggregate = {
    ...aggregate,
    state: retryable ? "retry_wait" : "failed",
    version: aggregate.version + 1,
    updatedAt: at,
    retry: retryable ? {
      stage: "prepare_review",
      availableAt: new Date(
        nowMs + TEST_A_PREPARE_REVIEW_RETRY_POLICY.backoffMs[attempt.attemptNumber - 1],
      ).toISOString(),
    } : null,
    stageAttempts: [...aggregate.stageAttempts.slice(0, -1), recoveredAttempt],
    events: [...aggregate.events, {
      eventId: `event_${eventIdDigest.slice(0, 24)}`,
      commandId: recoveryCommandId,
      commandDigest,
      type: "stage_failed",
      at,
      state: retryable ? "retry_wait" : "failed",
    }],
  };
  await context.db.patch(fulfillment._id, { aggregate: nextAggregate });
  return true;
}

function availableActions(customer, aggregate) {
  const actions = [...(ACTIONS_BY_STATE[aggregate?.state] || [])];
  if (aggregate?.state === "awaiting_payment" && customer?.payment?.checkout) {
    return actions.filter((action) => action !== "create_checkout");
  }
  return actions;
}

function commandConflictGroup(action) {
  if (["approve_content", "request_content_changes", "reject_content"].includes(action)) {
    return "content_review_decision";
  }
  if (["approve_narration", "request_narration_changes", "reject_narration"].includes(action)) {
    return "narration_review_decision";
  }
  return null;
}

function isAuditedNoEffectGenerateFailure(command, aggregate) {
  return command.action === "generate"
    && command.expectedState === "generation_queued"
    && command.expectedVersion === aggregate.version
    && command.state === "failed"
    && command.attempts === 1
    && command.claim === null
    && command.lastFailureReason === "stale_job_state"
    && command.outcome === null
    && command.supersedesCommandId === undefined
    && stableStringify(command.payload) === "{}"
    && !hasCommandProvenance(aggregate, command.commandId);
}

function hasCommandProvenance(value, commandId) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasCommandProvenance(entry, commandId));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => (
    (["commandId", "operationsCommandId"].includes(key) && entry === commandId)
    || hasCommandProvenance(entry, commandId)
  ));
}

function summarizeJob(customer, fulfillment, reconciliationCommand = null) {
  return {
    jobId: customer.jobId,
    createdAt: customer.createdAt,
    updatedAt: fulfillment?.updatedAt || customer.updatedAt,
    state: reconciliationCommand ? "reconciliation_required" : fulfillment?.state || "initializing",
    paymentStatus: customer.payment?.status || "pending",
    customerEmail: customer.intake?.customer?.email || "",
    babyName: customer.intake?.baby?.firstName || "",
    languages: Array.isArray(customer.intake?.languages) ? [...customer.intake.languages] : [],
    narrationRequired: fulfillment?.narrationRequired === true,
  };
}

function projectCustomerJob(job) {
  return {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    version: job.version,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    intake: job.intake,
    intakeDigest: job.intakeDigest,
    payment: job.payment,
  };
}

function projectCommand(command) {
  return {
    commandId: command.commandId,
    ...(command.supersedesCommandId ? { supersedesCommandId: command.supersedesCommandId } : {}),
    jobId: command.jobId,
    action: command.action,
    expectedState: command.expectedState,
    expectedVersion: command.expectedVersion,
    payload: command.payload,
    requestedAt: command.requestedAt,
    requestedBy: command.requestedBy,
    state: command.state,
    attempts: command.attempts,
    claim: command.claim
      ? {
          workerId: command.claim.workerId,
          claimedAtMs: command.claim.claimedAtMs,
          leaseExpiresAtMs: command.claim.leaseExpiresAtMs,
        }
      : null,
    lastFailureReason: command.lastFailureReason,
    outcome: command.outcome,
    updatedAt: command.updatedAt,
  };
}

function projectClaimedCommand(command) {
  return { ...projectCommand(command), claim: command.claim };
}

function findCustomerJob(context, jobId) {
  return context.db
    .query("customerFlowJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findFulfillmentJob(context, jobId) {
  return context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", jobId))
    .unique();
}

function findThrottleBucket(context, bucketKey) {
  return context.db
    .query("customerFlowOperationsLoginThrottle")
    .withIndex("by_bucket_key", (query) => query.eq("bucketKey", bucketKey))
    .unique();
}

async function consumeThrottleBucket(context, bucketKey, policy) {
  const existing = await findThrottleBucket(context, bucketKey);
  if (existing?.blockedUntilMs > policy.nowMs) {
    return { allowed: false, retryAfterMs: existing.blockedUntilMs - policy.nowMs };
  }
  const resetWindow = !existing || policy.nowMs - existing.windowStartedAtMs >= policy.windowMs;
  const windowStartedAtMs = resetWindow ? policy.nowMs : existing.windowStartedAtMs;
  const attempts = resetWindow ? 1 : existing.attempts + 1;
  const blockedUntilMs = attempts > policy.limit ? policy.nowMs + policy.blockMs : 0;
  const next = { bucketKey, windowStartedAtMs, attempts, blockedUntilMs, updatedAtMs: policy.nowMs };
  if (existing) await context.db.patch(existing._id, next);
  else await context.db.insert("customerFlowOperationsLoginThrottle", next);
  return {
    allowed: blockedUntilMs === 0,
    retryAfterMs: blockedUntilMs > 0 ? blockedUntilMs - policy.nowMs : 0,
  };
}

function findCommand(context, commandId) {
  return context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", commandId))
    .unique();
}

function findReconciliationCommand(context, jobId) {
  return context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_job_id_and_state", (query) => query
      .eq("jobId", jobId)
      .eq("state", "reconciliation_required"))
    .order("desc")
    .first();
}

function findCommandsByState(context, jobId, state) {
  return context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_job_id_and_state", (query) => query.eq("jobId", jobId).eq("state", state))
    .collect();
}

function sameCommandBinding(command, args) {
  return command.commandId === args.commandId
    && command.jobId === args.jobId
    && command.action === args.action
    && command.expectedState === args.expectedState
    && command.expectedVersion === args.expectedVersion
    && stableStringify(command.payload) === stableStringify(args.payload);
}

function assertCommandInput(args) {
  assertCommandId(args.commandId);
  assertJobId(args.jobId);
  if (!ALL_ACTIONS.has(args.action)) throw new Error("Operator action is invalid.");
  if (typeof args.expectedState !== "string" || args.expectedState.length > 64) {
    throw new Error("Operator expected state is invalid.");
  }
  if (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 1) {
    throw new Error("Operator expected version is invalid.");
  }
  assertTimestamp(args.requestedAt, "request timestamp");
  if (!ACTOR_ID.test(args.requestedBy)) throw new Error("Operator identity is invalid.");
  assertActionPayload(args.action, args.payload);
}

function assertActionPayload(action, payload) {
  assertBoundedObject(payload, "operator action payload", 8_192);
  const allowed = PAYLOAD_FIELDS_BY_ACTION[action];
  if (!allowed || Object.keys(payload).some((field) => !allowed.includes(field))) {
    throw new Error("Operator action payload contains unexpected fields.");
  }
  if (payload.reasonCodes !== undefined) {
    if (!Array.isArray(payload.reasonCodes)
      || payload.reasonCodes.length < 1
      || payload.reasonCodes.length > 8
      || new Set(payload.reasonCodes).size !== payload.reasonCodes.length
      || payload.reasonCodes.some((code) => !REASON_CODE.test(code))) {
      throw new Error("Operator action reason codes are invalid.");
    }
  }
  if (action === "reconcile"
    && (!COMMAND_ID.test(payload.sourceCommandId || "")
      || !["confirmed_succeeded", "confirmed_absent"].includes(payload.providerStatus))) {
    throw new Error("Operator reconciliation payload is invalid.");
  }
}

function assertCanonicalActionBinding(action, payload, aggregate) {
  if (action === "publish") {
    const releaseKind = aggregate.narrationRequired ? "narration_review" : "prepared_bundle";
    const releaseArtifact = [...(aggregate.artifactSets || [])].reverse().find((entry) => (
      entry.revisionId === aggregate.currentRevisionId
      && entry.kind === releaseKind
      && typeof entry.assetManifestDigest === "string"
    ));
    const expected = releaseArtifact && {
      revisionId: aggregate.currentRevisionId,
      artifactManifestDigest: releaseArtifact.assetManifestDigest,
    };
    if (!expected || stableStringify(payload) !== stableStringify(expected)) {
      throw new Error("Operator publication command does not bind the exact release artifact.");
    }
    return;
  }

  if (action === "queue_delivery" || action === "deliver") {
    const publication = aggregate.publication;
    const releaseKind = aggregate.narrationRequired ? "narration_review" : "prepared_bundle";
    const releaseArtifact = [...(aggregate.artifactSets || [])].reverse().find((entry) => (
      entry.revisionId === aggregate.currentRevisionId
      && entry.kind === releaseKind
      && typeof entry.assetManifestDigest === "string"
    ));
    const publicationId = canonicalPublicationId(publication);
    const expected = publication?.status === "published"
      && aggregate.currentRevisionId === aggregate.publishedRevisionId
      && publication.revisionId === aggregate.currentRevisionId
      && publicationId
      && releaseArtifact?.assetManifestDigest === publication.artifactManifestDigest
      ? {
          revisionId: aggregate.currentRevisionId,
          publicationId,
          artifactManifestDigest: publication.artifactManifestDigest,
        }
      : null;
    if (!expected || stableStringify(payload) !== stableStringify(expected)) {
      throw new Error("Operator delivery command does not bind the exact publication.");
    }
    return;
  }

  const isContentReview = ["approve_content", "request_content_changes", "reject_content"].includes(action);
  const isNarrationReview = ["approve_narration", "request_narration_changes", "reject_narration"].includes(action);
  if (!isContentReview && !isNarrationReview) return;

  const revisionId = aggregate.currentRevisionId;
  const expectedKind = isContentReview ? "private_review" : "narration_review";
  const artifactSet = [...(aggregate.artifactSets || [])].reverse().find((entry) => (
    entry.kind === expectedKind && entry.revisionId === revisionId
  ));
  const expected = artifactSet && {
    revisionId,
    artifactManifestDigest: artifactSet.assetManifestDigest,
    artifactDigests: {
      pageDigest: artifactSet.pageDigest,
      transcriptDigest: artifactSet.transcriptDigest,
      assetManifestDigest: artifactSet.assetManifestDigest,
    },
  };
  const requiresReasons = action.startsWith("request_") || action.startsWith("reject_");
  const actual = requiresReasons
    ? {
      revisionId: payload.revisionId,
      artifactManifestDigest: payload.artifactManifestDigest,
        artifactDigests: payload.artifactDigests,
      }
    : payload;
  if (!expected || stableStringify(actual) !== stableStringify(expected)) {
    throw new Error("Operator review command does not bind the exact review artifacts.");
  }
  if (requiresReasons && payload.reasonCodes === undefined) {
    throw new Error("Operator review command requires reason codes.");
  }
}

function assertBoundedObject(value, label, maximumBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const serialized = stableStringify(value);
  if (new TextEncoder().encode(serialized).byteLength > maximumBytes) {
    throw new Error(`${label} is too large.`);
  }
}

function assertCommandOutcome(command, outcome) {
  assertBoundedObject(outcome, "command outcome", 16_384);
  if (Object.keys(outcome).some((field) => !SAFE_OUTCOME_FIELDS.has(field))) {
    throw new Error("Operator command outcome fields are invalid.");
  }
  for (const value of Object.values(outcome)) {
    if (value !== null
      && typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean") {
      throw new Error("Operator command outcome values are invalid.");
    }
    if (typeof value === "string" && value.length > 2_048) {
      throw new Error("Operator command outcome values are invalid.");
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("Operator command outcome values are invalid.");
    }
  }
  const contract = OUTCOME_CONTRACT_BY_ACTION[command?.action];
  if (!contract
    || stableStringify(Object.keys(outcome).sort()) !== stableStringify([...contract.fields].sort())
    || outcome.code !== contract.code
    || !Number.isInteger(outcome.jobVersion)
    || outcome.jobVersion < 1) {
    throw new Error("Operator command outcome does not match action contract.");
  }
  for (const [field, value] of Object.entries(outcome)) {
    if (field === "code" || field === "jobVersion") continue;
    if (typeof value !== "string" || value.length < 1 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("Operator command outcome does not match action contract.");
    }
    if ((field === "checkoutUrl" || field === "productionUrl") && !isHttpsUrl(value)) {
      throw new Error("Operator command outcome does not match action contract.");
    }
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function assertWorkerClaimInput(args) {
  assertWorkerId(args.workerId);
  if (!Array.isArray(args.actions)
    || args.actions.length > ALL_ACTIONS.size
    || new Set(args.actions).size !== args.actions.length
    || args.actions.some((action) => !ALL_ACTIONS.has(action))) {
    throw new Error("Operator worker action scope is invalid.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) {
    throw new Error("Operator worker claim limit is invalid.");
  }

  if (!Number.isInteger(args.leaseMs) || args.leaseMs < 1_000 || args.leaseMs > 600_000) {
    throw new Error("Operator worker lease is invalid.");
  }
}

function assertClaimIdentity(command, workerId, leaseToken) {
  if (!command
    || command.state !== "running"
    || command.claim?.workerId !== workerId
    || command.claim?.leaseToken !== leaseToken) {
    throw new Error("Operator command does not have the required claim identity.");
  }
}

function assertActiveClaim(command, workerId, leaseToken, atMs) {
  if (!command
    || command.state !== "running"
    || command.claim?.workerId !== workerId
    || command.claim?.leaseToken !== leaseToken
    || atMs < command.claim.claimedAtMs
    || command.claim.leaseExpiresAtMs <= atMs) {
    throw new Error("Operator command does not have the required active claim.");
  }
}

function assertJobId(value) {
  if (!JOB_ID.test(value || "")) throw new Error("Operator job id is invalid.");
}

function assertCommandId(value) {
  if (!COMMAND_ID.test(value || "")) throw new Error("Operator command id is invalid.");
}

function assertWorkerId(value) {
  if (!WORKER_ID.test(value || "")) throw new Error("Operator worker id is invalid.");
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertOperatorToken(value) {
  assertDistinctOperationsTokens();
  assertScopedToken(value, process.env.BEBEBONJOUR_OPERATIONS_TOKEN);
}

function assertRateLimitToken(value) {
  assertDistinctOperationsTokens();
  assertScopedToken(value, process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN);
}

function assertWorkerToken(value) {
  assertDistinctOperationsTokens();
  assertScopedToken(value, process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN);
}

function assertDistinctOperationsTokens() {
  const configured = [
    process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
    process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
    process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN,
  ].filter((token) => typeof token === "string" && token.length > 0);
  if (new Set(configured).size !== configured.length) {
    throw new Error("Operations credentials must be distinct.");
  }
}

function assertScopedToken(value, expected) {
  if (!expected || expected.length < 32 || value !== expected) {
    throw new Error("Unauthorized.");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
