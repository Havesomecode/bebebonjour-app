import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEWED_TEST_A_OPERATOR_POLICY } from "../src/config/test-a-hosted-provider-manifest.mjs";
import { createTestAOperatorIsolationInventory } from "../src/config/test-a-operator-isolation.mjs";

const BASELINE_COMMIT = "82be6b29eab9245400e928623ec15a3f1ae1ca27";
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
  "test/config/generation-worker-isolation.test.mjs",
  "test/config/narration-worker-isolation.test.mjs",
  "test/config/test-a-hosted-provider-manifest-policy.test.mjs",
  "test/config/test-a-operator-isolation.test.mjs",
  "test/convex/generation.test.mjs",
  "test/convex/generation-worker-authority.test.mjs",
  "test/convex/private-generation.test.mjs",
  "test/convex/private-generation-containment.test.mjs",
  "test/convex/private-generation-retry.test.mjs",
  "test/convex/owner-trial.test.mjs",
  "test/convex/owner-trial-completion.test.mjs",
  "test/convex/owner-trial-completion-continuation.test.mjs",
  "test/convex/owner-trial-publication-recovery.test.mjs",
  "test/convex/owner-trial-publication-present.test.mjs",
  "test/convex/delivery-loop.test.mjs",
  "test/convex/forward-coexistence.test.mjs",
  "test/fulfillment/owner-trial-public-artifacts.test.mjs",
  "test/fulfillment/owner-trial-playback-projection.test.mjs",
  "test/http/owner-trial-completion-handler.test.mjs",
  "test/convex/narration.test.mjs",
  "test/convex/narration-lifecycle.test.mjs",
  "test/convex/completion-store-seam.test.mjs",
  "test/convex/operations.test.mjs",
  "test/fulfillment/exact-revision-publication-adapter.test.mjs",
  "test/fulfillment/failed-prepare-review-recovery.test.mjs",
  "test/fulfillment/codex-subscription-composer.test.mjs",
  "test/fulfillment/committed-artifact-content-set.test.mjs",
  "test/fulfillment/generation-stage-workspace.test.mjs",
  "test/fulfillment/job-orchestration.test.mjs",
  "test/fulfillment/local-command-stage-handlers.test.mjs",
  "test/fulfillment/resend-delivery-adapter.test.mjs",
  "test/fulfillment/secure-filesystem-snapshot.test.mjs",
  "test/fulfillment/test-a-generation-runner.test.mjs",
  "test/fulfillment/test-a-generation-approval-startup.test.mjs",
  "test/fulfillment/test-a-generation-startup.test.mjs",
  "test/fulfillment/test-a-operator-runner.test.mjs",
  "test/fulfillment/test-a-operator-startup.test.mjs",
  "test/fulfillment/vercel-test-a-publication-provider.test.mjs",
  "test/http/operations-worker-handler.test.mjs",
  "test/narration/narration-media.test.mjs",
  "test/operations/operations-command-worker.test.mjs",
  "test/operations/codex-packaged-response-schema.test.mjs",
  "test/operations/codex-packaged-runtime.test.mjs",
  "test/operations/operations-worker-runtime.test.mjs",
  "test/operations/operations-worker-startup.test.mjs",
  "test/operations/hosted-generation-storage.test.mjs",
  "test/operations/production-narration-worker.test.mjs",
  "test/operations/completion-worker-boundary.test.mjs",
];
const controls = Object.freeze([
  {
    id: "owner-trial-signed-source-only-public-playback-repair",
    requirement: "Exact published op2 history remains fully verified and immutable while a separate dual-role, recovery-signed op3 authority binds approved storage descriptors, source-only 21-file projection and a fresh provider identity. Ordinary claimers cannot execute the op3 command or unchanged pending attempt0 old-publication queue commands. Every artifact read and provider call revalidates the signed lease and historical chain; canonical transcript selection is fenced, all original runtime/audio bytes stay unchanged, and no generation or email capability is granted. Raw complete census and full deployment detail retain actual provider shapes; conflicting id/uid, metadata, READY/project/url drift and key collisions reject before uploads/create. Commit requires one new receipt, exact alias and actual successful body hash/count evidence for every file at both deployment and stable targets. Historical recovery receipts validate their original aggregate; ordinary completion policy/queue remains valid after repair without fabricated owner acceptance or delivery.",
    proofs: [
      "test/convex/owner-trial-publication-present.test.mjs: real offline Convex/exporter/internal artifact/projector/Vercel worker op3 seam, raw uid census/full-detail RED/GREEN, all21 actual bodies at both targets, transcript fence, collision/tamper/stale/receipt-reuse/pagination denial, unchanged old command and startup/queue continuation",
      "test/fulfillment/owner-trial-playback-projection.test.mjs: approved-only deterministic source projection, unchanged runtime/audio, sanitized transcript/manifests and private provenance rejection",
    ],
  },
  {
    id: "owner-trial-positive-present-runtime-supersession",
    requirement: "Exact-job dual-role authorization and independently signed fresh positive-presence evidence permit one distinct corrected-source publication for the approved four-file runtime omission only. The expired original PRESENT invocation must be proven closed before alias mutation; original deployment, commands, authorizations, leases and attempts remain immutable. New source, runtime closure, idempotency, leases and signed success are fenced at every artifact, provider, canonical transition and subsequent owner-only delivery boundary. The actual complete census is bound to its signed digest and rejects any existing new-key deployment before authorization, irrespective of other metadata; every subsequent provider census is guarded so a collision, duplicate or omitted known effect cannot authorize another create or alias. Unrelated unresolved commands and uncertain replacement effects remain nonretryable. Non-auth toolbar suppression is confined to exact public GET hosts; approved bytes are unchanged. Fresh 404 responses retain their hashes but compare missing-path/status/inventory facts rather than request-specific error bodies.",
    proofs: [
      "test/convex/owner-trial-publication-present.test.mjs: real 18-file approved exporter, internal Convex artifact HTTP, corrected provider inventory/public bytes, owner-only delivery, dynamic404 RED/GREEN, separated signatures, uncertainty/replay and queued delivery integrity regressions",
      "test/convex/forward-coexistence.test.mjs: forward-only current schema, function ABI and HTTP preservation, approved trial routing and immutable provider bytes",
      "test/convex/delivery-loop.test.mjs: existing complimentary delivery-loop authority, immutable publication, narration receipts, bounded leases and uncertain-email reconciliation remain intact",
    ],
  },
  {
    id: "owner-trial-exact-present-effect-reconciliation",
    requirement: "Separate append-only exact authorization, one non-reissuable bounded dual-fenced lease and recovery-role signed fresh verified receipt reconcile only the existing deployment. Trusted signing occurs after strict provider census, inventory, configuration, public bytes and alias readback. No upload, new deployment, publication replay or false absence is allowed; immutable failed history remains unchanged and receipt-backed normal owner delivery retains completion continuation expiry and drift fences.",
    proofs: ["test/convex/owner-trial-publication-present.test.mjs: real offline Convex/storage/provider/worker continuation-backed published-to-sent path, ambiguous/wrong census, SSO302, bytes, uncertain alias, proof binding/role/freshness and no-write denial"],
  },
  {
    id: "append-only-owner-authorized-completion-continuation",
    requirement: "Only the pinned already-redeemed, reviewed complimentary owner trial may acquire an immutable HMAC-signed completion continuation through both the existing owner Operations role and the separated owner-trial completion role. Inspection commits exact original ticket/customer/revision/artifact/review/provider-policy bytes before issuance. Each nonoverlapping window is at most 24 hours, chained append-only, expiry-enforced at every existing completion policy fence, and grants publication plus owner-only delivery only. Issuance changes no canonical job, ticket, approval, payment, artifact, command, event, counter or recovery receipt. Uncertain provider effects still require fresh independent signed absence recovery for every failed attempt; continuation grants no retry, generation, narration, approval, owner acceptance or delivered claim.",
    proofs: [
      "test/convex/owner-trial-completion-continuation.test.mjs: behavior-level RED/GREEN expired-ticket seam, immutable issuance/replay, exact inspected binding, dual-role/finite-window/concurrency/drift denial, historical receipt preservation and default rejection",
      "test/convex/owner-trial-completion-continuation.test.mjs: real offline completion worker publishes only after per-attempt signed recovery and both persisted fences, sends only to unchanged owner recipient, and stops at continuation expiry without provider callbacks",
      "test/convex/owner-trial-publication-recovery.test.mjs: iterative fresh absence proofs retain historical receipts and reject unbacked next attempts",
    ],
  },
  {
    id: "isolated-generation-only-authority",
    requirement: "The generation-only Operations worker is packaged in a separate Vercel project with only its exact worker inventory and no customer-flow backend, payment, email, publication, provider-management, or model credentials. Every canonical read, prepare_review transition, artifact upload, commit, and byte read is bound to the active claimed generate command. Private artifacts are streamed through an authenticated Convex HTTP action without direct storage URLs. Invocation-scoped staging is ephemeral and immutable job-scoped approvals and review artifacts persist durably in Convex. Pre-effect generation failures persist only a bounded trusted reason code, and an Operations fence rejection before provider I/O atomically moves the exact claimed prepare_review attempt to retry_wait or failed without artifact or auth-state mutation. Checkout, review mutation, publication, delivery, retry, and reconciliation remain unavailable to the generation worker. Normal generation retains its closed approval, canonical paid-record, filesystem, replay, and exact failed-state recovery gates. An operator-authenticated, feature-flagged creation action admits only the fixed fictional intake under a separate durable job/digest/environment/product-bound private-test authority, with payment explicitly not applicable rather than paid. Private fictional jobs have no checkout, publication, customer delivery, or blind retry actions, and still require distinct editorial policy and exact human content/narration review decisions.",
    proofs: [
      "test/convex/private-generation.test.mjs: private fictional creation, exact authority, real offline worker seam, immutable artifact replay and forged marker rejection; production failed generate command follows pre-fence rejection without composer or stage writes; successful composer followed by prepareReview failure cannot authorize pre-effect retry",
      "test/convex/private-generation-containment.test.mjs: generation-only private checkout/narration/publication/delivery/retry denial, injected claim/effect rejection, metadata/storage capability rejection and post-claim authority drift rejection",
      "test/convex/private-generation-retry.test.mjs: reconciliation_required sources reject before writes or replay because no independent durable provider-specific composer-absence evidence exists; captured live-shape failure preserves every stored byte and the reconciliation block, not an invented ENOENT receipt; legacy unsafe reconciliation dispositions cannot authorize replay. Existing failed-command recovery validates canonical editorial approval, all generation artifacts, distinct credentials, persisted intake and authority, and CAS; preserves failed attempt and command history, returns an exact inert replay, and creates no command or broader capability. Failed terminal-stage fixtures are synthetic gate/security tests, not live provider-absence proof",
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
      "test/fulfillment/secure-filesystem-snapshot.test.mjs: portable collection rejects mutation after an earlier file was locally validated",
      "test/fulfillment/secure-filesystem-snapshot.test.mjs: descriptor-relative reads stay bound to the opened root across ancestor substitution",
      "test/fulfillment/secure-filesystem-snapshot.test.mjs: artifact collection rejects a substituted stage ancestor after binding the workspace root",
      "test/fulfillment/generation-stage-workspace.test.mjs: persisted orchestration drives compose, render, and retryable test-mode TTS",
      "test/fulfillment/test-a-generation-startup.test.mjs: generation startup rejects every unrecognized environment variable before runner construction",
      "test/operations/codex-packaged-response-schema.test.mjs: pinned packaged Codex response schema satisfies the strict OpenAI boundary",
      "test/operations/codex-packaged-response-schema.test.mjs: packaged Codex 0.146.0 accepts and enforces the production response schema (authorized synthetic provider probe recorded in durable evidence)",
      "test/fulfillment/test-a-generation-runner.test.mjs: generation runner binds an Operations command through its real stage orchestration",
      "test/operations/operations-worker-startup.test.mjs: production generation entrypoint composes job-scoped generation without fulfillment injection",
      "test/operations/operations-worker-startup.test.mjs: production generation rejects missing or invalid private configuration before queue access",
      "test/operations/operations-worker-startup.test.mjs: worker startup fails before queue access when an uncomposed action is enabled",
      "test/operations/hosted-generation-storage.test.mjs: Vercel-safe production worker persists review artifacts in Convex and survives a cold invocation",
      "test/operations/hosted-generation-storage.test.mjs: production pre-effect failures persist only a bounded generation reason",
      "test/convex/generation.test.mjs: Convex keeps approvals immutable and serves private artifact bytes only through an active claim-scoped authenticated HTTP action",
      "test/convex/generation.test.mjs: Convex canonicalizes an approved record before the generation runner verifies it",
      "test/convex/generation-worker-authority.test.mjs: claim-scoped generation authority rejects wrong, replayed, cross-job, and non-generate claims",
      "test/convex/operations.test.mjs: the actual Operations fence accepts a canonical generation-authority claim and atomically recovers expired no-effect claims for retry without artifact or auth-state mutation",
      "test/convex/operations.test.mjs: failed no-effect generation commands remain auditable and replaceable without duplicating effects",
      "test/fulfillment/test-a-generation-approval-startup.test.mjs: generation approval startup persists exact immutable approval bytes through Convex",
      "test/config/generation-worker-isolation.test.mjs: generation worker is deployed only by its isolated Vercel project",
      "test/config/test-a-operator-isolation.test.mjs: the authenticated Operations worker graph contains only the reviewed generation subset while customer routes contain no private capability",
    ],
  },
  {
    id: "isolated-narration-generation-authority",
    requirement: "The narration provider boundary is a separate Vercel project whose only operations capability is generate_narration. A distinct Convex token cannot review, render, publish or deliver; OPENAI_API_KEY is mounted only with that token and a distinct cron secret. The worker requires a genuine content approval, preserves exact source-private and prepared-bundle manifest commitments, verifies the approved page bytes before one-attempt Cedar TTS, decodes bounded MP3 bytes, uploads typed private objects, and commits only after Convex storage readback. Provider, timeout, oversized, malformed, truncated and uncertain upload failures are redacted and never blindly retried. A running attempt with no aggregate effect fence is automatically recovered as known absent, but an explicit failed disposition is requeued only when the persisted Operations claim proves that the queue fence was issued; deterministic failures before that fence remain terminal and unclaimable.",
    proofs: [
      "test/config/narration-worker-isolation.test.mjs: reviewed manifest pins the isolated generate_narration deployment and secret store",
      "test/convex/narration.test.mjs: TTS credential can claim only generate_narration work",
      "test/convex/narration-lifecycle.test.mjs: durable narration commits before review and private playback survives approval",
      "test/convex/narration-lifecycle.test.mjs: a deterministic narration failure before the queue fence remains terminal and unclaimable",
      "test/convex/narration-lifecycle.test.mjs: a handled failure after the queue fence requeues with the original provider idempotency identity",
      "test/narration/narration-media.test.mjs: Cedar request is exact, single-attempt, bounded, and independently ffprobe-decodable",
      "test/narration/narration-media.test.mjs: provider, timeout, oversized, malformed, and truncated failures are redacted and terminal",
      "test/operations/production-narration-worker.test.mjs: worker fences exactly one generation, reads exact approved page, uploads typed bytes, and completes durably",
      "test/operations/production-narration-worker.test.mjs: uncertain provider failures are redacted, non-retryable, and never completed",
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
    id: "exact-synthetic-provider-completion-worker",
    requirement: "A separately packaged completion endpoint accepts only one fixed synthetic TEST-A job, a completion-only Convex token, an authenticated persisted approval, exact reviewed bytes, the inspected private publication identity, the Resend test sink, and bounded retry. Its Convex seam independently validates the active Operations command, canonical stage-attempt lease/event identity, and the exact per-transition aggregate mutation boundary without collapsing either authority. Generation remains generate-only and no payment, intake, live-customer, DNS, or outreach authority is mounted.",
    proofs: [
      "test/convex/completion-store-seam.test.mjs: the real Convex store preserves distinct Operations and stage identities through render, publish, and deliver",
      "test/convex/completion-store-seam.test.mjs: stale leases, wrong commands and jobs, duplicate claims, forged evidence, and failure recovery remain provider-effect free",
      "test/convex/completion-store-seam.test.mjs: every unrelated mutable aggregate field is rejected across render, publish, delivery, retry, success, and failure transitions",
      "test/convex/completion-store-seam.test.mjs: forged replay replacement fields are independently rejected without canonical aggregate mutation",
      "test/operations/completion-worker-boundary.test.mjs: completion policy rejects broadened job, action, lease, customer, payment, and intake authority before provider I/O",
      "test/operations/completion-worker-boundary.test.mjs: production completion startup claims the exact job using only completion-scoped Convex authority",
      "test/operations/completion-worker-boundary.test.mjs: reviewed private bytes are promoted without mutation and remain exact-revision bound",
      "test/operations/completion-worker-boundary.test.mjs: hosted resolver rejects non-synthetic and non-private artifact reads before publication",
      "test/fulfillment/resend-delivery-adapter.test.mjs: Resend delivery adapter rejects every non-canonical test sink before sending",
      "test/fulfillment/vercel-test-a-publication-provider.test.mjs: Vercel publication reconciles exact idempotent private deployment effects",
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
  auditId: "test-a-consolidated-candidate-successor-2026-09-29",
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
    generationApprovalInvocation: isolation.generationApprovalInvocation,
    generationApprovalModuleGraph: isolation.generationApprovalModuleGraph,
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
    providerMutation: "none-during-audit",
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
  providerMutation: "none-during-audit",
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
