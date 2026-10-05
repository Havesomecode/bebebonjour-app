import { fixedPrivateIntake, stablePrivateValue } from "./private-generation-authority.mjs";
export const OWNER_TRIAL_SOURCE = "kanban:t_4b1eb28f";
export const OWNER_TRIAL_RECIPIENT = "z@havesomecode.io";
export const OWNER_TRIAL_ACTIONS = new Set(["generate", "approve_content", "render", "generate_narration",
  "approve_narration", "publish", "queue_delivery", "deliver", "reconcile"]);
export function isOwnerTrialJob(customer, job) {
  return /^job_owner_trial_/u.test(customer?.jobId || "") || /^job_owner_trial_/u.test(job?.jobId || "")
    || customer?.ownerTrialAuthority !== undefined || job?.ownerTrialAuthority !== undefined;
}
export function fixedOwnerTrialIntake(jobId) {
  const intake = fixedPrivateIntake(jobId);
  intake.customer.email = OWNER_TRIAL_RECIPIENT;
  intake.notes.specificDemands = "Fully fictional delegated owner trial. Preserve Aélio-Z and أيليو exactly. General Islamic family wishes only; no name meanings or scriptural name associations. Public sanitized announcement; owner-only delivery.";
  return intake;
}
export function matchesOwnerTrialAuthority(customer, job, digest) {
  const a = customer?.ownerTrialAuthority;
  if (!a || !/^[a-f0-9]{64}$/u.test(digest || "")) return false;
  const expected = { version: "delegated-owner-trial-v1", jobId: customer.jobId, intakeDigest: digest,
    ticketId: a.ticketId, ownerSourceReference: OWNER_TRIAL_SOURCE, recipient: OWNER_TRIAL_RECIPIENT,
    origin: a.origin, paymentDisposition: "complimentary_waiver", reviewMode: "delegated_owner_trial" };
  return /^ticket_owner_trial_[a-f0-9]{32}$/u.test(a.ticketId || "")
    && customer.jobId === `job_owner_trial_${a.ticketId.slice(-32)}` && job?.jobId === customer.jobId
    && stablePrivateValue(a) === stablePrivateValue(expected)
    && stablePrivateValue(job.ownerTrialAuthority) === stablePrivateValue(expected)
    && customer.intakeDigest === digest && job.intakeDigest === digest
    && stablePrivateValue(customer.intake) === stablePrivateValue(fixedOwnerTrialIntake(customer.jobId))
    && customer.payment?.status === "waived" && customer.payment.paidAt === null && customer.payment.checkout === null
    && job.payment === null && job.paymentCorrelation === null
    && job.environment === "test" && job.product === "announcement-page" && job.narrationRequired === true;
}
export function assertOwnerTrialOperator(token) {
  const other = ["CUSTOMER_FLOW_BACKEND_TOKEN", "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN", "BEBEBONJOUR_NARRATION_WORKER_TOKEN",
    "BEBEBONJOUR_TTS_WORKER_TOKEN", "BEBEBONJOUR_OWNER_TRIAL_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_COMPLETION_WORKER_TOKEN", "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN"];
  if (process.env.BEBEBONJOUR_OWNER_TRIAL_ENABLED !== "true" || typeof token !== "string" || token.length < 32
    || token !== process.env.BEBEBONJOUR_OPERATIONS_TOKEN || other.some(name => process.env[name] === token)) {
    throw new Error("Owner trial disabled or unauthorized.");
  }
}
