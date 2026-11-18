import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTallyIntakeProcessor } from "../../src/customer-flow/tally-intake-webhook.mjs";

const rawBody = await readFile(
  new URL("../fixtures/tally-intake-submission.json", import.meta.url),
);
const fieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-intake-field-map.json", import.meta.url), "utf8"),
);
const signingSecret = "tally-signing-secret-at-least-32-characters";
const signature = createHmac("sha256", signingSecret).update(rawBody).digest("base64");

function harness() {
  const calls = [];
  const events = new Map();
  const eventStore = {
    async claimProviderEvent(providerEventId, fingerprint) {
      const existing = events.get(providerEventId);
      if (existing) return { created: false, event: structuredClone(existing) };
      const event = { fingerprint, result: null };
      events.set(providerEventId, event);
      return { created: true, event: structuredClone(event) };
    },
    async completeProviderEvent(providerEventId, fingerprint, result) {
      const existing = events.get(providerEventId);
      if (!existing || existing.fingerprint !== fingerprint || existing.result) {
        return { completed: false, event: structuredClone(existing || null) };
      }
      existing.result = structuredClone(result);
      return { completed: true, event: structuredClone(existing) };
    },
  };
  const service = {
    async submitIntake(intake, options) {
      calls.push({ intake: structuredClone(intake), options: structuredClone(options) });
      return {
        jobId: "job_tally_001",
        intakeToken: "private-intake-token-must-not-be-persisted-in-provider-event",
        status: "payment_pending",
      };
    },
  };
  return {
    calls,
    events,
    eventStore,
    processor: createTallyIntakeProcessor({
      service,
      eventStore,
      config: {
        signingSecret,
        expectedFormId: "form_intake_001",
        fieldMap,
      },
    }),
  };
}

test("signed Tally intake creates one idempotent Convex customer job", async () => {
  const { calls, processor } = harness();

  const first = await processor({ rawBody, signature });
  const replay = await processor({ rawBody, signature });

  assert.deepEqual(first, { accepted: true, duplicate: false, jobId: "job_tally_001" });
  assert.deepEqual(replay, { accepted: true, duplicate: true, jobId: "job_tally_001" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { idempotencyKey: "tally:submission_001" });
  assert.equal(calls[0].intake.customer.email, "parent@example.com");
  assert.equal(JSON.stringify(first).includes("private-intake-token"), false);
});

test("Tally intake rejects invalid signatures before parsing or persistence", async () => {
  const { calls, processor } = harness();
  await assert.rejects(
    processor({ rawBody, signature: "invalid" }),
    (error) => error.statusCode === 401 && /signature/i.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("same Tally event id with different bytes fails closed", async () => {
  const { processor } = harness();
  await processor({ rawBody, signature });

  const changed = Buffer.from(rawBody.toString("utf8").replace("Amal", "Amel"), "utf8");
  const changedSignature = createHmac("sha256", signingSecret).update(changed).digest("base64");
  await assert.rejects(
    processor({ rawBody: changed, signature: changedSignature }),
    (error) => error.statusCode === 409 && error.code === "provider_event_conflict",
  );
});

test("signed deterministic Tally rejection is durably audited and acknowledged once", async () => {
  const { calls, events, processor } = harness();
  const payload = JSON.parse(rawBody.toString("utf8"));
  payload.data.fields = payload.data.fields.filter(({ key }) => key !== "question_consent");
  const rejectedBody = Buffer.from(JSON.stringify(payload), "utf8");
  const rejectedSignature = createHmac("sha256", signingSecret)
    .update(rejectedBody)
    .digest("base64");

  const first = await processor({ rawBody: rejectedBody, signature: rejectedSignature });
  const replay = await processor({ rawBody: rejectedBody, signature: rejectedSignature });

  assert.deepEqual(first, {
    accepted: true,
    duplicate: false,
    rejected: true,
    reasonCode: "consent_required",
  });
  assert.deepEqual(replay, {
    accepted: true,
    duplicate: true,
    rejected: true,
    reasonCode: "consent_required",
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(events.get(payload.eventId).result, {
    outcome: "rejected",
    reasonCode: "consent_required",
  });
  assert.equal(JSON.stringify(events.get(payload.eventId)).includes("parent@example.com"), false);
});
