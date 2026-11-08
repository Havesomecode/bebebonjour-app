import { randomUUID } from "node:crypto";
import { emailPayloadDigest } from "../email-effects.mjs";

export async function syntheticEmailIntent(pool, overrides = {}) {
  const jobId = `job_${randomUUID().replaceAll("-", "")}`;
  await pool.query("INSERT INTO bb_candidate.customer_jobs(job_id,job) VALUES ($1,$2)", [jobId,
    { jobId, version: 1, intake: { customer: { email: "ledger@example.test" } } }]);
  const idempotencyKey = `bebe-loop:${jobId}:1:draft_email`;
  const message = { to: "ledger@example.test", subject: "Annonce synthétique", text: "Un message synthétique.",
    html: "<p>Un message synthétique.</p>", idempotencyKey };
  return { message, intent: { jobId, revision: 1, stage: "draft_email", provider: "cloudflare",
    idempotencyKey, payloadDigest: emailPayloadDigest(message), leaseToken: `synthetic-private-lease-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides } };
}
