import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY =
  "synthetic-fixture-approval-key-material-not-for-production";

import {
  commandApproveReview,
  commandCompose,
  commandPrepareReview,
  commandRender,
} from "../scripts/lib/commands.mjs";
import {
  assertValidNameResolutionEvidence,
  assertValidReviewDossier,
} from "../scripts/lib/schema-validation.mjs";

const baseIntake = JSON.parse(
  await readFile(new URL("../data/examples/bayane/intake.json", import.meta.url), "utf8"),
);
const amalFixtureRoot = fileURLToPath(new URL("../data/examples/amal/", import.meta.url));

async function captureConsole(action) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await action();
  } finally {
    console.log = original;
  }
  return lines;
}

async function pathExists(target) {
  try {
    await readFile(target);
    return true;
  } catch (error) {
    if (error.code === "EISDIR") return true;
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("prepare-review autonomously creates a private review bundle without a deploy bundle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "output");
  const intake = structuredClone(baseIntake);
  intake.requestId = "req_private_review_unknown_001";
  intake.baby.firstName = "Aélio-Z";
  intake.baby.nameArabic = "أيليو";
  await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, "utf8");

  const lines = await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
  }));

  const dossier = JSON.parse(await readFile(path.join(outputRoot, "review.json"), "utf8"));
  const privatePage = JSON.parse(
    await readFile(path.join(outputRoot, "private-preview", "aelio-z", "page.json"), "utf8"),
  );
  const canonicalPage = JSON.parse(
    await readFile(path.join(outputRoot, "artifacts", "current", "page.json"), "utf8"),
  );
  const privateHtml = await readFile(
    path.join(outputRoot, "private-preview", "aelio-z", "fr", "index.html"),
    "utf8",
  );
  const privateRuntime = await readFile(
    path.join(
      outputRoot,
      "private-preview",
      "aelio-z",
      "_assets",
      canonicalPage.buildId,
      "app.js",
    ),
    "utf8",
  );
  const privateRuntimePolicy = await readFile(
    path.join(
      outputRoot,
      "private-preview",
      "aelio-z",
      "_assets",
      canonicalPage.buildId,
      "phrase-progress.mjs",
    ),
    "utf8",
  );

  assert.equal(dossier.state, "review_required");
  assert.equal(dossier.pageId, canonicalPage.pageId);
  assert.equal(dossier.revision, canonicalPage.pageRevision);
  assert.match(dossier.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(dossier.materialDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(dossier.generationMaterials).sort(), [
    "catalogDigest",
    "rendererDigest",
    "selectionId",
    "templateDigest",
  ]);
  assert.match(dossier.generationMaterials.catalogDigest, /^[a-f0-9]{64}$/);
  assert.match(dossier.generationMaterials.templateDigest, /^[a-f0-9]{64}$/);
  assert.match(dossier.generationMaterials.rendererDigest, /^[a-f0-9]{64}$/);
  assert.equal(dossier.artifacts.privatePreviewRoot, "private-preview/aelio-z");
  assert.equal(dossier.evidence.nameResolution.status, "fallback");
  assert.deepEqual(dossier.review.requiredReasons, ["name_not_in_catalog"]);
  assert.deepEqual(dossier.operatorContext.specificDemands, {
    value: "Elegant, reverent, cinematic.",
    applicationStatus: "not_evaluated",
  });
  assert.equal(dossier.warnings.includes("narration_pending"), true);
  assert.equal(privatePage.provenance, undefined);
  assert.equal(privatePage.review, undefined);
  assert.equal(privatePage.operatorContext, undefined);
  assert.equal(JSON.stringify(privatePage).includes(intake.requestId), false);
  assert.equal(privatePage.identity.nameLatin, "Aélio-Z");
  assert.equal(await pathExists(path.join(outputRoot, "deploy")), false);
  assert.equal(await pathExists(path.join(outputRoot, "job.json")), false);
  assert.match(privateHtml, /reviewMode:\s*"private"/);
  assert.match(privateHtml, /transcriptUrl:\s*""/);
  assert.match(privateHtml, /ambientAudioUrl:\s*""/);
  assert.doesNotMatch(privateHtml, /fonts\.(?:googleapis|gstatic)\.com/);
  assert.doesNotMatch(privateHtml, /Elegant, reverent, cinematic\./);
  assert.match(privateRuntime, /runtimeConfig\.reviewMode === "private"/);
  assert.match(privateRuntime, /shouldLoadNarrationResources/);
  assert.match(privateRuntimePolicy, /!privateReview && narrationRequested/);
  assert.match(privateRuntime, /const privateReview = runtimeConfig\.reviewMode === "private"/);
  assert.match(privateRuntime, /narration:\s*privateReview\s*\?\s*false/);
  assert.match(privateRuntime, /if \(!privateReview\) \{[\s\S]*await loadTranscript\(\)/);
  assert.match(lines.join("\n"), /private_review_ready/);
  assert.doesNotThrow(() => assertValidNameResolutionEvidence(dossier.evidence.nameResolution));
  assert.doesNotThrow(() => assertValidReviewDossier(dossier));

  const invalidEvidence = structuredClone(dossier.evidence.nameResolution);
  invalidEvidence.unexpectedPrivateField = true;
  assert.throws(
    () => assertValidNameResolutionEvidence(invalidEvidence),
    /Invalid name-resolution evidence:.*additional properties/i,
  );
});

