import { createHmac, timingSafeEqual } from "node:crypto";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

// A one-job, operator-only alternative to the private browser UI. This is
// closed unless the provider deploy has an exact job and a shared signing key.
export function createScopedCheckoutHandler({ environment = process.env, handoff }) {
  return async function scopedCheckout(request, response) {
    if (request.method !== "POST") return response.status(405).json({ code: "method_not_allowed" });
    const jobId = environment.BEBEBONJOUR_CHECKOUT_JOB_ID;
    // Sign with the operator authority that the handoff actually uses, not
    // the broader customer-flow backend credential.
    const key = environment.BEBEBONJOUR_OPERATIONS_TOKEN;
    if (!JOB_ID.test(jobId || "") || typeof key !== "string" || Buffer.byteLength(key) < 32
        || typeof handoff !== "function") {
      return response.status(503).json({ code: "checkout_unavailable" });
    }
    const suppliedJob = request.body?.jobId;
    if (suppliedJob !== jobId || Object.keys(request.body || {}).join() !== "jobId") {
      return response.status(404).json({ code: "checkout_unavailable" });
    }
    const authorization = request.headers?.authorization;
    const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7) : "";
    const expected = createHmac("sha256", key).update(`checkout-handoff:v1:${jobId}`).digest("hex");
    if (!DIGEST.test(supplied)
        || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
      return response.status(401).json({ code: "checkout_unavailable" });
    }
    try {
      const result = await handoff(jobId);
      if (result?.jobId !== jobId || !isStripeTestCheckout(result.checkoutUrl)) {
        throw new Error("Invalid persisted checkout response.");
      }
      response.setHeader?.("Cache-Control", "no-store");
      return response.status(200).json({ jobId, checkoutUrl: result.checkoutUrl });
    } catch {
      return response.status(503).json({ code: "checkout_unavailable" });
    }
  };
}

function isStripeTestCheckout(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
