import assert from "node:assert/strict";
import test from "node:test";

import { loadTallyIntakeConfig } from "../../src/config/hosted-customer-flow-config.mjs";

const fieldMap = {
  email: "question_email",
  consent: "question_consent",
  consentOption: "option_yes",
  languages: "question_languages",
  languageOptions: { option_fr: "fr" },
  voice: "question_voice",
  voiceOptions: { option_voice: "female" },
  firstName: "question_first_name",
  arabicName: "question_arabic_name",
  birthDate: "question_birth_date",
  babyGender: "question_gender",
  babyGenderOptions: { option_girl: "girl" },
  context: "question_context",
  contextOptions: { option_general: "general" },
  extraRequest: "question_request",
};

test("Tally intake config is explicit, bounded, and separate from payment config", () => {
  const result = loadTallyIntakeConfig({
    TALLY_INTAKE_SIGNING_SECRET: "tally-signing-secret-at-least-32-characters",
    TALLY_INTAKE_FORM_ID: "form_intake_001",
    TALLY_INTAKE_FIELD_MAP: JSON.stringify(fieldMap),
  });
  assert.deepEqual(result, {
    signingSecret: "tally-signing-secret-at-least-32-characters",
    expectedFormId: "form_intake_001",
    fieldMap,
  });
  assert.equal(JSON.stringify(result).includes("payment"), false);
});

for (const name of [
  "TALLY_INTAKE_SIGNING_SECRET",
  "TALLY_INTAKE_FORM_ID",
  "TALLY_INTAKE_FIELD_MAP",
]) {
  test(`Tally intake config fails closed without ${name}`, () => {
    const environment = {
      TALLY_INTAKE_SIGNING_SECRET: "tally-signing-secret-at-least-32-characters",
      TALLY_INTAKE_FORM_ID: "form_intake_001",
      TALLY_INTAKE_FIELD_MAP: JSON.stringify(fieldMap),
    };
    delete environment[name];
    assert.throws(() => loadTallyIntakeConfig(environment), new RegExp(name));
  });
}
