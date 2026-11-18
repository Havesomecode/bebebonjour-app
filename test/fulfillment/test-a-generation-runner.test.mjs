import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTestAGenerationRunner } from "../../src/fulfillment/test-a-generation-runner.mjs";
import { createLocalGenerationWorkspace } from "../../src/fulfillment/local-generation-workspace.mjs";
import { createLocalPrepareReviewStageHandler } from "../../src/fulfillment/local-prepare-review-stage-handler.mjs";
import { createLocalTestFulfillmentStore } from "../../src/persistence/local-test-fulfillment-store.mjs";

const JOB_ID = "job_generation_only_001";
const INTAKE_DIGEST = "a".repeat(64);
const EDITORIAL_POLICY = Object.freeze({
  id: "unknown_name_general_wishes",
  preserveSubmittedName: true,
  meaningAllowed: false,
  scripturalNameAssociationAllowed: false,
  genericBlessingsAllowed: true,
  maxStage: "content_review_required",
});
const EDITORIAL_APPROVAL = editorialApprovalFor("kanban:t_synthetic_authority");
const BASE_INTAKE = JSON.parse(
  await readFile(new URL("../../data/examples/bayane/intake.json", import.meta.url), "utf8"),
);
const CUSTOMER = Object.freeze({
  schemaVersion: "1.0",
  jobId: JOB_ID,
  intakeDigest: INTAKE_DIGEST,
  intake: {
    schemaVersion: "1.0",
    requestId: JOB_ID,
    customer: { email: "synthetic-private@example.test", consent: true },
    baby: { firstName: "Synthetic Private Name", gender: "neutral" },
    languages: ["fr"],
    voicePreference: { enabled: false, gender: "neutral" },
  },
  payment: { status: "paid" },
});

function unusedGenerationStoreMethods() {
  const unused = async () => {
    throw new Error("unexpected generation store mutation");
  };
  return {
    completeStage: unused,
    failStage: unused,
    recoverFailedPrepareReview: unused,
    resumeRetry: unused,
  };
}

function editorialApprovalFor(reference) {
  const sourceEvidence = {
    kind: "kanban_human_decision",
    reference,
  };
  const record = {
    schemaVersion: "1.0",
    approvalType: "job_scoped_editorial_policy",
    jobId: JOB_ID,
    policy: EDITORIAL_POLICY,
    sourceEvidence,
    sourceDigest: createHash("sha256")
      .update(JSON.stringify(sourceEvidence))
      .digest("hex"),
  };
  return Object.freeze({
    record: Object.freeze(record),
    recordDigest: createHash("sha256")
      .update(`${JSON.stringify(record, null, 2)}\n`)
      .digest("hex"),
  });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backingStore = createLocalTestFulfillmentStore({ filePath: path.join(root, "store.json") });
  const jobInput = {
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: INTAKE_DIGEST,
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: JOB_ID,
      intakeDigest: INTAKE_DIGEST,
    },
    narrationRequired: false,
  };
  await backingStore.createJob(jobInput, {
    commandId: "create-generation-only-fixture",
    at: "2026-08-30T09:00:00.000Z",
  });
  await backingStore.recordPayment(JOB_ID, {
    commandId: "pay-generation-only-fixture",
    providerEventId: "evt_generation_only_fixture",
    providerPaymentId: "pi_generation_only_fixture",
    correlation: jobInput.paymentCorrelation,
    recordedAt: "2026-08-30T09:00:00.000Z",
  }, "2026-08-30T09:00:00.000Z");

  const calls = [];
  const workspace = {
    async persistJobInput(value) {
      calls.push({ kind: "persist", value: structuredClone(value) });
    },
    async validateGeneratedReplay() {
      return { approvalMatches: true };
    },
  };
  const prepareReview = options.prepareReview || (async () => {
    calls.push({ kind: "prepare_review" });
    return {
      revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
      artifactSet: {
        kind: "private_review",
        revisionId: "r1",
        pageDigest: "b".repeat(64),
        transcriptDigest: "c".repeat(64),
        assetManifestDigest: "d".repeat(64),
        manifestRef: "jobs/job_generation_only_001/revisions/r1/manifests/private_review.json",
        files: [],
      },
    };
  });
  const store = new Proxy(backingStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push({ kind: `store:${String(property)}` });
        return value.apply(target, args);
      };
    },
  });
  const customer = structuredClone(options.customer || CUSTOMER);
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => customer },
    store,
    workspace,
    prepareReview,
    clock: options.clock || (() => "2026-08-30T09:00:01.000Z"),
    tokenFactory: () => "generation-only-lease",
    retryPolicy: options.retryPolicy,
  });
  return { backingStore, calls, root, runner };
}