test("prepare-review is deterministic and idempotent for the same intake", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  const first = await Promise.all([
    readFile(path.join(outputRoot, "review.json"), "utf8"),
    readFile(path.join(outputRoot, "private-preview", "bayane", "page.json"), "utf8"),
    readFile(path.join(outputRoot, "private-preview", "bayane", "fr", "index.html"), "utf8"),
  ]);

  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  const replay = await Promise.all([
    readFile(path.join(outputRoot, "review.json"), "utf8"),
    readFile(path.join(outputRoot, "private-preview", "bayane", "page.json"), "utf8"),
    readFile(path.join(outputRoot, "private-preview", "bayane", "fr", "index.html"), "utf8"),
  ]);

  assert.deepEqual(replay, first);
});

test("prepare-review refuses replay when a material selection input changes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-materials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  const firstDossier = await readFile(path.join(outputRoot, "review.json"), "utf8");

  await assert.rejects(
    captureConsole(() => commandPrepareReview({ input: intakePath, output: outputRoot })),
    /material inputs.*fresh output root/i,
  );
  assert.equal(await readFile(path.join(outputRoot, "review.json"), "utf8"), firstDossier);
});

test("approve-review writes a dossier-bound approved page outside the immutable review root", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const approvalRoot = path.join(directory, "approval");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: reviewRoot,
    select: "religious-bayane",
  }));
  const dossierPath = path.join(reviewRoot, "review.json");
  const dossierBefore = await readFile(dossierPath, "utf8");
  const dossier = JSON.parse(dossierBefore);
  const canonicalPath = path.join(reviewRoot, dossier.artifacts.canonicalPage);
  const canonicalBefore = await readFile(canonicalPath, "utf8");

  const lines = await captureConsole(() => commandApproveReview({
    review: dossierPath,
    output: approvalRoot,
    reviewer: "operator-demo",
    acknowledge: dossier.review.requiredReasons.join(","),
    demands: "not_applied",
  }));

  const approvedPage = JSON.parse(await readFile(path.join(approvalRoot, "page.json"), "utf8"));
  const approvalRaw = await readFile(path.join(approvalRoot, "approval.json"), "utf8");
  const approval = JSON.parse(approvalRaw);
  assert.equal(approvedPage.review.status, "approved");
  assert.equal(approvedPage.review.reviewedBy, "operator-demo");
  assert.match(approvedPage.review.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(approvedPage.provenance.specificDemands.applicationStatus, "not_applied");
  assert.equal(approval.state, "approved");
  assert.equal(approval.materialDigest, dossier.materialDigest);
  assert.match(approval.dossierDigest, /^[a-f0-9]{64}$/);
  assert.match(approval.approvedPageDigest, /^[a-f0-9]{64}$/);
  assert.equal(approval.signatureAlgorithm, "hmac-sha256");
  assert.match(approval.signature, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(approvalRaw, /synthetic-fixture-approval-key-material-not-for-production/);
  assert.equal(await readFile(dossierPath, "utf8"), dossierBefore);
  assert.equal(await readFile(canonicalPath, "utf8"), canonicalBefore);
  assert.equal(await pathExists(path.join(reviewRoot, "deploy")), false);
  assert.equal(await pathExists(path.join(reviewRoot, "job.json")), false);
  assert.equal(await pathExists(path.join(approvalRoot, "deploy")), false);
  assert.equal(await pathExists(path.join(approvalRoot, "job.json")), false);
  assert.match(lines.join("\n"), /review_approved/);

  const preparedRoot = path.join(directory, "prepared");
  await captureConsole(() => commandRender({
    input: path.join(approvalRoot, "page.json"),
    approval: path.join(approvalRoot, "approval.json"),
    output: preparedRoot,
  }));
  const preparedJob = JSON.parse(await readFile(path.join(preparedRoot, "job.json"), "utf8"));
  assert.equal(preparedJob.approval.approvedPageDigest, approval.approvedPageDigest);
  assert.equal(preparedJob.approval.dossierDigest, approval.dossierDigest);
  assert.equal(preparedJob.approval.materialDigest, approval.materialDigest);
  assert.match(preparedJob.approval.approvalDigest, /^[a-f0-9]{64}$/);
  assert.match(preparedJob.approval.preparedBundleDigest, /^[a-f0-9]{64}$/);
  assert.equal(preparedJob.currentLiveRevision, null);
  assert.equal(preparedJob.deploy, null);
});

