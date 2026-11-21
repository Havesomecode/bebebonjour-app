import test from "node:test";
import assert from "node:assert/strict";
import { backendTest } from "../support/backend.mjs";
const operatorToken = "operator-token-at-least-32-characters";
const rateLimitToken = "rate-limit-token-at-least-32-characters";
const consumeLoginAttempt = "operations:consumeLoginAttempt", resetLoginThrottle = "operations:resetLoginThrottle";
function fixture() { process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken; process.env.BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN = rateLimitToken; return backendTest(); }
test("login throttle is durable, source-scoped, resettable, and server-clocked", async (t) => {
  const backend = fixture();
  const originalNow = Date.now;
  let nowMs = Date.parse("2026-09-03T04:00:00.000Z");
  Date.now = () => nowMs;
  t.after(() => { Date.now = originalNow; });
  const sourceHash = "a".repeat(64);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
    assert.deepEqual(result, { allowed: true, retryAfterSeconds: 0 });
  }
  const blocked = await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 900);
  assert.deepEqual(
    await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash: "b".repeat(64) }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  for (let attempt = 0; attempt < 310; attempt += 1) {
    await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash });
  }
  assert.deepEqual(
    await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash: "c".repeat(64) }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  await assert.rejects(
    backend.mutation(resetLoginThrottle, { rateLimitToken: operatorToken, sourceHash }),
    /unauthorized/i,
  );
  await backend.mutation(resetLoginThrottle, { rateLimitToken, sourceHash });
  assert.equal((await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash })).allowed, true);
  nowMs += 16 * 60 * 1_000;
  assert.equal((await backend.mutation(consumeLoginAttempt, { rateLimitToken, sourceHash })).allowed, true);
});