test("generation runner binds an Operations command through its real stage orchestration", async (t) => {
  const context = await fixture(t);
  const operationsCommandId = "command_generation_provenance_000001";
  let boundaries = 0;

  const result = await context.runner.generate(JOB_ID, {
    operationsCommandId,
    async operationsEffectBoundary(details, invokeStage) {
      boundaries += 1;
      assert.equal(details.jobId, JOB_ID);
      assert.equal(details.stage, "prepare_review");
      assert.equal(details.operationsCommandId, operationsCommandId);
      return invokeStage();
    },
  });

  assert.equal(result.state, "content_review_required");
  assert.equal(boundaries, 1);
  const aggregate = await context.backingStore.getJob(JOB_ID);
  assert.equal(aggregate.artifactSets[0].operationsCommandId, operationsCommandId);
});

function productionRunner(context, artifactRoot, editorialApproval = EDITORIAL_APPROVAL) {
  return createTestAGenerationRunner({
    editorialApproval,
    customerReader: {
      readJob: async () => structuredClone(context.productionCustomer || CUSTOMER),
    },
    store: context.backingStore,
    artifactRoot,
    async prepareReviewCommand(args, options) {
      if (context.generated) throw new Error("replay must not invoke prepare-review");
      const { commandPrepareReview } = await import("../../scripts/lib/commands.mjs");
      return commandPrepareReview(args, options);
    },
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });
}

async function generatedProductionFixture(t) {
  const context = await fixture(t);
  const intake = structuredClone(BASE_INTAKE);
  intake.requestId = JOB_ID;
  intake.customer.email = "synthetic-private@example.test";
  intake.baby.firstName = "Aélio-Z";
  intake.baby.nameArabic = "أيليو";
  context.productionCustomer = { ...structuredClone(CUSTOMER), intake };
  const artifactRoot = path.join(context.root, "terminal-replay-private-root");
  const runner = productionRunner(context, artifactRoot);
  await runner.generate(JOB_ID);
  context.generated = true;
  return { ...context, artifactRoot, runner };
}

async function snapshotTree(root) {
  const snapshot = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        snapshot.push({ path: `${relative}/`, type: "directory" });
        await visit(entryPath);
      } else if (entry.isFile()) {
        const bytes = await readFile(entryPath);
        snapshot.push({
          path: relative,
          type: "file",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
      } else {
        snapshot.push({ path: relative, type: "other" });
      }
    }
  }
  await visit(root);
  return snapshot;
}

function createFifo(filePath) {
  const result = spawnSync("mkfifo", [filePath], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `mkfifo failed: ${result.stderr || result.stdout}`,
  );
}

test("generation-only runner persists canonical intake, advances only prepare_review, and returns PII-free output", async (t) => {
  const { backingStore, calls, runner } = await fixture(t);

  assert.deepEqual(Object.keys(runner), ["generate"]);
  const result = await runner.generate(JOB_ID);

  assert.deepEqual(result, {
    jobId: JOB_ID,
    outcome: "generated",
    state: "content_review_required",
    revisionId: "r1",
    intakeDigest: INTAKE_DIGEST,
  });
  assert.equal(JSON.stringify(result).includes("Synthetic Private Name"), false);
  assert.equal(JSON.stringify(result).includes("synthetic-private@example.test"), false);
  assert.deepEqual(calls[0], { kind: "store:getJob" });
  assert.equal(calls[1].kind, "persist");
  assert.deepEqual(calls[1].value, {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: CUSTOMER.intake,
    editorialApproval: EDITORIAL_APPROVAL,
    requireExisting: false,
  });
  assert.equal(calls.filter(({ kind }) => kind === "prepare_review").length, 1);
  assert.equal((await backingStore.getJob(JOB_ID)).state, "content_review_required");
  assert.equal(calls.some(({ kind }) => /recordReview|queueDelivery|confirmDelivery|reconcileDelivery/u.test(kind)), false);
});

test("production generation path uses the deterministic prepare-review workspace beneath the private root", async (t) => {
  const context = await fixture(t);
  const artifactRoot = path.join(context.root, "approved-private-root");
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: context.backingStore,
    artifactRoot,
    async prepareReviewCommand({ input, output }, commandOptions) {
      assert.deepEqual(commandOptions, {
        editorialApproval: EDITORIAL_APPROVAL,
        intakeSnapshot: CUSTOMER.intake,
        silent: true,
      });
      const persisted = JSON.parse(await readFile(input, "utf8"));
      assert.deepEqual(persisted.intake, CUSTOMER.intake);
      const current = path.join(output, "artifacts", "current");
      await mkdir(current, { recursive: true });
      await writeFile(path.join(current, "page.json"), '{"synthetic":true}\n', "utf8");
      await writeFile(path.join(current, "transcript.json"), '{"tracks":{}}\n', "utf8");
      await writeFile(path.join(output, "review.json"), '{"state":"review_required"}\n', "utf8");
    },
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });

  const result = await runner.generate(JOB_ID);
  assert.equal(result.state, "content_review_required");
  const inputRecordPath = path.join(artifactRoot, "jobs", JOB_ID, "input", "generation-input.json");
  assert.deepEqual(JSON.parse(await readFile(inputRecordPath, "utf8")).intake, CUSTOMER.intake);
  assert.equal((await stat(inputRecordPath)).mode & 0o777, 0o600);
  const aggregate = await context.backingStore.getJob(JOB_ID);
  assert.equal(aggregate.artifactSets.length, 1);
  assert.equal(aggregate.artifactSets[0].kind, "private_review");
});

