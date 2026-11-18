import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

const nameResolutionSchema = JSON.parse(
  await readFile(new URL("../../schemas/name-resolution-evidence.schema.json", import.meta.url), "utf8"),
);
const reviewDossierSchema = JSON.parse(
  await readFile(new URL("../../schemas/review-dossier.schema.json", import.meta.url), "utf8"),
);
const narrationManifestSchema = JSON.parse(
  await readFile(new URL("../../schemas/narration-manifest.schema.json", import.meta.url), "utf8"),
);
const narrationReviewSchema = JSON.parse(
  await readFile(new URL("../../schemas/narration-review.schema.json", import.meta.url), "utf8"),
);
const narrationApprovalSchema = JSON.parse(
  await readFile(new URL("../../schemas/narration-approval.schema.json", import.meta.url), "utf8"),
);
const transcriptSchema = JSON.parse(
  await readFile(new URL("../../schemas/transcript.schema.json", import.meta.url), "utf8"),
);
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i;

function isValidRfc3339DateTime(value) {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: {
    "date-time": isValidRfc3339DateTime,
  },
});
ajv.addSchema(nameResolutionSchema);
const validateNameResolutionEvidence = ajv.getSchema(nameResolutionSchema.$id);
const validateReviewDossier = ajv.compile(reviewDossierSchema);
const validateNarrationManifest = ajv.compile(narrationManifestSchema);
const validateNarrationReview = ajv.compile(narrationReviewSchema);
const validateNarrationApproval = ajv.compile(narrationApprovalSchema);
const validateTranscript = ajv.compile(transcriptSchema);

export function assertValidNameResolutionEvidence(evidence) {
  assertSchemaValid("name-resolution evidence", validateNameResolutionEvidence, evidence);
}

export function assertValidReviewDossier(dossier) {
  assertSchemaValid("review dossier", validateReviewDossier, dossier);
}

export function assertValidNarrationManifest(manifest) {
  assertSchemaValid("narration manifest", validateNarrationManifest, manifest);
}

export function assertValidNarrationReview(review) {
  assertSchemaValid("narration review", validateNarrationReview, review);
}

export function assertValidNarrationApproval(approval) {
  assertSchemaValid("narration approval", validateNarrationApproval, approval);
}

export function assertValidTranscript(transcript) {
  assertSchemaValid("transcript", validateTranscript, transcript);
}

function assertSchemaValid(label, validate, value) {
  if (validate(value)) return;

  const details = (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${details || "schema validation failed"}`);
}
