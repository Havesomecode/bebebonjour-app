import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEWED_TEST_A_OPERATOR_POLICY } from "../src/config/test-a-hosted-provider-manifest.mjs";
import { createTestAOperatorIsolationInventory } from "../src/config/test-a-operator-isolation.mjs";

const BASELINE_COMMIT = "c7abbb7338282b7bfba2616693f2a8d75285d8d3";
const EVIDENCE_RELATIVE_PATH = "ops/test-a-consolidated-candidate-evidence.json";
const EXCLUDED_WORKTREE_PATHS = new Set(["ops/.tmp-hermes-simulate-test-payment.mjs"]);
const EXCLUDED_DIGEST_PATHS = new Set([
  EVIDENCE_RELATIVE_PATH,
  "ops/test-a-operator-isolation-review-evidence.json",
  "ops/test-a-publication-regression-audit.json",
]);
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.join(rootPath, EVIDENCE_RELATIVE_PATH);
const focusedTestFiles = [
  "test/config/test-a-hosted-provider-manifest-policy.test.mjs",
  "test/config/test-a-operator-isolation.test.mjs",
  "test/fulfillment/exact-revision-publication-adapter.test.mjs",
  "test/fulfillment/failed-prepare-review-recovery.test.mjs",
  "test/fulfillment/generation-stage-workspace.test.mjs",
  "test/fulfillment/job-orchestration.test.mjs",
  "test/fulfillment/local-command-stage-handlers.test.mjs",
  "test/fulfillment/resend-delivery-adapter.test.mjs",
  "test/fulfillment/secure-filesystem-snapshot.test.mjs",
  "test/fulfillment/test-a-generation-runner.test.mjs",
  "test/fulfillment/test-a-generation-startup.test.mjs",
  "test/fulfillment/test-a-operator-runner.test.mjs",
  "test/fulfillment/test-a-operator-startup.test.mjs",
  "test/fulfillment/vercel-test-a-publication-provider.test.mjs",
  "test/http/operations-worker-handler.test.mjs",
  "test/operations/operations-command-worker.test.mjs",
  "test/operations/operations-worker-runtime.test.mjs",
  "test/operations/operations-worker-startup.test.mjs",
];
const controls = Object.freeze([
  {
    id: "isolated-generation-only-authority",
    requirement: "The generation-only Operations worker composes its production path without injected fulfillment capabilities from distinct scoped Convex worker and backend credentials, canonical Convex customer and fulfillment authority, one disjoint mode-0700 private artifact root, and one immutable approvals/<jobId>.json record. It claims only generate, fences the Operations effect before claiming the fulfillment stage, binds the Operations command into exact artifact provenance, writes only beneath the private root, advances only prepare_review, and leaves checkout, review mutation, render, TTS, publication, delivery, retry, and reconciliation unavailable. The lower-level private generation entrypoint retains its closed approval, canonical paid-record, filesystem, replay, and exact failed-state recovery gates.",
    proofs: [
      "test/fulfillment/test-a-generation-runner.test.mjs: generation-only runner persists canonical intake, advances only prepare_review, and returns PII-free output",
      "test/fulfillment/test-a-generation-runner.test.mjs: generation-only end to end produces the approved neutral unknown-name dossier and stops for review",
      "test/fulfillment/test-a-generation-runner.test.mjs: legacy generation input is enriched once with the exact job-scoped approval",
      "test/fulfillment/test-a-generation-runner.test.mjs: concurrent legacy enrichment permits exactly one approval identity",
      "test/fulfillment/test-a-generation-runner.test.mjs: failed atomic input persistence leaves no partial workspace files",
      "test/fulfillment/test-a-generation-runner.test.mjs: legacy approval enrichment rejects every input or authority drift without mutation",
      "test/fulfillment/test-a-generation-runner.test.mjs: generation workspace rejects a generation-input symlink before enrichment",
      "test/fulfillment/test-a-generation-runner.test.mjs: generation-only runner rejects a missing approval before constructing resources",
      "test/fulfillment/test-a-generation-runner.test.mjs: persisted artifact collection rejects an unmanaged special filesystem entry",
      "test/fulfillment/test-a-generation-runner.test.mjs: tampered persisted canonical intake blocks generation retry before mutation or stage effects",
      "test/fulfillment/test-a-generation-runner.test.mjs: missing persisted canonical intake blocks generation retry before mutation or stage effects",
      "test/fulfillment/test-a-generation-runner.test.mjs: terminal replay rejects a second schema-valid approval with a different source identity",
      "test/fulfillment/test-a-generation-runner.test.mjs: terminal replay fails closed for missing or malformed inputs and incomplete or tampered artifacts",
      "test/fulfillment/failed-prepare-review-recovery.test.mjs: the exact failed prepare_review transition is audited, terminal-evidence preserving, and idempotent",
      "test/fulfillment/failed-prepare-review-recovery.test.mjs: recovery rejects every non-exact or ambiguous failed-state predicate without mutation",
      "test/fulfillment/failed-prepare-review-recovery.test.mjs: the isolated runner recovers only the exact job and advances only prepare_review",
      "test/fulfillment/test-a-generation-startup.test.mjs: generation startup rejects missing, mismatched, broadened, writable, and unsafe approval records before runner construction",
      "test/fulfillment/secure-filesystem-snapshot.test.mjs: descriptor-relative reads stay bound to the opened root across ancestor substitution",
      "test/fulfillment/secure-filesystem-snapshot.test.mjs: artifact collection rejects a substituted stage ancestor after binding the workspace root",
      "test/fulfillment/generation-stage-workspace.test.mjs: persisted orchestration drives compose, render, and retryable test-mode TTS",
      "test/fulfillment/test-a-generation-startup.test.mjs: generation startup rejects every unrecognized environment variable before runner construction",
      "test/fulfillment/test-a-generation-runner.test.mjs: generation runner binds an Operations command through its real stage orchestration",
      "test/operations/operations-worker-startup.test.mjs: production generation entrypoint composes job-scoped generation without fulfillment injection",
      "test/operations/operations-worker-startup.test.mjs: production generation rejects missing or invalid private configuration before queue access",
      "test/operations/operations-worker-startup.test.mjs: worker startup fails before queue access when an uncomposed action is enabled",
      "test/config/test-a-operator-isolation.test.mjs: the authenticated Operations worker graph contains only the reviewed generation subset while customer routes contain no private capability",
    ],
  },
  {
    id: "fail-closed-private-operator-startup",
    requirement: "The fixed private entrypoint exposes only status and exact signed-approval persistence; publication and delivery commands fail before runner construction or provider I/O.",
    proofs: [
      "test/fulfillment/test-a-operator-startup.test.mjs: status uses the delivery-disabled runner without requiring publication or delivery credentials",
      "test/fulfillment/test-a-operator-startup.test.mjs: provider-capable commands fail before runner construction or provider I/O",
      "test/fulfillment/test-a-operator-startup.test.mjs: fixed private approval entrypoint forwards exact stdin bytes without loading provider credentials",
    ],
  },
  {
    id: "interrupted-publication-exact-reconciliation",
    requirement: "A fresh worker recovers the one exact deployment left before alias assignment and aliases only that deployment without a second upload or deployment creation.",
    proofs: [
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: a fresh worker aliases the exact deployment left by a crash before alias assignment",
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: Vercel TEST-A publication retry starts reconciliation at the supplied cursor after an interrupted deployment",
    ],
  },
  {
    id: "persisted-provider-mutation-fencing",
    requirement: "Every Vercel upload, deployment, and alias mutation plus every Resend send rechecks persisted attempt ownership immediately before provider invocation.",
    proofs: [
      "test/fulfillment/job-orchestration.test.mjs: an expired stage lease is fenced, persisted, and retried with the same side-effect key",
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: a stale Vercel worker cannot invoke its alias callback after its persisted fence loses ownership",
      "test/fulfillment/job-orchestration.test.mjs: a stale delivery worker cannot invoke its Resend callback after its persisted fence loses ownership",
    ],
  },
  {
    id: "reviewed-manifest-cold-start-authority",
    requirement: "The exact SHA-256-pinned hosted provider manifest supplies runtime identity and allowed/forbidden secret-store policy at cold start.",
    proofs: [
      "test/config/test-a-hosted-provider-manifest-policy.test.mjs: reviewed TEST-A operator policy is loaded from the exact pinned manifest bytes",
      "test/config/test-a-hosted-provider-manifest-policy.test.mjs: reviewed TEST-A operator policy rejects tampered bytes and contradictory secret-store policy",
    ],
  },
  {
    id: "private-runtime-and-provider-identity-corrections",
    requirement: "The private operator remains absent from public entrypoints and provider-disabled; any future publication path requires parsed exact deployment, revision, build, team, and project inspection bytes.",
    proofs: [
      "test/config/test-a-operator-isolation.test.mjs: operator isolation inventory traces one status/review-only invocation outside every public route graph",
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: Vercel TEST-A provider parses exact deployment, revision, build, and project inspection bytes",
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: Vercel TEST-A provider rejects unparsed or incomplete inspection assertions",
      "test/fulfillment/resend-delivery-adapter.test.mjs: Resend delivery adapter rejects every non-canonical test sink before sending",
    ],
  },
]);