test("generation-only end to end produces the approved neutral unknown-name dossier and stops for review", async (t) => {
  const intake = structuredClone(BASE_INTAKE);
  intake.requestId = JOB_ID;
  intake.customer.email = "synthetic-private@example.test";
  intake.baby.firstName = "Aélio-Z";
  intake.baby.nameArabic = "أيليو";
  intake.context.religion = "islam";
  const customer = { ...structuredClone(CUSTOMER), intake };
  const context = await fixture(t, { customer });
  const artifactRoot = path.join(context.root, "approved-unknown-name-private-root");
  await mkdir(artifactRoot, { mode: 0o700 });
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(customer) },
    store: context.backingStore,
    artifactRoot,
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });

  const result = await runner.generate(JOB_ID);

  assert.equal(result.outcome, "generated");
  assert.equal(result.state, "content_review_required");
  const revisionRoot = path.join(artifactRoot, "jobs", JOB_ID, "revisions", "r1");
  const reviewRoot = path.join(revisionRoot, "private-review");
  const dossier = JSON.parse(await readFile(path.join(reviewRoot, "review.json"), "utf8"));
  const page = JSON.parse(
    await readFile(path.join(reviewRoot, "artifacts", "current", "page.json"), "utf8"),
  );
  assert.deepEqual(dossier.generationMaterials.editorialApproval.policy, EDITORIAL_APPROVAL.record.policy);
  assert.equal(dossier.generationMaterials.editorialApproval.recordDigest, EDITORIAL_APPROVAL.recordDigest);
  assert.equal(page.identity.nameLatin, "Aélio-Z");
  assert.equal(page.identity.nameArabic, "أيليو");
  assert.equal(page.provenance.nameResolution.match.kind, "unknown");
  assert.equal(page.provenance.nameResolution.claimPolicy.meaningAllowed, false);
  assert.equal(
    page.provenance.nameResolution.claimPolicy.scripturalNameAssociationAllowed,
    false,
  );
  assert.deepEqual(page.review.requiredReasons, ["name_not_in_catalog"]);
  assert.equal(JSON.stringify(page).includes("religious-generic-islam"), false);
  const persistedAggregate = await context.backingStore.getJob(JOB_ID);
  const persistedArtifacts = JSON.stringify(persistedAggregate.artifactSets);
  assert.equal(persistedArtifacts.includes("Aélio-Z"), false);
  assert.equal(persistedArtifacts.includes("aelio-z"), false);
  assert.equal(persistedArtifacts.includes("synthetic-private@example.test"), false);
  for (const forbidden of ["approved", "prepared", "narration-review", "final"]) {
    await assert.rejects(access(path.join(revisionRoot, forbidden)), { code: "ENOENT" });
  }
});

test("legacy generation input is enriched once with the exact job-scoped approval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-legacy-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = createLocalGenerationWorkspace({ rootPath: root });
  const input = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    selectionId: null,
  };
  const paths = await workspace.persistJobInput(input);
  const legacyRecord = JSON.parse(await readFile(paths.recordPath, "utf8"));
  await assert.rejects(access(path.join(root, "jobs", JOB_ID, "input", "intake.json")), { code: "ENOENT" });

  const enrichedPaths = await workspace.persistJobInput({
    ...input,
    editorialApproval: EDITORIAL_APPROVAL,
  });

  assert.deepEqual(enrichedPaths, paths);
  const enrichedRaw = await readFile(paths.recordPath, "utf8");
  const enrichedRecord = JSON.parse(enrichedRaw);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(enrichedRecord).filter(([key]) => key !== "editorialApproval"),
    ),
    legacyRecord,
  );
  assert.deepEqual(enrichedRecord.editorialApproval, EDITORIAL_APPROVAL);

  await workspace.persistJobInput({ ...input, editorialApproval: EDITORIAL_APPROVAL });
  assert.equal(await readFile(paths.recordPath, "utf8"), enrichedRaw);
});