test("approve-review rejects a canonical draft that differs from the reviewed preview", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-approval-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const approvalRoot = path.join(directory, "approval");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: reviewRoot,
    select: "religious-bayane",
  }));
  const dossierPath = path.join(reviewRoot, "review.json");
  const dossier = JSON.parse(await readFile(dossierPath, "utf8"));
  const canonicalPath = path.join(reviewRoot, dossier.artifacts.canonicalPage);
  const canonicalPage = JSON.parse(await readFile(canonicalPath, "utf8"));
  canonicalPage.sections.intro.fr.displayLines[0] = "Unreviewed operator edit";
  await writeFile(canonicalPath, `${JSON.stringify(canonicalPage, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandApproveReview({
      review: dossierPath,
      output: approvalRoot,
      reviewer: "operator-demo",
      acknowledge: dossier.review.requiredReasons.join(","),
      demands: "not_applied",
    }),
    /does not match the reviewed private preview/i,
  );
  assert.equal(await pathExists(approvalRoot), false);
});

test("approve-review rejects a tampered private preview bundle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-preview-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const approvalRoot = path.join(directory, "approval");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: reviewRoot,
    select: "religious-bayane",
  }));
  const dossierPath = path.join(reviewRoot, "review.json");
  const dossier = JSON.parse(await readFile(dossierPath, "utf8"));
  const privateHtmlPath = path.join(
    reviewRoot,
    dossier.artifacts.privatePreviewRoot,
    "fr",
    "index.html",
  );
  await writeFile(privateHtmlPath, "<p>Unreviewed replacement</p>\n", "utf8");

  await assert.rejects(
    commandApproveReview({
      review: dossierPath,
      output: approvalRoot,
      reviewer: "operator-demo",
      acknowledge: dossier.review.requiredReasons.join(","),
      demands: "not_applied",
    }),
    /private preview bundle.*review dossier/i,
  );
  assert.equal(await pathExists(approvalRoot), false);
});

test("approve-review rejects output physically inside a symlink-aliased review root", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-approval-alias-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const aliasedParent = `${directory}-alias`;
  t.after(() => rm(aliasedParent, { force: true }));
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: reviewRoot,
    select: "religious-bayane",
  }));
  await symlink(directory, aliasedParent, "dir");

  const approvalRoot = path.join(reviewRoot, "approval");
  await assert.rejects(
    captureConsole(() => commandApproveReview({
      review: path.join(aliasedParent, "review", "review.json"),
      output: approvalRoot,
      reviewer: "operator-test",
      demands: "not_applied",
    })),
    /outside the immutable private review root/,
  );
  assert.equal(await pathExists(approvalRoot), false);
});

test("approve-review requires exact acknowledgement of review reasons", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-approval-reasons-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const approvalRoot = path.join(directory, "approval");
  const intake = structuredClone(baseIntake);
  intake.requestId = "req_private_approval_unknown_001";
  intake.baby.firstName = "Aélio-Z";
  intake.baby.nameArabic = "أيليو";
  await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({ input: intakePath, output: reviewRoot }));
  const dossierPath = path.join(reviewRoot, "review.json");

  await assert.rejects(
    commandApproveReview({
      review: dossierPath,
      output: approvalRoot,
      reviewer: "operator-demo",
      demands: "not_applied",
    }),
    /acknowledge exactly these review reasons: name_not_in_catalog/i,
  );
  assert.equal(await pathExists(approvalRoot), false);
});

test("checked-in Amal approval fixture reproduces its approved projection", async (t) => {
  const preparedRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-amal-fixture-"));
  t.after(() => rm(preparedRoot, { recursive: true, force: true }));

  const [page, approval, job] = await Promise.all(
    ["page.json", "approval.json", "job.json"].map(async (name) => JSON.parse(
      await readFile(path.join(amalFixtureRoot, name), "utf8"),
    )),
  );
  assert.equal(job.pageId, page.pageId);
  assert.equal(job.review.reviewedBy, approval.reviewer);
  assert.equal(job.review.reviewedAt, approval.reviewedAt);

  await captureConsole(() => commandRender({
    input: path.join(amalFixtureRoot, "page.json"),
    approval: path.join(amalFixtureRoot, "approval.json"),
    output: preparedRoot,
  }));

  assert.equal(await pathExists(path.join(preparedRoot, "deploy", "amal", "page.json")), true);
});

test("render rejects an approved page changed after the approval gate", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-approved-page-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const reviewRoot = path.join(directory, "review");
  const approvalRoot = path.join(directory, "approval");
  const preparedRoot = path.join(directory, "prepared");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: reviewRoot,
    select: "religious-bayane",
  }));
  const dossierPath = path.join(reviewRoot, "review.json");
  const dossier = JSON.parse(await readFile(dossierPath, "utf8"));
  await captureConsole(() => commandApproveReview({
    review: dossierPath,
    output: approvalRoot,
    reviewer: "operator-demo",
    acknowledge: dossier.review.requiredReasons.join(","),
    demands: "not_applied",
  }));
  const approvedPagePath = path.join(approvalRoot, "page.json");
  const approvedPage = JSON.parse(await readFile(approvedPagePath, "utf8"));
  approvedPage.sections.intro.fr.displayLines[0] = "Changed after approval";
  await writeFile(approvedPagePath, `${JSON.stringify(approvedPage, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandRender({
      input: approvedPagePath,
      output: preparedRoot,
      approval: path.join(approvalRoot, "approval.json"),
    }),
    /approved page.*approval artifact/i,
  );
  assert.equal(await pathExists(preparedRoot), false);
});