const isolation = await createTestAOperatorIsolationInventory({ rootPath });
const changedPaths = changedPathsFromBaseline();
const reviewInputs = [];
for (const filePath of [...new Set([...isolation.reviewInputs, ...changedPaths])].sort()) {
  if (EXCLUDED_DIGEST_PATHS.has(filePath)) continue;
  try {
    await access(path.join(rootPath, filePath));
    reviewInputs.push(filePath);
  } catch {
    // Deleted paths remain in the candidate path allowlist but have no bytes to hash.
  }
}
const reviewedFileDigests = await Promise.all(reviewInputs.map(async (filePath) => ({
  path: filePath,
  sha256: createHash("sha256").update(await readFile(path.join(rootPath, filePath))).digest("hex"),
})));
const generatedEvidence = {
  schemaVersion: "1.0",
  auditId: "test-a-consolidated-candidate-successor-2026-08-26",
  baselineCommit: BASELINE_COMMIT,
  candidateBoundary: {
    changedPaths,
    pathAllowlist: changedPaths,
    reviewedFileDigests,
  },
  reviewedManifest: {
    path: "ops/test-a-hosted-provider-manifest.json",
    sha256: REVIEWED_TEST_A_OPERATOR_POLICY.manifestSha256,
  },
  controls,
  isolation: {
    customerPublicModuleGraph: isolation.customerPublicModuleGraph,
    generationInvocation: isolation.generationInvocation,
    generationModuleGraph: isolation.generationModuleGraph,
    operationsWorkerEntrypoint: isolation.operationsWorkerEntrypoint,
    operationsWorkerGenerationModules: isolation.operationsWorkerGenerationModules,
    operationsWorkerModuleGraph: isolation.operationsWorkerModuleGraph,
    privateInvocation: isolation.privateInvocation,
    publicEntrypoints: isolation.publicEntrypoints,
    publicModuleGraph: isolation.publicModuleGraph,
    privateCapabilityModules: isolation.privateCapabilityModules,
    packageCommandReferences: isolation.packageCommandReferences,
    publicCapabilityMarkers: isolation.publicCapabilityMarkers,
  },
  verification: {
    focusedTestFiles,
    providerMutation: "none",
  },
  releaseConstraint: "Reviewed release candidate only; no provider mutation, deployment, alias, publication, or live customer-data access is authorized.",
};