test("concurrent legacy enrichment permits exactly one approval identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-concurrent-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = createLocalGenerationWorkspace({ rootPath: root });
  const input = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    selectionId: null,
  };
  const paths = await workspace.persistJobInput(input);
  const competingApproval = editorialApprovalFor("kanban:t_competing_authority");

  const results = await Promise.allSettled([
    workspace.persistJobInput({ ...input, editorialApproval: EDITORIAL_APPROVAL }),
    workspace.persistJobInput({ ...input, editorialApproval: competingApproval }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  const persisted = JSON.parse(await readFile(paths.recordPath, "utf8"));
  const fulfilledIndex = results.findIndex(({ status }) => status === "fulfilled");
  assert.deepEqual(
    persisted.editorialApproval,
    fulfilledIndex === 0 ? EDITORIAL_APPROVAL : competingApproval,
  );
});

test("failed atomic input persistence leaves no partial workspace files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-partial-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "jobs", JOB_ID, "input");
  await mkdir(path.join(inputRoot, "generation-input.json"), { recursive: true });
  const workspace = createLocalGenerationWorkspace({ rootPath: root });

  await assert.rejects(workspace.persistJobInput({
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    editorialApproval: EDITORIAL_APPROVAL,
  }));

  assert.deepEqual(await readdir(inputRoot), ["generation-input.json"]);
});

test("input persistence recovers a lock whose owner process no longer exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-stale-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "jobs", JOB_ID, "input");
  await mkdir(inputRoot, { recursive: true });
  await writeFile(path.join(inputRoot, "generation-input.lock"), `${JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-lock-owner-token",
    createdAtMs: Date.now() - 60_000,
  })}\n`, { mode: 0o600 });
  const workspace = createLocalGenerationWorkspace({ rootPath: root });

  const persisted = await workspace.persistJobInput({
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    editorialApproval: EDITORIAL_APPROVAL,
  });
  assert.equal(JSON.parse(await readFile(persisted.recordPath, "utf8")).jobId, JOB_ID);
  await assert.rejects(access(path.join(inputRoot, "generation-input.lock")), { code: "ENOENT" });
});

test("input persistence recovers abandoned same-process and partial stale locks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-lock-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "jobs", JOB_ID, "input");
  const lockPath = path.join(inputRoot, "generation-input.lock");
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });
  await writeFile(lockPath, `${JSON.stringify({
    pid: process.pid,
    token: "abandoned-same-process-token",
    createdAtMs: Date.now() - 60_000,
  })}\n`, { mode: 0o600 });

  const workspace = createLocalGenerationWorkspace({ rootPath: root });
  const input = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    editorialApproval: EDITORIAL_APPROVAL,
  };
  await workspace.persistJobInput(input);

  await rm(path.join(inputRoot, "generation-input.json"));
  await writeFile(lockPath, "", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await workspace.persistJobInput(input);

  await assert.rejects(access(lockPath), { code: "ENOENT" });
});

test("legacy approval enrichment rejects every input or authority drift without mutation", async (t) => {
  const scenarios = [
    {
      name: "changed canonical intake",
      mutateCall(value) {
        value.intake.languages = ["fr", "ar"];
      },
    },
    {
      name: "changed selection identity",
      mutateCall(value) {
        value.selectionId = "different-selection";
      },
    },
    {
      name: "malformed supplied approval",
      mutateCall(value) {
        value.editorialApproval.recordDigest = "f".repeat(64);
      },
    },
    {
      name: "second valid approval identity",
      enrichFirst: true,
      mutateCall(value) {
        value.editorialApproval = structuredClone(
          editorialApprovalFor("kanban:t_different_authority"),
        );
      },
    },
    {
      name: "persisted record drift",
      async mutateWorkspace(paths) {
        const record = JSON.parse(await readFile(paths.recordPath, "utf8"));
        record.unexpected = true;
        await writeFile(paths.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      },
    },
    {
      name: "noncanonical persisted input bytes",
      async mutateWorkspace(paths) {
        const record = JSON.parse(await readFile(paths.recordPath, "utf8"));
        await writeFile(paths.recordPath, JSON.stringify(record), "utf8");
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-reject-drift-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const workspace = createLocalGenerationWorkspace({ rootPath: root });
      const legacyInput = {
        jobId: JOB_ID,
        intakeDigest: INTAKE_DIGEST,
        intake: structuredClone(CUSTOMER.intake),
        selectionId: null,
      };
      const paths = await workspace.persistJobInput(legacyInput);
      if (scenario.enrichFirst) {
        await workspace.persistJobInput({
          ...legacyInput,
          editorialApproval: EDITORIAL_APPROVAL,
        });
      }
      if (scenario.mutateWorkspace) await scenario.mutateWorkspace(paths);
      const attemptedInput = {
        ...structuredClone(legacyInput),
        editorialApproval: structuredClone(EDITORIAL_APPROVAL),
      };
      if (scenario.mutateCall) scenario.mutateCall(attemptedInput);
      const before = await snapshotTree(root);

      await assert.rejects(workspace.persistJobInput(attemptedInput), (error) => {
        assert.doesNotMatch(error.message, /Synthetic Private Name|synthetic-private@example\.test/u);
        return true;
      });
      assert.deepEqual(await snapshotTree(root), before);
    });
  }
});

test("generation workspace rejects a generation-input symlink before enrichment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-record-symlink-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-record-symlink-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const workspace = createLocalGenerationWorkspace({ rootPath: root });
  const input = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    selectionId: null,
  };
  const paths = await workspace.persistJobInput(input);
  const legacyRaw = await readFile(paths.recordPath, "utf8");
  const outsideRecord = path.join(outside, "generation-input.json");
  await writeFile(outsideRecord, legacyRaw, "utf8");
  await rm(paths.recordPath);
  await symlink(outsideRecord, paths.recordPath);

  await assert.rejects(
    workspace.persistJobInput({ ...input, editorialApproval: EDITORIAL_APPROVAL }),
    /symbolic links/i,
  );
  assert.equal(await readFile(outsideRecord, "utf8"), legacyRaw);
});