test("prepare-review refuses to reuse one private root for a different intake", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  const firstDossier = await readFile(path.join(outputRoot, "review.json"), "utf8");
  const changedIntake = structuredClone(baseIntake);
  changedIntake.requestId = "req_private_review_second_family_001";
  changedIntake.baby.firstName = "Aélio-Z";
  changedIntake.baby.nameArabic = "أيليو";
  await writeFile(intakePath, `${JSON.stringify(changedIntake, null, 2)}\n`, "utf8");

  await assert.rejects(
    captureConsole(() => commandPrepareReview({ input: intakePath, output: outputRoot })),
    /fresh output root/i,
  );
  assert.equal(await readFile(path.join(outputRoot, "review.json"), "utf8"), firstDossier);
  assert.equal(await pathExists(path.join(outputRoot, "private-preview", "bayane")), true);
  assert.equal(await pathExists(path.join(outputRoot, "private-preview", "aelio-z")), false);
});

test("prepare-review rejects operational or stale-family entries in a matching private root", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  await mkdir(path.join(outputRoot, "private-preview", "stale-family"));
  await mkdir(path.join(outputRoot, "deploy", "stale-family"), { recursive: true });
  await writeFile(path.join(outputRoot, "job.json"), "{}\n", "utf8");

  await assert.rejects(
    captureConsole(() => commandPrepareReview({
      input: intakePath,
      output: outputRoot,
      select: "religious-bayane",
    })),
    /unexpected entries|fresh output root/i,
  );
  assert.equal(await pathExists(path.join(outputRoot, "private-preview", "stale-family")), true);
  assert.equal(await pathExists(path.join(outputRoot, "deploy", "stale-family")), true);
  assert.equal(await pathExists(path.join(outputRoot, "job.json")), true);
});

