import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createProductionCheckoutWorker } from "../../src/operations/production-checkout-worker.mjs";
import { createTallyCheckoutHandoff } from "../../src/operations/tally-checkout-handoff.mjs";
import { runOperationsWorkerCommand } from "../../src/operations/operations-worker-startup.mjs";

const jobId = `job_${randomUUID()}`;
const commandId = `command_${randomUUID()}`;
const operatorToken = "operator-only-token-with-at-least-32-characters";
const workerToken = "worker-only-token-with-at-least-32-characters";
const environment = {
  CONVEX_URL: "https://test-a.convex.cloud",
  BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: workerToken,
  BEBEBONJOUR_OPERATIONS_WORKER_ID: "checkout-worker-1",
  BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "create_checkout",
  CUSTOMER_FLOW_BACKEND_TOKEN: "backend-token-with-at-least-32-characters",
  CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key",
  STRIPE_CHECKOUT_SUCCESS_URL: "https://example.test/success",
  STRIPE_CHECKOUT_CANCEL_URL: "https://example.test/cancel",
};
const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_fictional";

function fakeClient() {
  const customer = {
    schemaVersion: "1.0", jobId, version: 1,
    intake: { customer: { email: "fictional-parent@example.test" } },
    intakeDigest: "f".repeat(64),
    intakeTokenDigest: "a".repeat(64),
    payment: { status: "pending", checkout: null },
  };
  const calls = [];
  return {
    calls,
    customer,
    async query(name, input) {
      calls.push({ name, input });
      if (name === "customerFlow:readJob") return structuredClone(customer);
      if (name === "operations:workerHealth") return { protocolVersion: "1.0", scope: "worker" };
      throw new Error(`unexpected query ${name}`);
    },
    async mutation(name, input) {
      calls.push({ name, input });
      if (name === "customerFlow:replaceJob") {
        assert.equal(input.expectedVersion, customer.version);
        Object.assign(customer, structuredClone(input.job));
        return { updated: true, job: structuredClone(customer) };
      }
      if (name === "operations:claimCommands") return [];
      throw new Error(`unexpected mutation ${name}`);
    },
  };
}

test("production checkout capability creates only a real Stripe test Checkout Session and persists command provenance, not a payment", async () => {
  const client = fakeClient();
  let requests = 0;
  const stripe = { checkout: { sessions: { async create(request, options) {
    requests += 1;
    assert.equal(request.mode, "payment");
    assert.equal(request.customer_email, "fictional-parent@example.test");
    assert.equal(request.line_items[0].price_data.unit_amount, 3900);
    assert.equal(request.line_items[0].price_data.currency, "eur");
    assert.equal(request.metadata.job_id, jobId);
    assert.equal(request.payment_intent_data.metadata.job_id, jobId);
    assert.equal(options.idempotencyKey, `checkout:${jobId}:${"f".repeat(64)}`);
    return { id: "cs_test_fictional", url: checkoutUrl, livemode: false };
  } } } };
  const worker = createProductionCheckoutWorker({ client, environment, stripe });
  const created = await worker.operationsCheckout.createCheckout(jobId, commandId);
  assert.equal(created.sessionId, "cs_test_fictional");
  assert.equal(created.checkoutUrl, checkoutUrl);
  assert.equal(created.metadata.job_id, jobId);
  assert.equal(client.customer.payment.status, "pending");
  assert.equal(client.customer.payment.checkout.operationsCommandId, commandId);
  assert.equal(client.customer.payment.checkout.mode, "test");
  assert.equal(JSON.stringify(client.calls).includes("fictional-parent@example.test"), true);
  assert.equal(JSON.stringify(client.calls).includes("intakeTokenCiphertext"), false);
  assert.deepEqual(await worker.operationsCheckout.createCheckout(jobId, commandId), created);
  assert.equal(requests, 1);
});

test("production checkout startup is checkout-only and scoped to one requested job", async () => {
  const client = fakeClient();
  const result = await runOperationsWorkerCommand({
    client, environment, stripe: { checkout: { sessions: { create() { throw new Error("No command was claimed"); } } } },
    jobId,
  });
  assert.equal(result.enabledActionCount, 1);
  const claim = client.calls.find((call) => call.name === "operations:claimCommands");
  assert.deepEqual(claim.input.actions, ["create_checkout"]);
  assert.equal(claim.input.jobId, jobId);
  assert.equal(client.calls.some((call) => call.name === "customerFlow:readJob"), false);
  await assert.rejects(runOperationsWorkerCommand({ client, environment, jobId: "bad" }), /job scope/i);
  await assert.rejects(runOperationsWorkerCommand({
    client, environment: { ...environment, BEBEBONJOUR_OPERATIONS_WORKER_ACTIONS: "create_checkout,generate" }, jobId,
  }), /only.*action|scope/i);
});

