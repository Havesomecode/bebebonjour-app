import { mutation, v } from "./functions.mjs";
const SOURCE_HASH = /^[a-f0-9]{64}$/u;
const SOURCE_WINDOW_MS = 15 * 60 * 1_000;
const SOURCE_LIMIT = 8;
const SOURCE_BLOCK_MS = 15 * 60 * 1_000;
const GLOBAL_WINDOW_MS = 60 * 1_000;
const GLOBAL_LIMIT = 300;
const GLOBAL_BLOCK_MS = 30 * 1_000;
export const consumeLoginAttempt = mutation({
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

export const resetLoginThrottle = mutation({
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

function assertRateLimitToken(value) { assertDistinctOperationsTokens(); assertScopedToken(value, process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN); }
function assertDistinctOperationsTokens() {
  const configured = [
    process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
    process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
    process.env.BEBEBONJOUR_COMPLETION_WORKER_TOKEN,
    process.env.BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN,
    process.env.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN,
    process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN,
    process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN,
    process.env.CUSTOMER_FLOW_BACKEND_TOKEN,
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