test("prepare-review rejects an extra route inside the expected preview family on replay", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-extra-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const outputRoot = path.join(directory, "review");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }));
  await mkdir(path.join(outputRoot, "private-preview", "bayane", "extra-route"));
  await writeFile(
    path.join(outputRoot, "private-preview", "bayane", "extra-route", "index.html"),
    "unmanaged",
    "utf8",
  );

  await assert.rejects(
    captureConsole(() => commandPrepareReview({
      input: intakePath,
      output: outputRoot,
      select: "religious-bayane",
    })),
    /private preview bundle has changed/,
  );
});

test("prepare-review rejects symlinked managed output paths before writing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");

  for (const managedPath of ["private-preview", "artifacts"]) {
    const outputRoot = path.join(directory, `output-${managedPath}`);
    const externalRoot = path.join(directory, `external-${managedPath}`);
    await mkdir(outputRoot);
    await mkdir(externalRoot);
    await symlink(externalRoot, path.join(outputRoot, managedPath), "dir");

    await assert.rejects(
      captureConsole(() => commandPrepareReview({
        input: intakePath,
        output: outputRoot,
        select: "religious-bayane",
      })),
      /symbolic link/i,
    );
    assert.equal(await pathExists(path.join(externalRoot, "bayane")), false);
    assert.equal(await pathExists(path.join(externalRoot, "source", "page.json")), false);
  }
});

test("prepare-review rejects a nonexistent output beneath a symlinked ancestor", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-ancestor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const externalRoot = path.join(directory, "external");
  const linkedParent = path.join(directory, "linked-parent");
  const outputRoot = path.join(linkedParent, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await mkdir(externalRoot);
  await symlink(externalRoot, linkedParent, "dir");

  await assert.rejects(
    captureConsole(() => commandPrepareReview({
      input: intakePath,
      output: outputRoot,
      select: "religious-bayane",
    })),
    /symbolic link/i,
  );
  assert.equal(await pathExists(path.join(externalRoot, "output")), false);
});

test("render cannot enter private mode outside prepare-review", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-render-capability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const intakePath = path.join(directory, "intake.json");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "output");
  await writeFile(intakePath, `${JSON.stringify(baseIntake, null, 2)}\n`, "utf8");
  await captureConsole(() => commandCompose({
    input: intakePath,
    output: pagePath,
    select: "religious-bayane",
  }));

  await assert.rejects(
    commandRender({
      input: pagePath,
      output: outputRoot,
      "allow-draft": true,
      "private-review": true,
      "input-digest": "a".repeat(64),
    }),
    /only available through prepare-review/i,
  );

  await assert.rejects(
    commandRender({
      input: pagePath,
      output: outputRoot,
      "allow-draft": true,
    }, {
      privateReview: true,
      inputDigest: "a".repeat(64),
    }),
    /only available through prepare-review/i,
  );
  assert.equal(await pathExists(outputRoot), false);
});

test("prepare-review stops before writing artifacts when gendered copy is not yet safe", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-private-review-gender-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const gender of ["boy", "neutral"]) {
    const intakePath = path.join(directory, `${gender}.json`);
    const outputRoot = path.join(directory, gender);
    const intake = structuredClone(baseIntake);
    intake.requestId = `req_private_review_${gender}_001`;
    intake.baby.gender = gender;
    await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, "utf8");

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      let result;
      await captureConsole(async () => {
        result = await commandPrepareReview({ input: intakePath, output: outputRoot });
      });
      assert.equal(result.state, "needs_editorial_input");
      assert.deepEqual(result.reasons, ["unsupported_gender_copy"]);
      assert.equal(await pathExists(outputRoot), false);
    } finally {
      process.exitCode = previousExitCode;
    }
  }
});
