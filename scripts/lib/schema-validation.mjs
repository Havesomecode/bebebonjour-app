import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

const nameResolutionSchema = JSON.parse(
  await readFile(new URL("../../schemas/name-resolution-evidence.schema.json", import.meta.url), "utf8"),
);
const reviewDossierSchema = JSON.parse(
  await readFile(new URL("../../schemas/review-dossier.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(nameResolutionSchema);
const validateNameResolutionEvidence = ajv.getSchema(nameResolutionSchema.$id);
const validateReviewDossier = ajv.compile(reviewDossierSchema);

export function assertValidNameResolutionEvidence(evidence) {
  assertSchemaValid("name-resolution evidence", validateNameResolutionEvidence, evidence);
}

export function assertValidReviewDossier(dossier) {
  assertSchemaValid("review dossier", validateReviewDossier, dossier);
}

function assertSchemaValid(label, validate, value) {
  if (validate(value)) return;

  const details = (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${details || "schema validation failed"}`);
}
