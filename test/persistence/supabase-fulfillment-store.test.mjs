import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseFulfillmentStore } from "../../src/persistence/supabase-fulfillment-store.mjs";

function recordingClient(result = { data: { status: "review_required" }, error: null }) {
  const calls = [];
  return {
    calls,
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return result;
    },
  };
}

test("the Supabase store sends normalized Tally data to its transactional RPC", async () => {
  const client = recordingClient();
  const store = createSupabaseFulfillmentStore({ client });
  const evidence = { payloadSha256: "a".repeat(64) };
  const normalized = {
    source: {
      eventId: "evt_tally_001",
      submissionId: "submission_001",
    },
    payment: { paymentId: "pi_test_001" },
    intake: { customer: { email: "parent@example.com" } },
  };

  const result = await store.ingestTallySubmission(normalized, evidence);

  assert.deepEqual(result, { status: "review_required" });
  assert.deepEqual(client.calls, [{
    name: "ingest_tally_submission_v2",
    parameters: {
      p_event_id: "evt_tally_001",
      p_submission_id: "submission_001",
      p_payment_id: "pi_test_001",
      p_intake: normalized.intake,
      p_payload_sha256: evidence.payloadSha256,
    },
  }]);
});

test("the Supabase store sends normalized Stripe data to its transactional RPC", async () => {
  const client = recordingClient();
  const store = createSupabaseFulfillmentStore({ client });
  const evidence = { payloadSha256: "b".repeat(64) };
  const normalized = {
    source: { eventId: "evt_stripe_001" },
    payment: {
      paymentId: "pi_test_001",
      status: "succeeded",
      amountMinor: 3900,
      currency: "EUR",
      email: "parent@example.com",
    },
  };

  await store.ingestStripePayment(normalized, evidence);

  assert.deepEqual(client.calls, [{
    name: "ingest_stripe_payment_v2",
    parameters: {
      p_event_id: "evt_stripe_001",
      p_payment_id: "pi_test_001",
      p_status: "succeeded",
      p_amount_minor: 3900,
      p_currency: "EUR",
      p_email: "parent@example.com",
      p_payload_sha256: evidence.payloadSha256,
    },
  }]);
});

test("the Supabase store records rejected signed events without raw provider payloads", async () => {
  const client = recordingClient({ data: { duplicate: false, rejected: true }, error: null });
  const store = createSupabaseFulfillmentStore({ client });
  const rejection = {
    provider: "tally",
    eventId: "evt_tally_invalid",
    reasonCode: "normalization_failed",
    payloadSha256: "c".repeat(64),
  };

  const result = await store.recordRejectedProviderEvent(rejection);

  assert.deepEqual(result, { duplicate: false, rejected: true });
  assert.deepEqual(client.calls, [{
    name: "record_rejected_webhook_event",
    parameters: {
      p_provider: rejection.provider,
      p_event_id: rejection.eventId,
      p_reason_code: rejection.reasonCode,
      p_payload_sha256: rejection.payloadSha256,
    },
  }]);
});
