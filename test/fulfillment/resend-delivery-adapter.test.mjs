import assert from "node:assert/strict";
import test from "node:test";

import { createResendDeliveryAdapter } from "../../src/fulfillment/resend-delivery-adapter.mjs";

const request = {
  jobId: "job_test_001",
  environment: "test",
  product: "announcement-page",
  revisionId: "r1",
  artifactManifestDigest: "a".repeat(64),
  publication: { stableUrl: "https://preview.example.test/announcements/job_test_001" },
  targetDigest: "b".repeat(64),
  idempotencyKey: `bb_${"c".repeat(64)}`,
  attemptStartedAt: "2026-08-18T10:00:00.000Z",
  target: { targetRef: "customer:job_test_001", email: "delivered@resend.dev" },
};

test("Resend delivery adapter sends the approved publication with the persisted idempotency key", async () => {
  const calls = [];
  const resend = {
    emails: {
      async send(payload, options) {
        calls.push({ payload, options });
        return { data: { id: "email_test_001" }, error: null };
      },
    },
  };
  const adapter = createResendDeliveryAdapter({
    resend,
    from: "Bébé Bonjour <delivery@example.test>",
    clock: () => "2026-08-18T10:05:00.000Z",
  });

  const receipt = await adapter.send(request);

  assert.deepEqual(receipt, {
    provider: "resend",
    providerMessageId: "email_test_001",
    revisionId: request.revisionId,
    artifactManifestDigest: request.artifactManifestDigest,
    targetDigest: request.targetDigest,
    idempotencyKey: request.idempotencyKey,
  });
  assert.equal(calls[0].payload.to, request.target.email);
  assert.equal(calls[0].options.idempotencyKey, request.idempotencyKey);
  assert.match(calls[0].payload.html, /https:\/\/preview\.example\.test\/announcements\/job_test_001/);
});

test("Resend delivery adapter maps the provider message status without resending", async () => {
  const resend = {
    emails: {
      async get(messageId) {
        assert.equal(messageId, "email_test_001");
        return { data: { id: messageId, last_event: "delivered" }, error: null };
      },
    },
  };
  const adapter = createResendDeliveryAdapter({
    resend,
    from: "Bébé Bonjour <delivery@example.test>",
    clock: () => "2026-08-18T10:05:00.000Z",
  });

  assert.equal(await adapter.reconcile(request), null);
  assert.deepEqual(await adapter.status({
    environment: "test",
    providerMessageId: "email_test_001",
  }), {
    providerMessageId: "email_test_001",
    outcome: "delivered",
    recordedAt: "2026-08-18T10:05:00.000Z",
    retryable: false,
    reasonCode: null,
  });
});

test("Resend delivery adapter rejects non-sink recipients and expired idempotency windows", async () => {
  let sends = 0;
  const adapter = createResendDeliveryAdapter({
    resend: {
      emails: {
        async send() {
          sends += 1;
          return { data: { id: "unexpected" }, error: null };
        },
      },
    },
    from: "Bébé Bonjour <delivery@example.test>",
    clock: () => "2026-08-19T10:00:01.000Z",
  });

  await assert.rejects(
    adapter.send({
      ...request,
      target: { targetRef: "customer:job_test_001", email: "parent@example.test" },
    }),
    /test sink/i,
  );
  await assert.rejects(adapter.send(request), /idempotency window/i);
  assert.equal(sends, 0);
});