if (process.argv.includes("--write-evidence")) {
  await writeFile(evidencePath, `${JSON.stringify(generatedEvidence, null, 2)}\n`);
}

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
if (JSON.stringify(evidence) !== JSON.stringify(generatedEvidence)) {
  throw new Error("TEST-A consolidated candidate evidence does not match the exact current review boundary.");
}

const testRun = spawnSync(process.execPath, ["--test", ...focusedTestFiles], {
  cwd: rootPath,
  encoding: "utf8",
  env: { ...process.env, RUN_DB_TESTS: "0" },
});
if (testRun.status !== 0) {
  process.stderr.write(testRun.stdout);
  process.stderr.write(testRun.stderr);
  process.exit(testRun.status ?? 1);
}

process.stdout.write(`HERMES_VERIFY_RESULT=${JSON.stringify({
  status: "PASS",
  baselineCommit: BASELINE_COMMIT,
  changedPathCount: changedPaths.length,
  pathAllowlistCount: changedPaths.length,
  reviewInputCount: reviewInputs.length,
  controlCount: controls.length,
  reviewedManifestSha256: REVIEWED_TEST_A_OPERATOR_POLICY.manifestSha256,
  focusedTestFileCount: focusedTestFiles.length,
  privateInvocation: isolation.privateInvocation,
  providerMutation: "none",
})}\n`);

function changedPathsFromBaseline() {
  const diffPaths = git(["diff", "--name-only", BASELINE_COMMIT, "--"]);
  const untrackedPaths = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([
    ...lines(diffPaths),
    ...lines(untrackedPaths),
    EVIDENCE_RELATIVE_PATH,
  ])].filter((filePath) => !EXCLUDED_WORKTREE_PATHS.has(filePath)).sort();
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: rootPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function lines(value) {
  return value.split(/\r?\n/u).filter(Boolean);
}
