import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { ABUSE_POLICY } from "../../convex/abusePolicy.js";
import { createHostedAbuseBudget } from "../../src/http/abuse-budget.mjs";
import { createHostedTallyIntakeProcessor } from "../../src/customer-flow/hosted-tally-intake.mjs";
import { createCustomerFlowService } from "../../src/customer-flow/service.mjs";
import { createConvexCustomerFlowStore } from "../../src/persistence/convex-customer-flow-store.mjs";

const backendToken = "synthetic-backend-token-at-least-32-characters";
const tokenEncryptionKey = Buffer.alloc(32, 9).toString("base64");
function fixture() {
  process.env.CUSTOMER_FLOW_BACKEND_TOKEN = backendToken;
  return convexTest(schema, {
    "./_generated/server.js": () => import("convex/server"),
    "./abuse.js": () => import("../../convex/abuse.js"),
    "./customerFlow.js": () => import("../../convex/customerFlow.js"),
    "./fulfillment.js": () => import("../../convex/fulfillment.js"),
  });
}
async function tallyFixture(client) {
  const signingSecret = "synthetic-tally-signing-secret-32-characters";
  const event = JSON.parse(await readFile(new URL("../fixtures/tally-intake-submission.json", import.meta.url)));
  const fieldMap = JSON.parse(await readFile(new URL("../fixtures/tally-intake-field-map.json", import.meta.url)));
  const process = createHostedTallyIntakeProcessor({ convexClient: client, environment: {
    CONVEX_URL: "https://synthetic.convex.cloud", CUSTOMER_FLOW_BACKEND_TOKEN: backendToken,
    CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
    TALLY_INTAKE_SIGNING_SECRET: signingSecret, TALLY_INTAKE_FORM_ID: event.data.formId,
    TALLY_INTAKE_FIELD_MAP: JSON.stringify(fieldMap),
  } });
  const rawBody = Buffer.from(JSON.stringify(event));
  return { process, rawBody, signature: createHmac("sha256", signingSecret).update(rawBody).digest("base64") };
}

test("synthetic restore preserves encrypted capabilities, retries, limits and private blob bytes", async () => {
  const original = fixture();
  const input = await tallyFixture(original);
  const accepted = await input.process(input);
  const privateBytes = "synthetic private artifact bytes";
  const tables = ["customerFlowJobs", "customerFlowSubmissions", "customerFlowProviderEvents",
    "customerFlowWorkItems", "fulfillmentJobs", "customerFlowAbuseBudgets", "fulfillmentGenerationArtifactSets"];
  await original.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([privateBytes]));
    await ctx.db.insert("fulfillmentGenerationArtifactSets", { jobId: accepted.jobId, revisionId: "r1",
      kind: "synthetic", artifactSet: { storageId } });
    const nowMs = Date.now();
    await ctx.db.insert("customerFlowAbuseBudgets", { scope: "intake", minuteAttempts: 0,
      dayAttempts: ABUSE_POLICY.intake.day, minuteStartedAtMs: Math.floor(nowMs / 60_000) * 60_000,
      dayStartedAtMs: Math.floor(nowMs / 86_400_000) * 86_400_000 });
  });
  // JSON round-trip models a portable snapshot, not the hosted export/import CLI.
  const backup = JSON.parse(JSON.stringify(await original.run(async (ctx) => {
    const data = {};
    for (const table of tables) data[table] = await ctx.db.query(table).collect();
    return data;
  })));
  const blobBytes = await original.run(async (ctx) =>
    (await ctx.storage.get(backup.fulfillmentGenerationArtifactSets[0].artifactSet.storageId)).arrayBuffer());
  const restored = fixture();
  await restored.run(async (ctx) => {
    const restoredStorageId = await ctx.storage.store(new Blob([blobBytes]));
    for (const table of tables) for (const source of backup[table]) {
      const { _id, _creationTime, ...row } = source;
      if (table === "fulfillmentGenerationArtifactSets") row.artifactSet.storageId = restoredStorageId;
      await ctx.db.insert(table, row);
    }
  });
  const store = createConvexCustomerFlowStore({ client: restored, backendToken, tokenEncryptionKey });
  const saved = backup.customerFlowSubmissions[0];
  const replay = await store.createJob(backup.customerFlowJobs[0].job, saved.idempotencyKey,
    { jobId: accepted.jobId, status: "payment_pending", intakeToken: "unused-dummy-token" }, saved.requestDigest);
  assert.equal(replay.created, false);
  assert.match(replay.response.intakeToken, /^tok_[A-Za-z0-9_-]{43}$/);
  const service = createCustomerFlowService({ store,
    paymentGateway: { async createCheckoutSession() { throw new Error("No effects during restore"); } } });
  assert.equal((await service.getStatus(accepted.jobId, replay.response.intakeToken)).jobId, accepted.jobId);
  const retry = await tallyFixture(restored);
  assert.equal((await retry.process(retry)).duplicate, true);
  await assert.rejects(createHostedAbuseBudget({ client: restored, backendToken })("intake"), (e) => e.statusCode === 429);
  const state = await restored.run(async (ctx) => ({ jobs: await ctx.db.query("customerFlowJobs").collect(),
    work: await ctx.db.query("customerFlowWorkItems").collect(),
    artifacts: await ctx.db.query("fulfillmentGenerationArtifactSets").collect() }));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.work.length, 1);
  const restoredText = await restored.run(async (ctx) =>
    (await ctx.storage.get(state.artifacts[0].artifactSet.storageId)).text());
  assert.equal(restoredText, privateBytes);
  assert.equal(state.jobs[0].job.intakeTokenDigest, backup.customerFlowJobs[0].job.intakeTokenDigest);
});
