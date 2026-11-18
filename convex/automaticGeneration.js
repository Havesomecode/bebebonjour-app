// Insert a generation request in the same Convex transaction as the last required gate.
// The signed Stripe webhook writes fulfillment before the customer payment projection;
// a job-scoped editorial approval may arrive on either side of that update.
export async function enqueueApprovedGeneration(context, jobId) {
  const [customerDocument, fulfillmentDocument, editorialApproval] = await Promise.all([
    context.db.query("customerFlowJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId)).unique(),
    context.db.query("fulfillmentJobs")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId)).unique(),
    context.db.query("fulfillmentGenerationEditorialApprovals")
      .withIndex("by_job_id", (query) => query.eq("jobId", jobId)).unique(),
  ]);
  const customer = customerDocument?.job;
  const aggregate = fulfillmentDocument?.aggregate;
  if (!customer || !aggregate || !editorialApproval
    || editorialApproval.approval?.record?.jobId !== jobId
    || aggregate.jobId !== jobId
    || aggregate.product !== "announcement-page"
    || aggregate.environment !== "test"
    || aggregate.state !== "generation_queued"
    || customer.payment?.status !== "paid"
    || !customer.payment.paymentIntentId
    || customer.payment.paymentIntentId !== aggregate.payment?.providerPaymentId
    || !aggregate.payment?.providerEventId
    || aggregate.paymentCorrelation?.jobId !== jobId
    || aggregate.paymentCorrelation?.intakeDigest !== customer.intakeDigest
  ) return false;

  const existing = await context.db.query("customerFlowOperationsCommands")
    .withIndex("by_job_action_version", (query) => query
      .eq("jobId", jobId).eq("action", "generate").eq("expectedVersion", aggregate.version))
    .first();
  // A failed command needs audited reconciliation, never an automatic duplicate retry.
  if (existing) return false;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${jobId}\0${aggregate.version}\0generate`),
  );
  const commandId = `command_auto_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
  const commandCollision = await context.db.query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", commandId)).unique();
  if (commandCollision) throw new Error("Automatic generation command identity collision.");
  const requestedAt = new Date(Date.now()).toISOString();
  await context.db.insert("customerFlowOperationsCommands", {
    commandId,
    jobId,
    action: "generate",
    expectedState: "generation_queued",
    expectedVersion: aggregate.version,
    payload: {},
    requestedAt,
    requestedBy: "automatic_generation",
    state: "pending",
    attempts: 0,
    claim: null,
    lastFailureReason: null,
    outcome: null,
    updatedAt: requestedAt,
  });
  return true;
}
