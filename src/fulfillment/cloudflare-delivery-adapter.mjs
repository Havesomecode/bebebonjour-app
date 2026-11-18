import { createHash } from "node:crypto";
import { createCloudflareEmailTransport } from "./cloudflare-email-transport.mjs";

// Opt-in replacement at the existing fulfillment adapter seam, never a change
// to the running TEST-A/owner/automatic delivery worker's provider selection.
export function createCloudflareDeliveryAdapter(options = {}) {
  const policy = Object.freeze({ ...options.policy });
  if (!/^job_[A-Za-z0-9_-]+$/u.test(policy.jobId || "")
      || !/^r[1-9][0-9]*$/u.test(policy.revisionId || "")
      || !/^[a-f0-9]{64}$/u.test(policy.artifactManifestDigest || "")
      || typeof policy.targetRef !== "string" || !policy.targetRef.trim()
      || typeof policy.recipient !== "string"
      || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(policy.recipient)
      || policy.recipient.length > 254 || !exactHttpsUrl(policy.stableUrl)) throw policyFailure();
  const targetDigest = createHash("sha256").update(JSON.stringify({ email: policy.recipient, targetRef: policy.targetRef })).digest("hex");
  const transport = createCloudflareEmailTransport(options);
  const clock = options.clock || (() => new Date().toISOString());

  function assertIdentity(request) {
    if (request?.environment !== "test" || request.jobId !== policy.jobId
        || request.revisionId !== policy.revisionId) throw policyFailure();
  }
  return Object.freeze({
    reconcile: transport.reconcile,
    async send(request) {
      assertIdentity(request);
      const started = Date.parse(request.attemptStartedAt);
      const checked = Date.parse(clock());
      if (request.reconciliationOnly === true) throw new Error("Cloudflare send requires reconciliation, not a new effect.");
      if (request.artifactManifestDigest !== policy.artifactManifestDigest
          || request.product !== "announcement-page" || request.targetDigest !== targetDigest
          || request.target?.email !== policy.recipient || request.target?.targetRef !== policy.targetRef
          || Object.keys(request.target).some(key => !["email", "targetRef"].includes(key))
          || request.publication?.stableUrl !== policy.stableUrl
          || !Number.isFinite(started) || !Number.isFinite(checked) || checked < started) throw policyFailure();
      const url = escapeHtml(policy.stableUrl);
      const receipt = await transport.send({ to: policy.recipient,
        subject: "Votre annonce Bébé Bonjour est prête",
        html: `<p>Bonjour,</p><p>Votre annonce Bébé Bonjour est prête.</p><p><a href="${url}">Découvrir l’annonce</a></p>`,
        text: `Bonjour,\n\nVotre annonce Bébé Bonjour est prête.\n\nDécouvrir l’annonce : ${policy.stableUrl}`,
        idempotencyKey: request.idempotencyKey }, { fenceExternalEffect: request.fenceExternalEffect });
      return { ...receipt, revisionId: request.revisionId, artifactManifestDigest: request.artifactManifestDigest, targetDigest };
    },
    async status(request) {
      assertIdentity(request);
      // Historical Resend receipts must be inspected with Resend, not migrated.
      if (request.provider !== "cloudflare") throw policyFailure();
      return transport.status(request);
    },
  });
}

function exactHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === value && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function policyFailure() {
  return Object.assign(new Error("Cloudflare exact test policy mismatch."), { reasonCode: "cloudflare_policy_invalid", retryable: false });
}
