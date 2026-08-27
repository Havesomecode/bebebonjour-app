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

test("Tally intake accepts exact provider checkbox expansion rows", () => {
  const expanded = structuredClone(fixture);
  expanded.data.fields.find(({ key }) => key === "question_languages").value = ["option_fr"];
  expanded.data.fields.push(
    {
      key: "question_consent_option_consent_yes",
      label: "Consentement (Oui)",
      type: "CHECKBOXES",
      value: true,
    },
    {
      key: "question_languages_option_fr",
      label: "Langues (Français)",
      type: "CHECKBOXES",
      value: true,
    },
    {
      key: "question_languages_option_ar",
      label: "Langues (Arabe)",
      type: "CHECKBOXES",
      value: false,
    },
  );

  const result = normalizeTallyIntake(expanded, {
    expectedFormId: "form_intake_001",
    fieldMap,
  });

  assert.deepEqual(result.intake.languages, ["fr"]);
  assert.equal(result.intake.customer.consent, true);
});

test("Tally intake rejects inconsistent provider checkbox expansion rows", () => {
  const inconsistent = structuredClone(fixture);
  inconsistent.data.fields.push({
    key: "question_languages_option_fr",
    label: "Langues (Français)",
    type: "CHECKBOXES",
    value: false,
  });

  assert.throws(
    () => normalizeTallyIntake(inconsistent, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    (error) => error?.code === "invalid_tally_checkbox_expansion",
  );
});

test("Tally intake rejects unknown consent selections", () => {
  const unknownConsent = structuredClone(fixture);
  unknownConsent.data.fields.find(({ key }) => key === "question_consent").value = [
    "option_consent_yes",
    "rogue",
  ];

  assert.throws(
    () => normalizeTallyIntake(unknownConsent, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    (error) => error?.code === "invalid_tally_consent",
  );
});

test("Tally intake rejects inherited option names", () => {
  const inheritedOption = structuredClone(fixture);
  inheritedOption.data.fields.find(({ key }) => key === "question_languages").value = ["toString"];

  assert.throws(
    () => normalizeTallyIntake(inheritedOption, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    (error) => error?.code === "invalid_tally_languages",
  );
});

test("Tally intake rejects payment-typed approved parent fields", () => {
  const paymentParent = structuredClone(fixture);
  paymentParent.data.fields.find(({ key }) => key === "question_languages").type = "PAYMENT";

  assert.throws(
    () => normalizeTallyIntake(paymentParent, {
      expectedFormId: "form_intake_001",
      fieldMap,
    }),
    (error) => error?.code === "invalid_tally_field_type",
  );
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
