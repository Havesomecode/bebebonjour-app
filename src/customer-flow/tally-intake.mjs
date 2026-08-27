const ACCEPTED_EVENT_TYPE = "FORM_RESPONSE";
const ALLOWED_KEYS = new Set([
  "email",
  "consent",
  "consentOption",
  "languages",
  "languageOptions",
  "voice",
  "voiceOptions",
  "firstName",
  "arabicName",
  "birthDate",
  "babyGender",
  "babyGenderOptions",
  "context",
  "contextOptions",
  "extraRequest",
]);

export class TallyIntakeError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "TallyIntakeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeTallyIntake(event, { expectedFormId, fieldMap }) {
  if (!event || typeof event !== "object" || Array.isArray(event)
      || event.eventType !== ACCEPTED_EVENT_TYPE
      || !identifier(event.eventId)
      || !identifier(event.data?.submissionId)
      || !identifier(event.data?.formId)
      || !Array.isArray(event.data?.fields)) {
    throw invalid("invalid_tally_event");
  }
  if (event.data.formId !== expectedFormId) {
    throw new TallyIntakeError(400, "unexpected_tally_form", "Tally formId does not match the configured intake form.");
  }
  assertFieldMap(fieldMap);

  const approvedFieldKeys = new Set([
    fieldMap.email,
    fieldMap.consent,
    fieldMap.languages,
    fieldMap.voice,
    fieldMap.firstName,
    fieldMap.babyGender,
    fieldMap.context,
    fieldMap.extraRequest,
    fieldMap.arabicName,
    fieldMap.birthDate,
  ].filter(Boolean));
  if (event.data.fields.some((field) => !field || !approvedFieldKeys.has(field.key))) {
    throw invalid("unexpected_tally_field");
  }
  const fields = new Map(event.data.fields.map((field) => [field.key, field]));
  if (fields.size !== event.data.fields.length) {
    throw invalid("duplicate_tally_field");
  }
  const email = requiredText(fields, fieldMap.email, 254).toLowerCase();
  const consent = requiredSelections(fields, fieldMap.consent, "consent_required");
  if (!consent.includes(fieldMap.consentOption)) {
    throw invalid("consent_required");
  }

  const languages = mapSelections(
    requiredSelections(fields, fieldMap.languages),
    fieldMap.languageOptions,
    "languages",
  );
  const voiceGender = singleMappedSelection(fields, fieldMap.voice, fieldMap.voiceOptions, "voice");
  const babyGender = singleMappedSelection(
    fields,
    fieldMap.babyGender,
    fieldMap.babyGenderOptions,
    "baby_gender",
  );
  const spiritualContext = singleMappedSelection(
    fields,
    fieldMap.context,
    fieldMap.contextOptions,
    "context",
  );
  const birthDate = optionalText(fields, fieldMap.birthDate, 10);
  const nameArabic = optionalText(fields, fieldMap.arabicName, 100);
  const request = optionalText(fields, fieldMap.extraRequest, 2_000);

  return {
    source: {
      provider: "tally",
      eventId: event.eventId,
      submissionId: event.data.submissionId,
      formId: event.data.formId,
      submittedAt: event.data.createdAt,
    },
    intake: {
      schemaVersion: "1.0",
      customer: { email, consent: true },
      baby: {
        firstName: requiredText(fields, fieldMap.firstName, 100),
        ...(nameArabic ? { nameArabic } : {}),
        gender: babyGender,
        ...(birthDate ? { birthDate } : {}),
      },
      languages,
      voicePreference: { enabled: true, gender: voiceGender },
      context: { religion: spiritualContext },
      ...(request !== undefined ? { request } : {}),
    },
  };
}

function assertFieldMap(fieldMap) {
  if (!fieldMap || typeof fieldMap !== "object" || Array.isArray(fieldMap)
      || Object.keys(fieldMap).some((key) => !ALLOWED_KEYS.has(key))) {
    throw invalid("invalid_tally_field_map", 500);
  }
  const requiredStrings = [
    "email", "consent", "consentOption", "languages", "voice",
    "firstName", "babyGender", "context", "extraRequest",
  ];
  if (requiredStrings.some((key) => !identifier(fieldMap[key]))) {
    throw invalid("invalid_tally_field_map", 500);
  }
  for (const key of ["languageOptions", "voiceOptions", "babyGenderOptions", "contextOptions"]) {
    const mapping = fieldMap[key];
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)
        || Object.keys(mapping).length === 0
        || Object.entries(mapping).some(([option, value]) => !identifier(option) || !identifier(value))) {
      throw invalid("invalid_tally_field_map", 500);
    }
  }
  for (const optional of ["arabicName", "birthDate"]) {
    if (fieldMap[optional] !== undefined && !identifier(fieldMap[optional])) {
      throw invalid("invalid_tally_field_map", 500);
    }
  }
}

function requiredText(fields, key, maxLength) {
  const value = optionalText(fields, key, maxLength);
  if (!value) throw invalid("invalid_tally_fields");
  return value;
}

function optionalText(fields, key, maxLength) {
  if (!key) return undefined;
  const value = fields.get(key)?.value;
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw invalid("invalid_tally_fields");
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > maxLength) throw invalid("invalid_tally_fields");
  return normalized || undefined;
}

function requiredSelections(fields, key, errorCode = "invalid_tally_fields") {
  const value = fields.get(key)?.value;
  if (!Array.isArray(value) || value.length === 0
      || value.some((selection) => !identifier(selection))) {
    throw invalid(errorCode);
  }
  return value;
}

function singleMappedSelection(fields, key, options, label) {
  const selections = requiredSelections(fields, key);
  if (selections.length !== 1) throw invalid(`invalid_tally_${label}`);
  return mapSelections(selections, options, label)[0];
}

function mapSelections(selections, options, label) {
  const values = selections.map((selection) => options[selection]);
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw invalid(`invalid_tally_${label}`);
  }
  return values;
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function invalid(code, statusCode = 400) {
  const message = code === "consent_required"
    ? "Tally intake consent is required."
    : code === "unexpected_tally_field"
      ? "Tally intake contains an unexpected or unmapped field."
    : "Tally intake is invalid.";
  return new TallyIntakeError(statusCode, code, message);
}
