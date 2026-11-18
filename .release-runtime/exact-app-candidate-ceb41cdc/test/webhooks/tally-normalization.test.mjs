import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeTallySubmission } from "../../src/webhooks/tally.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/tally-paid-submission.json", import.meta.url), "utf8"),
);
const fieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-field-map.json", import.meta.url), "utf8"),
);

test("a paid Tally submission normalizes to the canonical intake contract", () => {
  const result = normalizeTallySubmission(fixture, {
    expectedFormId: "form_test_001",
    expectedAmount: 39,
    expectedCurrency: "EUR",
    fieldMap,
  });

  assert.deepEqual(result.source, {
    provider: "tally",
    eventId: "evt_tally_001",
    submissionId: "submission_001",
    formId: "form_test_001",
  });
  assert.deepEqual(result.payment, {
    provider: "stripe",
    paymentId: "pi_test_001",
    amount: 39,
    currency: "EUR",
    email: "parent@example.com",
    verification: "reported_by_tally",
  });
  assert.deepEqual(result.intake, {
    schemaVersion: "1.0",
    requestId: "tally_submission_001",
    submittedAt: "2026-08-02T12:29:59.000Z",
    customer: {
      email: "parent@example.com",
    },
    baby: {
      firstName: "Amal",
      nameArabic: "أمل",
      gender: "girl",
    },
    languages: ["fr", "ar"],
    voicePreference: {
      gender: "female",
    },
    context: {
      religion: "islam",
    },
    notes: {
      specificDemands: "Une annonce douce et spirituelle.",
      religiousReferencesHint: [],
    },
  });
});