test("generation workspace rejects a generation-input FIFO without blocking", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-record-fifo-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = createLocalGenerationWorkspace({ rootPath: root });
  const input = {
    jobId: JOB_ID,
    intakeDigest: INTAKE_DIGEST,
    intake: structuredClone(CUSTOMER.intake),
    selectionId: null,
  };
  const paths = await workspace.persistJobInput(input);
  await rm(paths.recordPath);
  createFifo(paths.recordPath);

  await assert.rejects(
    workspace.persistJobInput({ ...input, editorialApproval: EDITORIAL_APPROVAL }),
    /regular file/i,
  );
});

test("generation-only runner rejects a missing approval before constructing resources", () => {
  assert.throws(() => createTestAGenerationRunner(), (error) => {
    assert.equal(error.code, "generation_approval_rejected");
    assert.doesNotMatch(error.message, /Synthetic Private Name|synthetic-private@example\.test/u);
    return true;
  });
});

test("generation workspace rejects descendant symlinks before persisting canonical intake", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-symlink-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-generation-symlink-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await mkdir(path.join(root, "jobs", JOB_ID), { recursive: true });
  await symlink(outside, path.join(root, "jobs", JOB_ID, "input"), "dir");
  const workspace = createLocalGenerationWorkspace({ rootPath: root });

  await assert.rejects(
    workspace.persistJobInput({
      jobId: JOB_ID,
      intakeDigest: INTAKE_DIGEST,
      intake: structuredClone(CUSTOMER.intake),
      editorialApproval: EDITORIAL_APPROVAL,
    }),
    /symbolic links/i,
  );
  await assert.rejects(access(path.join(outside, "intake.json")), { code: "ENOENT" });
});

test("persisted artifact collection rejects an unmanaged special filesystem entry", async (t) => {
  const context = await generatedProductionFixture(t);
  const workspace = createLocalGenerationWorkspace({ rootPath: context.artifactRoot });
  const job = await context.backingStore.getJob(JOB_ID);
  const paths = await workspace.resolveJobPaths(job);
  createFifo(path.join(paths.reviewRoot, "unmanaged.pipe"));

  await assert.rejects(
    workspace.collectArtifactSet({
      kind: "private_review",
      paths,
      requirePersistedManifest: true,
    }),
    /Secure filesystem boundary rejected/iu,
  );
});

test("generation runner rejects partial review artifacts without completing the stage", async (t) => {
  const context = await fixture(t);
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: context.backingStore,
    artifactRoot: path.join(context.root, "partial-private-root"),
    async prepareReviewCommand({ output }) {
      const current = path.join(output, "artifacts", "current");
      await mkdir(current, { recursive: true });
      await writeFile(path.join(current, "page.json"), '{"partial":true}\n', "utf8");
      await writeFile(path.join(current, "transcript.json"), '{"tracks":{}}\n', "utf8");
    },
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });

  await assert.rejects(runner.generate(JOB_ID), /generation_stage_failed/);
  const aggregate = await context.backingStore.getJob(JOB_ID);
  assert.equal(aggregate.artifactSets.length, 0);
  assert.equal(aggregate.state, "failed");
});

test("a stale prepare-review lease cannot clean output owned by its successor", async () => {
  const calls = [];
  let ownershipChecks = 0;
  const handler = createLocalPrepareReviewStageHandler({
    async resolveJobPaths() {
      return {
        inputRecordPath: "/private/generation-input.json",
        intakeSnapshot: CUSTOMER.intake,
        reviewRoot: "/private/review",
        editorialApproval: EDITORIAL_APPROVAL,
        revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
      };
    },
    async collectArtifactSet() {
      return null;
    },
    async cleanupStageOutput() {
      calls.push("cleanup");
    },
    async prepareReview(_args, commandOptions) {
      assert.deepEqual(commandOptions, {
        editorialApproval: EDITORIAL_APPROVAL,
        intakeSnapshot: CUSTOMER.intake,
        silent: true,
      });
      calls.push("prepare_review");
    },
  });

  await assert.rejects(handler({
    job: { jobId: JOB_ID, intakeDigest: INTAKE_DIGEST },
    async assertStageOwnership() {
      ownershipChecks += 1;
      if (ownershipChecks > 1) throw new Error("stale lease");
    },
  }), /stale lease/);
  assert.deepEqual(calls, ["prepare_review"]);
});

