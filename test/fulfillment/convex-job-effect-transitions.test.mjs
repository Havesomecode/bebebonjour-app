import assert from "node:assert/strict";
import test from "node:test";
import * as nodeTransitions from "../../src/fulfillment/job-machine.mjs";
import * as convexTransitions from "../../src/fulfillment/convex-job-effect-transitions.mjs";

const before = "2026-09-29T12:00:00.000Z";
const at = "2026-09-29T12:00:30.000Z";
const expires = "2026-09-29T12:01:00.000Z";
const policy = { maxAttemptsByStage: { generate_tts: 3 }, backoffMsByStage: { generate_tts: [1000, 2000] } };
function aggregate() {
  return {
    jobId: "job_effect_parity", state: "tts_generating", version: 4,
    updatedAt: before, retry: null,
    stageAttempts: [{
      attemptId: "attempt_parity", stage: "generate_tts", revisionId: "r1",
      operationsCommandId: "command_original", status: "running", attemptNumber: 1,
      leaseToken: "lease_parity", leaseExpiresAt: expires, completedAt: null,
      failure: null, effectStartedAt: null, idempotencyKey: "bb_effect_parity",
    }],
    events: [{ commandId: "claim_original", type: "stage_claimed", state: "tts_generating" }],
  };
}
const recovery = { commandId: "recover_unfenced", sourceCommandId: "command_original", attemptId: "attempt_parity" };
const failure = { commandId: "fail_stage", stage: "generate_tts", leaseToken: "lease_parity", retryable: true, reasonCode: "narration_failed" };
const reconciliation = { commandId: "reconcile_absent", sourceCommandId: "command_original" };
async function parity(name, job, args, timestamp = at) {
  const original = structuredClone(job);
  const expected = nodeTransitions[name](job, ...args, timestamp);
  assert.equal(expected instanceof Promise, false, "Node API remains synchronous");
  const actual = await convexTransitions[name](job, ...args, timestamp);
  assert.deepEqual(actual, expected, "all state, fencing and event commitment bytes agree");
  assert.deepEqual(job, original, "input remains untouched");
  assert.deepEqual(await convexTransitions[name](actual, ...args, timestamp), actual, "exact replay is idempotent");
  return actual;
}

test("Convex effect transitions preserve Node state and SHA-256 event/replay commitments", async () => {
  await parity("recoverUnfencedNarrationEffectTransition", aggregate(), [recovery]);
  const terminal = aggregate();
  Object.assign(terminal, { state: "failed" });
  Object.assign(terminal.stageAttempts[0], { status: "failed", leaseToken: null, leaseExpiresAt: null, completedAt: before, failure: { retryable: false, reasonCode: "narration_failed" } });
  terminal.events[0] = { commandId: "prior_failure", type: "stage_failed", state: "failed" };
  await parity("recoverUnfencedNarrationEffectTransition", terminal, [recovery]);
  await parity("failStageTransition", aggregate(), [failure, policy]);
  const issued = aggregate();
  issued.stageAttempts[0].effectStartedAt = before;
  const unresolved = await parity("failStageTransition", issued, [failure, policy]);
  await parity("reconcileAbsentExternalEffectTransition", unresolved, [reconciliation]);
  await parity("failStageTransition", issued, [{ ...failure, reasonCode: "lease_expired" }, policy], expires);
});

test("Convex effect guards reject the same stale, ambiguous and rebound commands without mutation", async () => {
  const cases = [
    ["recoverUnfencedNarrationEffectTransition", (job) => { job.stageAttempts[0].effectStartedAt = before; }, [recovery]],
    ["recoverUnfencedNarrationEffectTransition", (job) => { job.stageAttempts[0].operationsCommandId = "other"; }, [recovery]],
    ["recoverUnfencedNarrationEffectTransition", (job) => { job.stageAttempts[0].attemptId = "other"; }, [recovery]],
    ["failStageTransition", () => {}, [{ ...failure, leaseToken: "stale" }, policy]],
    ["failStageTransition", () => {}, [{ ...failure, reasonCode: "not bounded!" }, policy]],
    ["failStageTransition", () => {}, [failure, { maxAttemptsByStage: { generate_tts: 0 } }]],
    ["reconcileAbsentExternalEffectTransition", () => {}, [reconciliation]],
  ];
  for (const [name, mutate, args] of cases) {
    const job = aggregate(); mutate(job);
    const original = structuredClone(job);
    let expected;
    try { nodeTransitions[name](job, ...args, at); } catch (error) { expected = error.message; }
    assert.ok(expected, name);
    await assert.rejects(convexTransitions[name](job, ...args, at), (error) => error.message === expected);
    assert.deepEqual(job, original);
  }
  const recovered = await convexTransitions.recoverUnfencedNarrationEffectTransition(aggregate(), recovery, at);
  await assert.rejects(convexTransitions.recoverUnfencedNarrationEffectTransition(recovered, { ...recovery, sourceCommandId: "rebound" }, at), /Command replay/u);
  await assert.rejects(convexTransitions.recoverUnfencedNarrationEffectTransition(aggregate(), recovery, "not-iso"), /ISO timestamp/u);
  await assert.rejects(convexTransitions.recoverUnfencedNarrationEffectTransition(aggregate(), recovery, "2026-09-29T11:59:00.000Z"), /cannot precede/u);
});

test("Convex terminal pre-provider recovery rejects broadened failure records", async () => {
  for (const failure of [
    { retryable: false, reasonCode: "narration_failed", extra: true },
    { retryable: false, reasonCode: "narration_failed", extra: undefined },
    { retryable: true, reasonCode: "narration_failed" },
    { retryable: false, reasonCode: "different_failure" },
  ]) {
    const job = aggregate();
    job.state = "failed";
    Object.assign(job.stageAttempts[0], { status: "failed", leaseToken: null, leaseExpiresAt: null, completedAt: before, failure });
    job.events[0] = { commandId: "prior_failure", type: "stage_failed", state: "failed" };
    const original = structuredClone(job);
    assert.throws(() => nodeTransitions.recoverUnfencedNarrationEffectTransition(job, recovery, at), /exact pre-provider attempt/u);
    await assert.rejects(convexTransitions.recoverUnfencedNarrationEffectTransition(job, recovery, at), /exact pre-provider attempt/u);
    assert.deepEqual(job, original);
  }
});
