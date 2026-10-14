// Isolate-safe: shared by canonical backend checks and the Node worker.
export const PRIVATE_GENERATION_PRODUCT = "operator_private_codex_test";
export const PRIVATE_GENERATION_ACKNOWLEDGEMENT = "fictional-unpaid-codex-private-review-only";
export const PRIVATE_GENERATION_ACTIONS = new Set([
  "generate", "approve_content", "request_content_changes", "reject_content", "render",
]);
export function stablePrivateValue(value) {
  if (Array.isArray(value)) return `[${value.map(stablePrivateValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stablePrivateValue(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function fixedPrivateIntake(jobId) {
  return {
    schemaVersion: "1.0", requestId: jobId, submittedAt: "2026-01-01T00:00:00.000Z",
    customer: { email: "fictional-codex@example.invalid" },
    baby: { firstName: "Aélio-Z", nameArabic: "أيليو", gender: "girl" },
    languages: ["fr", "ar"], voicePreference: { enabled: true, gender: "male" },
    context: { religion: "islam" },
    notes: { specificDemands: "Fully fictional private operator test. General family wishes only; do not invent name meanings or scriptural name associations." },
  };
}
export function validOwnerSourceReference(value) {
  return typeof value === "string" && (
    /^kanban:t_[A-Za-z0-9_-]{3,128}$/u.test(value)
    || /^hermes:session:[0-9]{8}_[0-9]{6}_[a-f0-9]{6}:sha256:[a-f0-9]{64}$/u.test(value)
  );
}
export function isPrivateGenerationJob(customer, fulfillment) {
  return /^job_private_codex_/u.test(customer?.jobId || "")
    || /^job_private_codex_/u.test(fulfillment?.jobId || "")
    || fulfillment?.product === PRIVATE_GENERATION_PRODUCT
    || customer?.privateTestAuthority !== undefined || fulfillment?.privateTestAuthority !== undefined;
}
export function matchesPrivateGenerationAuthority(customer, fulfillment, digest) {
  const authority = customer?.privateTestAuthority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return false;
  const expected = {
    version: "private-fictional-codex-v1", jobId: customer.jobId, intakeDigest: digest,
    environment: "test", product: PRIVATE_GENERATION_PRODUCT,
    acknowledgement: PRIVATE_GENERATION_ACKNOWLEDGEMENT,
    ownerSourceReference: authority.ownerSourceReference, creationKeyDigest: authority.creationKeyDigest,
  };
  return /^[a-f0-9]{64}$/u.test(digest || "")
    && /^[a-f0-9]{64}$/u.test(authority.creationKeyDigest || "")
    && customer.jobId === `job_private_codex_${authority.creationKeyDigest.slice(0, 32)}`
    && fulfillment?.jobId === customer.jobId
    && authority.jobId === customer.jobId
    && validOwnerSourceReference(authority.ownerSourceReference)
    && stablePrivateValue(authority) === stablePrivateValue(expected)
    && stablePrivateValue(fulfillment.privateTestAuthority) === stablePrivateValue(expected)
    && customer.intakeDigest === digest && fulfillment.intakeDigest === digest
    && stablePrivateValue(customer.intake) === stablePrivateValue(fixedPrivateIntake(customer.jobId))
    && customer.payment?.status === "not_applicable"
    && customer.payment.paidAt === null && customer.payment.checkout === null
    && fulfillment.payment === null && fulfillment.paymentCorrelation === null
    && fulfillment.environment === "test" && fulfillment.product === PRIVATE_GENERATION_PRODUCT
    && fulfillment.narrationRequired === true;
}
export function assertPrivateGenerationOperator(token) {
  const forbidden = [
    "CUSTOMER_FLOW_BACKEND_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_NARRATION_WORKER_TOKEN", "BEBEBONJOUR_TTS_WORKER_TOKEN",
    "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",
  ];
  if (process.env.BEBEBONJOUR_PRIVATE_GENERATION_TESTS_ENABLED !== "true"
    || typeof token !== "string" || token.length < 32
    || token !== process.env.BEBEBONJOUR_OPERATIONS_TOKEN
    || forbidden.some(name => process.env[name] && token === process.env[name])) {
    throw new Error("Private fictional test creation disabled or unauthorized.");
  }
}