test("generation-only replay returns an already-generated result without another stage or input write", async (t) => {
  const context = await fixture(t);
  await context.runner.generate(JOB_ID);
  const callCount = context.calls.length;

  const replay = await context.runner.generate(JOB_ID);

  assert.deepEqual(replay, {
    jobId: JOB_ID,
    outcome: "already_generated",
    state: "content_review_required",
    revisionId: "r1",
    intakeDigest: INTAKE_DIGEST,
  });
  assert.equal(context.calls.slice(callCount).some(({ kind }) => kind === "persist"), false);
  assert.equal(context.calls.filter(({ kind }) => kind === "prepare_review").length, 1);
});

test("terminal replay validates the exact persisted input and complete private-review artifact set", async (t) => {
  const context = await generatedProductionFixture(t);
  const beforeStore = await context.backingStore.getJob(JOB_ID);
  const beforeTree = await snapshotTree(context.artifactRoot);

  const replay = await context.runner.generate(JOB_ID);

  assert.deepEqual(replay, {
    jobId: JOB_ID,
    outcome: "already_generated",
    state: "content_review_required",
    revisionId: "r1",
    intakeDigest: INTAKE_DIGEST,
  });
  assert.deepEqual(await context.backingStore.getJob(JOB_ID), beforeStore);
  assert.deepEqual(await snapshotTree(context.artifactRoot), beforeTree);
});

test("terminal replay rejects a second schema-valid approval with a different source identity", async (t) => {
  const context = await generatedProductionFixture(t);
  const differentApproval = editorialApprovalFor("kanban:t_different_authority");
  const replayRunner = productionRunner(context, context.artifactRoot, differentApproval);
  const beforeStore = await context.backingStore.getJob(JOB_ID);
  const beforeTree = await snapshotTree(context.artifactRoot);

  await assert.rejects(replayRunner.generate(JOB_ID), (error) => {
    assert.equal(error.code, "generation_approval_rejected");
    assert.doesNotMatch(error.message, /Synthetic Private Name|synthetic-private@example\.test/u);
    return true;
  });
  assert.deepEqual(await context.backingStore.getJob(JOB_ID), beforeStore);
  assert.deepEqual(await snapshotTree(context.artifactRoot), beforeTree);
});

test("terminal replay fails closed for missing or malformed inputs and incomplete or tampered artifacts", async (t) => {
  const scenarios = [
    {
      name: "missing generation input",
      mutate(paths) {
        return rm(paths.generationInput);
      },
    },
    {
      name: "malformed generation input",
      mutate(paths) {
        return writeFile(paths.generationInput, "{not-json\n", "utf8");
      },
    },
    {
      name: "missing review dossier",
      mutate(paths) {
        return rm(paths.reviewDossier);
      },
    },
    {
      name: "tampered review dossier material binding",
      async mutate(paths) {
        const dossier = JSON.parse(await readFile(paths.reviewDossier, "utf8"));
        dossier.generationMaterials.editorialApproval.sourceDigest = "f".repeat(64);
        await writeFile(paths.reviewDossier, `${JSON.stringify(dossier, null, 2)}\n`, "utf8");
      },
    },
    {
      name: "incomplete terminal artifacts",
      mutate(paths) {
        return rm(paths.transcript);
      },
    },
    {
      name: "tampered terminal artifact",
      mutate(paths) {
        return writeFile(paths.page, '{"tampered":true}\n', "utf8");
      },
    },
    {
      name: "missing artifact manifest",
      mutate(paths) {
        return rm(paths.manifest);
      },
    },
    {
      name: "incomplete artifact manifest",
      async mutate(paths) {
        const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
        manifest.files.pop();
        await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      },
    },
    {
      name: "tampered artifact manifest digest",
      async mutate(paths) {
        const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
        manifest.files[0].sha256 = "f".repeat(64);
        await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      },
    },
    {
      name: "unmanaged special filesystem entry",
      mutate(paths) {
        createFifo(path.join(paths.reviewRoot, "unmanaged.pipe"));
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const context = await generatedProductionFixture(t);
      const revisionRoot = path.join(
        context.artifactRoot,
        "jobs",
        JOB_ID,
        "revisions",
        "r1",
      );
      const paths = {
        generationInput: path.join(context.artifactRoot, "jobs", JOB_ID, "input", "generation-input.json"),
        reviewRoot: path.join(revisionRoot, "private-review"),
        reviewDossier: path.join(revisionRoot, "private-review", "review.json"),
        page: path.join(revisionRoot, "private-review", "artifacts", "current", "page.json"),
        transcript: path.join(
          revisionRoot,
          "private-review",
          "artifacts",
          "current",
          "transcript.json",
        ),
        manifest: path.join(revisionRoot, "manifests", "private_review.json"),
      };
      await scenario.mutate(paths);
      const beforeStore = await context.backingStore.getJob(JOB_ID);
      const beforeTree = await snapshotTree(context.artifactRoot);

      await assert.rejects(context.runner.generate(JOB_ID), (error) => {
        assert.equal(error.code, "generation_authority_rejected");
        assert.doesNotMatch(error.message, /Synthetic Private Name|synthetic-private@example\.test/u);
        return true;
      });
      assert.deepEqual(await context.backingStore.getJob(JOB_ID), beforeStore);
      assert.deepEqual(await snapshotTree(context.artifactRoot), beforeTree);
    });
  }
});

