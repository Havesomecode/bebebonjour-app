import { createHmac, timingSafeEqual } from "node:crypto";

import { assertValidIntake } from "../../scripts/lib/validators.mjs";

export function verifyTallySignature(rawBody, receivedSignature, signingSecret) {
  if (!Buffer.isBuffer(rawBody) || !isNonEmptyString(receivedSignature) || !isNonEmptyString(signingSecret)) {
    return false;
  }
  const expected = Buffer.from(
    createHmac("sha256", signingSecret).update(rawBody).digest("base64"),
    "utf8",
  );
  const received = Buffer.from(receivedSignature, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function normalizeTallySubmission(event, options) {
  const {
    expectedAmount,
    expectedCurrency,
    expectedFormId,
    fieldMap,
  } = options || {};

  assertObject(event, "Tally event");
  assertObject(event.data, "Tally event data");
  assertNonEmptyString(event.eventId, "Tally eventId");
  assertEqual(event.eventType, "FORM_RESPONSE", "Tally eventType");
  assertEqual(event.data.formId, expectedFormId, "Tally formId");
  assertNonEmptyString(event.data.submissionId, "Tally submissionId");
  assertDateTime(event.data.createdAt, "Tally submission createdAt");
  assertObject(fieldMap, "Tally field map");

  const fields = new Map(
    (event.data.fields || []).map((field) => [field.key, field]),
  );
  const email = requiredFieldValue(fields, fieldMap.email, "customer email");
  const languages = mapSelectedOptions(
    requiredFieldValue(fields, fieldMap.languages, "languages"),
    fieldMap.languageOptions,
    "languages",
  );
  const voiceGender = singleMappedOption(
    requiredFieldValue(fields, fieldMap.voice, "voice"),
    fieldMap.voiceOptions,
    "voice",
  );
  const babyGender = singleMappedOption(
    requiredFieldValue(fields, fieldMap.babyGender, "baby gender"),
    fieldMap.babyGenderOptions,
    "baby gender",
  );
  const context = singleMappedOption(
    requiredFieldValue(fields, fieldMap.context, "context"),
    fieldMap.contextOptions,
    "context",
  );
  const firstName = requiredFieldValue(fields, fieldMap.firstName, "baby first name");
  const arabicName = optionalFieldValue(fields, fieldMap.arabicName);
  const specificDemands = optionalFieldValue(fields, fieldMap.extraRequest) || "";

  if (languages.includes("ar") && !isNonEmptyString(arabicName)) {
    throw new Error("Tally field arabic name is required when Arabic is selected.");
  }

  const paymentPrice = requiredFieldValue(fields, fieldMap.payment?.price, "payment price");
  const paymentCurrency = requiredFieldValue(fields, fieldMap.payment?.currency, "payment currency");
  const paymentEmail = requiredFieldValue(fields, fieldMap.payment?.email, "payment email");
  const paymentLink = requiredFieldValue(fields, fieldMap.payment?.link, "payment link");

  assertEqual(paymentPrice, expectedAmount, "Tally payment amount");
  assertEqual(String(paymentCurrency).toUpperCase(), String(expectedCurrency).toUpperCase(), "Tally payment currency");
  assertEqual(String(paymentEmail).trim().toLowerCase(), String(email).trim().toLowerCase(), "Tally payment email");

  const paymentId = stripePaymentIdFromDashboardLink(paymentLink);
  const intake = {
    schemaVersion: "1.0",
    requestId: `tally_${event.data.submissionId}`,
    submittedAt: event.data.createdAt,
    customer: {
      email: String(email).trim(),
    },
    baby: {
      firstName: String(firstName).trim(),
      ...(isNonEmptyString(arabicName) ? { nameArabic: arabicName.trim() } : {}),
      gender: babyGender,
    },
    languages,
    voicePreference: {
      gender: voiceGender,
    },
    context: {
      religion: context === "general" ? null : context,
    },
    notes: {
      specificDemands: String(specificDemands).trim(),
      religiousReferencesHint: [],
    },
  };

  assertValidIntake(intake);

  return {
    source: {
      provider: "tally",
      eventId: event.eventId,
      submissionId: event.data.submissionId,
      formId: event.data.formId,
    },
    payment: {
      provider: "stripe",
      paymentId,
      amount: paymentPrice,
      currency: String(paymentCurrency).toUpperCase(),
      email: String(paymentEmail).trim(),
      verification: "reported_by_tally",
    },
    intake,
  };
}

function requiredFieldValue(fields, key, label) {
  assertNonEmptyString(key, `Tally field map key for ${label}`);
  const field = fields.get(key);
  if (!field || field.value === null || field.value === undefined || field.value === "") {
    throw new Error(`Missing required Tally field: ${label}.`);
  }
  return field.value;
}

function optionalFieldValue(fields, key) {
  if (!isNonEmptyString(key)) return null;
  return fields.get(key)?.value ?? null;
}

function mapSelectedOptions(value, optionMap, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Tally field ${label} must contain at least one selection.`);
  }
  assertObject(optionMap, `Tally option map for ${label}`);
  const mapped = value.map((optionId) => optionMap[optionId]);
  if (mapped.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`Tally field ${label} contains an unmapped option.`);
  }
  return [...new Set(mapped)];
}

function singleMappedOption(value, optionMap, label) {
  const mapped = mapSelectedOptions(value, optionMap, label);
  if (mapped.length !== 1) {
    throw new Error(`Tally field ${label} must contain exactly one selection.`);
  }
  return mapped[0];
}

function stripePaymentIdFromDashboardLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Tally payment link must be a valid URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "dashboard.stripe.com") {
    throw new Error("Tally payment link must point to the Stripe dashboard.");
  }
  const match = url.pathname.match(/\/payments\/([A-Za-z0-9_]+)\/?$/);
  if (!match) {
    throw new Error("Tally payment link does not contain a Stripe payment ID.");
  }
  return match[1];
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} is required.`);
  }
}

function assertDateTime(value, label) {
  assertNonEmptyString(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 date-time.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} did not match the expected value.`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
