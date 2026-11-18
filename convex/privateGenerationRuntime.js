"use node";
import { actionGeneric, makeFunctionReference as ref } from "convex/server";
import { v } from "convex/values";
import { createHash } from "node:crypto";
import { createJobAggregate } from "../src/fulfillment/job-machine.mjs";
import { assertValidIntake } from "../scripts/lib/validators.mjs";
import {
  PRIVATE_GENERATION_PRODUCT, PRIVATE_GENERATION_ACKNOWLEDGEMENT,
  fixedPrivateIntake, stablePrivateValue, validOwnerSourceReference, assertPrivateGenerationOperator,
} from "../src/fulfillment/private-generation-authority.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
export const createFictionalTest = actionGeneric({
  args: { operatorToken: v.string(), acknowledgement: v.string(), ownerSourceReference: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    assertPrivateGenerationOperator(args.operatorToken);
    if (args.acknowledgement !== PRIVATE_GENERATION_ACKNOWLEDGEMENT
      || !validOwnerSourceReference(args.ownerSourceReference)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(args.idempotencyKey)) {
      throw new Error("Invalid private fictional creation request.");
    }
    const creationKeyDigest = hash(`private-fictional-codex-v1:${args.idempotencyKey}`);
    const jobId = `job_private_codex_${creationKeyDigest.slice(0, 32)}`;
    const intake = fixedPrivateIntake(jobId);
    assertValidIntake(intake);
    const intakeDigest = hash(stablePrivateValue(intake));
    const at = new Date().toISOString();
    const privateTestAuthority = {
      version: "private-fictional-codex-v1", jobId, intakeDigest, environment: "test",
      product: PRIVATE_GENERATION_PRODUCT, acknowledgement: args.acknowledgement,
      ownerSourceReference: args.ownerSourceReference, creationKeyDigest,
    };
    // Reuse the canonical aggregate shape, but do not record a fictional payment.
    const aggregate = createJobAggregate({ jobId, environment: "test", product: PRIVATE_GENERATION_PRODUCT,
      intakeDigest, narrationRequired: true, paymentCorrelation: {
        project: "bebebonjour", product: PRIVATE_GENERATION_PRODUCT, environment: "test", jobId, intakeDigest,
      } }, { commandId: `private-create:${creationKeyDigest}`, at });
    aggregate.paymentCorrelation = null;
    aggregate.state = "generation_queued";
    aggregate.privateTestAuthority = privateTestAuthority;
    aggregate.events[0].state = "generation_queued";
    const customer = { schemaVersion: "1.0", jobId, version: 1, createdAt: at, updatedAt: at,
      intakeDigest, intake, privateTestAuthority,
      payment: { status: "not_applicable", paidAt: null, checkout: null }, events: [] };
    return ctx.runMutation(ref("privateGeneration:insertFictionalTest"), { operatorToken: args.operatorToken, customer, aggregate });
  },
});