test("fenced checkout-only command stores the Stripe test link and completes with canonical outcome", async () => {
  const client = fakeClient();
  let effects = 0;
  let completed;
  const originalMutation = client.mutation.bind(client);
  client.mutation = async (name, input) => {
    if (name === "operations:claimCommands") {
      assert.deepEqual(input.actions, ["create_checkout"]);
      assert.equal(input.jobId, jobId);
      return [{
        commandId, jobId, action: "create_checkout", expectedState: "awaiting_payment",
        expectedVersion: 1, payload: {},
        claim: { workerId: "checkout-worker-1", leaseToken: "checkout-lease-001", leaseExpiresAtMs: Date.now() + 120_000 },
      }];
    }
    if (name === "operations:fenceCommand") {
      if (input.effectMayBeIssued) assert.equal(effects, 0);
      return { active: true };
    }
    if (name === "operations:completeCommand") {
      completed = input.outcome;
      return { ok: true };
    }
    return originalMutation(name, input);
  };
  const result = await runOperationsWorkerCommand({
    client, environment, jobId,
    stripe: { checkout: { sessions: { async create(request) {
      effects += 1;
      assert.equal(request.customer_email, "fictional-parent@example.test");
      return { id: "cs_test_fictional", url: checkoutUrl, livemode: false };
    } } } },
  });
  assert.equal(effects, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(completed, {
    code: "checkout_available", checkoutSessionId: "cs_test_fictional",
    checkoutUrl, jobVersion: 2,
  });
  assert.equal(client.customer.payment.status, "pending");
  assert.equal(client.customer.payment.checkout.operationsCommandId, commandId);
  assert.equal(JSON.stringify(result).includes("fictional-parent"), false);
});

test("operator-private handoff verifies existing capability, refuses enumeration and returns only persisted test URL", async () => {
  const calls = [];
  let requested = false;
  let requestedCommandId;
  const client = {
    async query(name, input) {
      calls.push([name, input]);
      assert.equal(name, "operations:getJob");
      assert.equal(input.operatorToken, operatorToken);
      return {
        summary: { jobId }, fulfillment: { state: "awaiting_payment", version: 1 },
        customer: { payment: { status: "pending", checkout: requested ? { checkoutUrl, sessionId: "cs_test_fictional", mode: "test", operationsCommandId: requestedCommandId } : null } },
        availableActions: requested ? [] : ["create_checkout"],
        commands: requested ? [{ commandId: requestedCommandId, action: "create_checkout", state: "completed", outcome: { checkoutUrl } }] : [],
      };
    },
    async mutation(name, input) {
      calls.push([name, input]);
      assert.equal(name, "operations:requestCommand");
      assert.equal(input.operatorToken, operatorToken);
      assert.equal(input.jobId, jobId);
      assert.equal(input.action, "create_checkout");
      assert.equal(input.expectedState, "awaiting_payment");
      assert.equal(input.expectedVersion, 1);
      assert.deepEqual(input.payload, {});
      requested = true;
      requestedCommandId = input.commandId;
      return { created: true, command: { commandId: input.commandId } };
    },
  };
  const handoff = createTallyCheckoutHandoff({ client, operatorToken, processJob: async (id) => {
    assert.equal(id, jobId);
    assert.equal(requested, true);
    return { claimed: 1, completed: 1, failed: 0 };
  } });
  const result = await handoff(jobId);
  assert.deepEqual(result, { jobId, checkoutUrl });
  assert.equal(calls.length, 3);
  const again = await handoff(jobId);
  assert.deepEqual(again, result);
  assert.equal(calls.length, 4);
  await assert.rejects(handoff("job_missing_001"), /not available/i);
});

test("operator handoff fails closed on absent capability, fake URL, or worker failure", async () => {
  let effects = 0;
  const base = { summary: { jobId }, fulfillment: { state: "awaiting_payment", version: 1 }, customer: { payment: { status: "pending", checkout: null } }, availableActions: [] };
  const handoff = createTallyCheckoutHandoff({
    client: { query: async () => base, mutation: async () => { effects += 1; } },
    operatorToken,
    processJob: async () => { effects += 1; },
  });
  await assert.rejects(handoff(jobId), /not available/i);
  assert.equal(effects, 0);
  const bad = createTallyCheckoutHandoff({
    client: { query: async () => ({ ...base, customer: { payment: { status: "pending", checkout: { checkoutUrl: "https://example.test/fake", mode: "test" } } } }), mutation: async () => { effects += 1; } },
    operatorToken,
    processJob: async () => { effects += 1; },
  });
  await assert.rejects(bad(jobId), /not available/i);
  assert.equal(effects, 0);
});