test("generation-only gates fail before persistence or mutation for unpaid, mismatched, or ineligible records", async (t) => {
  const cases = [
    { name: "unpaid", mutateCustomer: (value) => { value.payment.status = "pending"; } },
    { name: "customer id", mutateCustomer: (value) => { value.jobId = "job_other_001"; } },
    { name: "customer digest", mutateCustomer: (value) => { value.intakeDigest = "f".repeat(64); } },
  ];
  for (const scenario of cases) {
    const customer = structuredClone(CUSTOMER);
    scenario.mutateCustomer(customer);
    const context = await fixture(t, { customer });
    const start = context.calls.length;
    await assert.rejects(context.runner.generate(JOB_ID), /generation_authority_rejected/);
    const newCalls = context.calls.slice(start);
    assert.equal(newCalls.some(({ kind }) => kind === "persist"), false, scenario.name);
    assert.equal(newCalls.some(({ kind }) => kind === "store:claimStage"), false, scenario.name);
  }

  const calls = [];
  const wrongStateRunner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: {
      ...unusedGenerationStoreMethods(),
      async getJob() {
        calls.push("getJob");
        return {
          jobId: JOB_ID,
          intakeDigest: INTAKE_DIGEST,
          state: "render_queued",
          currentRevisionId: "r1",
          paymentCorrelation: { jobId: JOB_ID, intakeDigest: INTAKE_DIGEST },
        };
      },
      async claimStage() {
        calls.push("claimStage");
        throw new Error("must not mutate");
      },
    },
    workspace: {
      async persistJobInput() {
        calls.push("persist");
      },
    },
    prepareReview: async () => {
      calls.push("prepare_review");
    },
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });
  await assert.rejects(wrongStateRunner.generate(JOB_ID), /generation_authority_rejected/);
  assert.deepEqual(calls, ["getJob"]);
});

test("expected-stage fencing prevents a race from advancing render_approved", async () => {
  const calls = [];
  const queued = {
    jobId: JOB_ID,
    environment: "test",
    product: "announcement-page",
    intakeDigest: INTAKE_DIGEST,
    paymentCorrelation: {
      project: "bebebonjour",
      product: "announcement-page",
      environment: "test",
      jobId: JOB_ID,
      intakeDigest: INTAKE_DIGEST,
    },
    state: "generation_queued",
    currentRevisionId: null,
    retry: null,
    payment: {
      providerPaymentId: "pi_generation_only_fixture",
      correlation: {
        project: "bebebonjour",
        product: "announcement-page",
        environment: "test",
        jobId: JOB_ID,
        intakeDigest: INTAKE_DIGEST,
      },
    },
    stageAttempts: [],
  };
  let reads = 0;
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: {
      ...unusedGenerationStoreMethods(),
      async getJob() {
        reads += 1;
        if (reads === 1) return structuredClone(queued);
        return {
          ...structuredClone(queued),
          state: "render_queued",
          currentRevisionId: "r1",
          stageAttempts: [{
            attemptId: "expired-prepare-attempt",
            stage: "prepare_review",
            status: "running",
            leaseToken: "expired-token",
            leaseExpiresAt: "2026-08-30T08:59:59.000Z",
          }],
        };
      },
      async failStage() {
        calls.push("failStage");
        throw new Error("must not fail a later-stage job");
      },
      async claimStage() {
        calls.push("claimStage");
        throw new Error("must not claim a later stage");
      },
    },
    workspace: { persistJobInput: async () => calls.push("persist") },
    prepareReview: async () => calls.push("prepare_review"),
    clock: () => "2026-08-30T09:00:01.000Z",
    tokenFactory: () => "generation-only-lease",
  });

  await assert.rejects(runner.generate(JOB_ID), /generation_backend_failed/);
  assert.deepEqual(calls, ["persist"]);
});

