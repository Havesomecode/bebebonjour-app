import { randomUUID } from "node:crypto";

const JOB_ID = /^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

// The job ID alone is not a credential. Only the scoped operator token can read
// the canonical job or request the fenced, checkout-only Operations command.
export function createTallyCheckoutHandoff({ client, operatorToken, processJob }) {
  if (typeof client?.query !== "function" || typeof client?.mutation !== "function"
      || typeof operatorToken !== "string" || operatorToken.length < 32
      || typeof processJob !== "function") {
    throw new Error("Operator checkout handoff dependencies are incomplete.");
  }

  return async function handoff(jobId) {
    if (!JOB_ID.test(jobId || "")) throw unavailable();
    const args = { operatorToken, jobId };
    const detail = await client.query("operations:getJob", args);
    if (detail?.summary?.jobId !== jobId || detail.customer?.payment?.status !== "pending") {
      throw unavailable();
    }
    const existing = checkoutFor(detail);
    if (existing) return { jobId, checkoutUrl: existing.checkoutUrl };
    if (detail.fulfillment?.state !== "awaiting_payment"
        || !Number.isInteger(detail.fulfillment.version)
        || !detail.availableActions?.includes("create_checkout")) {
      throw unavailable();
    }

    const commandId = `command_${randomUUID()}`;
    const request = await client.mutation("operations:requestCommand", {
      ...args,
      commandId,
      action: "create_checkout",
      expectedState: "awaiting_payment",
      expectedVersion: detail.fulfillment.version,
      payload: {},
    });
    if (request?.command?.commandId !== commandId) throw unavailable();
    await processJob(jobId);
    const updated = await client.query("operations:getJob", args);
    const checkout = checkoutFor(updated);
    const command = updated?.commands?.find((entry) => entry.commandId === commandId);
    if (updated?.summary?.jobId !== jobId
        || updated.customer?.payment?.status !== "pending"
        || !checkout
        || checkout.operationsCommandId !== commandId
        || command?.action !== "create_checkout"
        || command.state !== "completed"
        || command.outcome?.checkoutUrl !== checkout.checkoutUrl) {
      throw unavailable();
    }
    return { jobId, checkoutUrl: checkout.checkoutUrl };
  };
}

function checkoutFor(detail) {
  const checkout = detail?.customer?.payment?.checkout;
  if (checkout?.mode !== "test" || typeof checkout.sessionId !== "string"
      || !checkout.sessionId.startsWith("cs_test_")
      || typeof checkout.operationsCommandId !== "string") return null;
  try {
    const url = new URL(checkout.checkoutUrl);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com"
        || url.username || url.password || url.hash) return null;
  } catch {
    return null;
  }
  return checkout;
}

function unavailable() {
  return new Error("Checkout is not available for this job.");
}
