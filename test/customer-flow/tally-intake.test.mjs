import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeTallyIntake } from "../../src/customer-flow/tally-intake.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/tally-intake-submission.json", import.meta.url), "utf8"),
);
const fieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-intake-field-map.json", import.meta.url), "utf8"),
);

test("Tally intake normalizes to the canonical unpaid customer-flow contract", () => {
  const result = normalizeTallyIntake(fixture, {
    expectedFormId: "form_intake_001",
    fieldMap,
  });

  assert.deepEqual(result.source, {
    provider: "tally",
    eventId: "evt_tally_intake_001",
    submissionId: "submission_001",
    formId: "form_intake_001",
    submittedAt: "2026-08-27T10:29:59.000Z",
  });
  assert.deepEqual(result.intake, {
    schemaVersion: "1.0",
    customer: {
      email: "parent@example.com",
      consent: true,
    },
    baby: {
      firstName: "Amal",
      nameArabic: "أمل",
      gender: "girl",
      birthDate: "2026-08-20",
    },
    languages: ["fr", "ar"],
    voicePreference: {
      enabled: true,
      gender: "female",
    },
    context: {
      religion: "islam",
    },
    request: "Une annonce douce et spirituelle.",
  });
  assert.equal(JSON.stringify(result).includes("payment"), false);
});

test("Tally intake requires explicit consent and rejects unmapped fields", () => {
  const withoutConsent = structuredClone(fixture);
  withoutConsent.data.fields.find(({ key }) => key === "question_consent").value = [];
  assert.throws(
    () => normalizeTallyIntake(withoutConsent, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    /consent/i,
  );

  const wrongForm = structuredClone(fixture);
  wrongForm.data.formId = "other_form";
  assert.throws(
    () => normalizeTallyIntake(wrongForm, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    /formId/i,
  );

  const withPaymentField = structuredClone(fixture);
  withPaymentField.data.fields.push({
    key: "payment_block",
    type: "PAYMENT",
    value: { amount: 3900, currency: "EUR" },
  });
  assert.throws(
    () => normalizeTallyIntake(withPaymentField, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    /unmapped|unexpected/i,
  );
});