test("tampered persisted generation input blocks generation retry before mutation or stage effects", async (t) => {
  let now = "2026-08-30T09:00:01.000Z";
  let attempts = 0;
  const context = await fixture(t);
  const artifactRoot = path.join(context.root, "tampered-retry-private-root");
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: context.backingStore,
    artifactRoot,
    prepareReview: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("synthetic retry failure");
        error.retryable = true;
        error.reasonCode = "generation_prepare_failed";
        throw error;
      }
      return {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
        artifactSet: {
          kind: "private_review",
          revisionId: "r1",
          pageDigest: "b".repeat(64),
          transcriptDigest: "c".repeat(64),
          assetManifestDigest: "d".repeat(64),
          manifestRef: "jobs/job_generation_only_001/revisions/r1/manifests/private_review.json",
          files: [],
        },
      };
    },
    clock: () => now,
    tokenFactory: () => "generation-only-lease",
    retryPolicy: {
      leaseMsByStage: { prepare_review: 300_000 },
      maxAttemptsByStage: { prepare_review: 2 },
      backoffMsByStage: { prepare_review: [1_000] },
    },
  });

  assert.equal((await runner.generate(JOB_ID)).outcome, "retry_pending");
  const inputRecordPath = path.join(artifactRoot, "jobs", JOB_ID, "input", "generation-input.json");
  await writeFile(inputRecordPath, '{"tampered":true}\n', "utf8");
  const beforeRetry = await context.backingStore.getJob(JOB_ID);
  now = "2026-08-30T09:00:03.000Z";

  await assert.rejects(runner.generate(JOB_ID), (error) => {
    assert.equal(error.code, "generation_authority_rejected");
    return true;
  });
  assert.deepEqual(await context.backingStore.getJob(JOB_ID), beforeRetry);
  assert.equal(attempts, 1);
});

test("missing persisted generation input blocks generation retry before mutation or stage effects", async (t) => {
  let now = "2026-08-30T09:00:01.000Z";
  let attempts = 0;
  const context = await fixture(t);
  const artifactRoot = path.join(context.root, "missing-retry-private-root");
  const runner = createTestAGenerationRunner({
    editorialApproval: EDITORIAL_APPROVAL,
    customerReader: { readJob: async () => structuredClone(CUSTOMER) },
    store: context.backingStore,
    artifactRoot,
    prepareReview: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("synthetic retry failure");
        error.retryable = true;
        error.reasonCode = "generation_prepare_failed";
        throw error;
      }
      return {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
        artifactSet: {
          kind: "private_review",
          revisionId: "r1",
          pageDigest: "b".repeat(64),
          transcriptDigest: "c".repeat(64),
          assetManifestDigest: "d".repeat(64),
          manifestRef: "jobs/job_generation_only_001/revisions/r1/manifests/private_review.json",
          files: [],
        },
      };
    },
    clock: () => now,
    tokenFactory: () => "generation-only-lease",
    retryPolicy: {
      leaseMsByStage: { prepare_review: 300_000 },
      maxAttemptsByStage: { prepare_review: 2 },
      backoffMsByStage: { prepare_review: [1_000] },
    },
  });

  assert.equal((await runner.generate(JOB_ID)).outcome, "retry_pending");
  const inputRecordPath = path.join(artifactRoot, "jobs", JOB_ID, "input", "generation-input.json");
  await rm(inputRecordPath);
  const beforeRetry = await context.backingStore.getJob(JOB_ID);
  now = "2026-08-30T09:00:03.000Z";

  await assert.rejects(runner.generate(JOB_ID), (error) => {
    assert.equal(error.code, "generation_authority_rejected");
    return true;
  });
  assert.deepEqual(await context.backingStore.getJob(JOB_ID), beforeRetry);
  assert.equal(attempts, 1);
});

test("generation-only failures expose only bounded reason codes and can retry deterministically", async (t) => {
  let now = "2026-08-30T09:00:01.000Z";
  let attempts = 0;
  const context = await fixture(t, {
    clock: () => now,
    retryPolicy: {
      leaseMsByStage: { prepare_review: 300_000 },
      maxAttemptsByStage: { prepare_review: 2 },
      backoffMsByStage: { prepare_review: [1_000] },
    },
    prepareReview: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("synthetic-private@example.test Synthetic Private Name");
        error.retryable = true;
        error.reasonCode = "generation_prepare_failed";
        throw error;
      }
      return {
        revision: { revisionId: "r1", ordinal: 1, inputDigest: INTAKE_DIGEST },
        artifactSet: {
          kind: "private_review",
          revisionId: "r1",
          pageDigest: "b".repeat(64),
          transcriptDigest: "c".repeat(64),
          assetManifestDigest: "d".repeat(64),
          manifestRef: "jobs/job_generation_only_001/revisions/r1/manifests/private_review.json",
          files: [],
        },
      };
    },
  });

  const failed = await context.runner.generate(JOB_ID);
  assert.deepEqual(failed, {
    jobId: JOB_ID,
    outcome: "retry_pending",
    state: "retry_wait",
    revisionId: null,
    intakeDigest: INTAKE_DIGEST,
    reasonCode: "generation_prepare_failed",
  });
  assert.doesNotMatch(JSON.stringify(failed), /Synthetic Private Name|synthetic-private@example\.test/u);

  now = "2026-08-30T09:00:03.000Z";
  const retried = await context.runner.generate(JOB_ID);
  assert.equal(retried.outcome, "generated");
  assert.equal(attempts, 2);
});
