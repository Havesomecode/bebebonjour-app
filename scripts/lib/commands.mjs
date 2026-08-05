import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  PROJECT_ROOT,
  buildIdFromPage,
  cloneJson,
  copyTemplateAsset,
  DEFAULT_RENDERER_VERSION,
  DEFAULT_TEMPLATE_FAMILY,
  DEFAULT_TEMPLATE_VERSION,
  ensureDir,
  estimateSecondsForText,
  exists,
  formatSecondsMmss,
  getRenderPaths,
  nowIso,
  pageBaseFromSlug,
  readJson,
  requireArg,
  sectionNarrationText,
  slugify,
  writeJson,
  writeText,
} from "./common.mjs";
import { renderHtml } from "./render-html.mjs";
import { resolveName } from "./name-resolution.mjs";
import {
  assertValidNameResolutionEvidence,
  assertValidNarrationApproval,
  assertValidNarrationManifest,
  assertValidNarrationReview,
  assertValidReviewDossier,
  assertValidTranscript,
} from "./schema-validation.mjs";
import { assertValidIntake, assertValidJob, assertValidPage } from "./validators.mjs";

const TEMPLATE_APP_PATH = path.join(PROJECT_ROOT, "template", "runtime", "app.js");
const TEMPLATE_PHRASE_PROGRESS_PATH = path.join(
  PROJECT_ROOT,
  "template",
  "runtime",
  "phrase-progress.mjs",
);
const TEMPLATE_STYLES_PATH = path.join(PROJECT_ROOT, "template", "runtime", "styles.css");
const TEMPLATE_OG_PATH = path.join(PROJECT_ROOT, "template", "assets", "og-image.svg");
const REFERENCE_CATALOG_PATH = path.join(PROJECT_ROOT, "data", "reference-catalog.json");
const VERCEL_PROJECT_LINK_PATH = path.join(PROJECT_ROOT, ".vercel", "project.json");
const RENDERER_MATERIAL_PATHS = [
  path.join(PROJECT_ROOT, "scripts", "lib", "commands.mjs"),
  path.join(PROJECT_ROOT, "scripts", "lib", "common.mjs"),
  path.join(PROJECT_ROOT, "scripts", "lib", "name-resolution.mjs"),
  path.join(PROJECT_ROOT, "scripts", "lib", "render-html.mjs"),
  path.join(PROJECT_ROOT, "scripts", "lib", "schema-validation.mjs"),
  path.join(PROJECT_ROOT, "scripts", "lib", "validators.mjs"),
  path.join(PROJECT_ROOT, "schemas", "name-resolution-evidence.schema.json"),
  path.join(PROJECT_ROOT, "schemas", "narration-approval.schema.json"),
  path.join(PROJECT_ROOT, "schemas", "narration-manifest.schema.json"),
  path.join(PROJECT_ROOT, "schemas", "narration-review.schema.json"),
  path.join(PROJECT_ROOT, "schemas", "review-dossier.schema.json"),
  path.join(PROJECT_ROOT, "schemas", "transcript.schema.json"),
];
const TEMPLATE_MATERIAL_PATHS = [
  TEMPLATE_APP_PATH,
  TEMPLATE_PHRASE_PROGRESS_PATH,
  TEMPLATE_STYLES_PATH,
  TEMPLATE_OG_PATH,
];

export async function commandCompose(args, options = {}) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const output = path.resolve(process.cwd(), requireArg(args, "output"));
  const intake = options.intakeSnapshot
    ? cloneJson(options.intakeSnapshot)
    : await readJson(input);
  assertValidIntake(intake);
  if (args["private-review"] && intake.baby.gender !== "girl") {
    const result = {
      state: "needs_editorial_input",
      reasons: ["unsupported_gender_copy"],
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 3;
    return result;
  }

  const catalog = options.catalogSnapshot
    ? cloneJson(options.catalogSnapshot)
    : await readJson(REFERENCE_CATALOG_PATH);
  const nameResolution = resolveName(intake, catalog);
  const suggestions = nameResolution.suggestions;
  const selectionId = typeof args.select === "string" ? args.select : null;

  if (nameResolution.status === "review_required") {
    const result = {
      state: "name_review_required",
      match: nameResolution.match,
      reasons: nameResolution.reviewReasons,
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 3;
    return result;
  }

  if (!suggestions.length) {
    const blocked = {
      state: "blocked",
      reason: "No suitable references or meanings were found for this intake.",
      nextAction: "Decide whether to continue with general wishes or provide operator-authored content.",
    };
    console.log(JSON.stringify(blocked, null, 2));
    process.exitCode = 3;
    return blocked;
  }

  if (!selectionId && suggestions.length > 1) {
    const result = {
      state: "selection_required",
      suggestions: suggestions.map(({ id, label, basis, confidence }) => ({
        id,
        label,
        basis,
        confidence,
      })),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 3;
    return result;
  }

  const selected = selectionId
    ? suggestions.find((suggestion) => suggestion.id === selectionId)
    : suggestions[0];

  if (!selected) {
    throw new Error(`Unknown compose selection: ${selectionId}`);
  }

  const page = buildDraftPage(intake, selected, nameResolution);
  assertValidPage(page);
  await writeJson(output, page);

  const result = {
    state: "draft_created",
    output,
    suggestion: {
      id: selected.id,
      label: selected.label,
    },
    reviewStatus: page.review.status,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function commandPrepareReview(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const inputRaw = await readFile(input, "utf8");
  const intakeSnapshot = JSON.parse(inputRaw);
  assertValidIntake(intakeSnapshot);
  const composeArgs = {
    input,
    output: path.join(outputRoot, "artifacts", "source", "page.json"),
    "private-review": true,
    ...(typeof args.select === "string" ? { select: args.select } : {}),
  };
  if (intakeSnapshot.baby.gender !== "girl") {
    return commandCompose(composeArgs, { intakeSnapshot });
  }

  const inputDigest = createHash("sha256").update(inputRaw).digest("hex");
  const materialBinding = await buildPrivateReviewMaterialBinding(
    typeof args.select === "string" ? args.select : null,
  );
  const expectedPreviewRoot = path.posix.join(
    "private-preview",
    slugify(intakeSnapshot.slug || intakeSnapshot.baby.firstName),
  );
  await assertNoExistingSymbolicLinkComponents(outputRoot);
  await assertPrivateOutputCompatible(
    outputRoot,
    inputDigest,
    materialBinding.materialDigest,
    expectedPreviewRoot,
  );
  const composeResult = await commandCompose(composeArgs, {
    intakeSnapshot,
    catalogSnapshot: materialBinding.catalogSnapshot,
  });

  if (composeResult.state !== "draft_created") return composeResult;

  return renderPrivateReview({
    input: composeArgs.output,
    output: outputRoot,
    "allow-draft": true,
  }, {
    inputDigest,
    materialDigest: materialBinding.materialDigest,
    generationMaterials: materialBinding.generationMaterials,
  });
}

export async function commandApproveReview(args) {
  const dossierPath = path.resolve(process.cwd(), requireArg(args, "review"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const reviewer = requireArg(args, "reviewer").trim();
  if (!reviewer) throw new Error("approve-review requires a non-empty reviewer.");

  const reviewRoot = path.dirname(dossierPath);
  const [physicalReviewRoot, physicalOutputRoot] = await Promise.all([
    resolvePhysicalPath(reviewRoot),
    resolvePhysicalPath(outputRoot),
  ]);
  if (
    isPathInside(reviewRoot, outputRoot) ||
    isPathInside(physicalReviewRoot, physicalOutputRoot)
  ) {
    throw new Error("Approval output must be outside the immutable private review root.");
  }
  await assertNoExistingSymbolicLinkComponents(outputRoot);
  await assertFreshDirectory(outputRoot, "Approval output");
  await assertNoSymbolicLinks(reviewRoot);

  const dossierRaw = await readFile(dossierPath, "utf8");
  const dossier = JSON.parse(dossierRaw);
  assertValidNameResolutionEvidence(dossier?.evidence?.nameResolution);
  assertValidReviewDossier(dossier);

  const currentBinding = await buildPrivateReviewMaterialBinding(
    dossier.generationMaterials.selectionId,
  );
  if (
    dossier.materialDigest !== sha256(JSON.stringify(dossier.generationMaterials)) ||
    dossier.materialDigest !== currentBinding.materialDigest
  ) {
    throw new Error("Review dossier material binding does not match the current generator.");
  }

  const canonicalPagePath = resolveReviewArtifact(
    reviewRoot,
    dossier.artifacts.canonicalPage,
    "canonical page",
  );
  const privatePagePath = resolveReviewArtifact(
    reviewRoot,
    path.posix.join(dossier.artifacts.privatePreviewRoot, "page.json"),
    "private preview page",
  );
  const privatePreviewBundle = resolveReviewArtifact(
    reviewRoot,
    dossier.artifacts.privatePreviewBundle,
    "private preview bundle",
  );
  if (!isPathInside(privatePreviewBundle, privatePagePath)) {
    throw new Error("Review dossier private page must be inside its private preview bundle.");
  }
  const [canonicalPage, privatePage] = await Promise.all([
    readJson(canonicalPagePath),
    readJson(privatePagePath),
  ]);
  assertValidPage(canonicalPage);
  if (
    canonicalPage.pageId !== dossier.pageId ||
    canonicalPage.pageRevision !== dossier.revision ||
    canonicalPage.buildId !== dossier.buildId ||
    !isDeepStrictEqual(canonicalPage.review, dossier.review)
  ) {
    throw new Error("Review dossier does not match its canonical draft.");
  }
  if (!isDeepStrictEqual(privatePage, buildPublicPage(canonicalPage))) {
    throw new Error("Canonical draft does not match the reviewed private preview.");
  }
  if (await digestArtifactDirectory(privatePreviewBundle) !== dossier.artifacts.privatePreviewDigest) {
    throw new Error("Private preview bundle does not match the review dossier.");
  }

  const expectedReasons = [...dossier.review.requiredReasons].sort();
  const acknowledgedReasons = parseCommaSeparated(args.acknowledge).sort();
  if (!isDeepStrictEqual(acknowledgedReasons, expectedReasons)) {
    throw new Error(
      `Approval must acknowledge exactly these review reasons: ${expectedReasons.join(", ") || "none"}.`,
    );
  }

  const specificDemands = dossier.operatorContext.specificDemands;
  const demandsDisposition = typeof args.demands === "string" ? args.demands : null;
  if (specificDemands && !["applied", "not_applied"].includes(demandsDisposition)) {
    throw new Error("Approval must disposition specific demands as applied or not_applied.");
  }
  if (!specificDemands && demandsDisposition !== null) {
    throw new Error("Approval cannot disposition specific demands when none were submitted.");
  }
  if (!isDeepStrictEqual(canonicalPage.provenance?.specificDemands || null, specificDemands)) {
    throw new Error("Canonical draft specific demands do not match the review dossier.");
  }

  const reviewedAt = nowIso();
  const approvedPage = cloneJson(canonicalPage);
  approvedPage.review = {
    ...cloneJson(canonicalPage.review),
    status: "approved",
    reviewedBy: reviewer,
    reviewedAt,
  };
  if (specificDemands) {
    approvedPage.provenance.specificDemands.applicationStatus = demandsDisposition;
  }
  assertValidPage(approvedPage);

  const approvedPageRaw = `${JSON.stringify(approvedPage, null, 2)}\n`;
  const preparedBundleDigest = await computePreparedProjectionDigest(approvedPage);
  const approval = {
    schemaVersion: "1.0",
    state: "approved",
    reviewer,
    reviewedAt,
    pageId: approvedPage.pageId,
    revision: approvedPage.pageRevision,
    buildId: approvedPage.buildId,
    materialDigest: dossier.materialDigest,
    dossierDigest: sha256(dossierRaw),
    approvedPageDigest: sha256(approvedPageRaw),
    preparedBundleDigest,
    signatureAlgorithm: "hmac-sha256",
    acknowledgedReasons,
    demandsDisposition,
    artifacts: {
      approvedPage: "page.json",
      approval: "approval.json",
    },
  };
  approval.signature = signApprovalRecord(approval);

  await ensureDir(outputRoot);
  await writeFile(path.join(outputRoot, "page.json"), approvedPageRaw, "utf8");
  await writeJson(path.join(outputRoot, "approval.json"), approval);
  console.log(JSON.stringify({
    state: "review_approved",
    outputRoot,
    approvedPage: path.join(outputRoot, "page.json"),
    revision: approvedPage.pageRevision,
  }, null, 2));
  return approval;
}

function resolveReviewArtifact(reviewRoot, relativePath, label) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error(`Review dossier ${label} path must be relative.`);
  }
  const resolved = path.resolve(reviewRoot, relativePath);
  if (!isPathInside(reviewRoot, resolved)) {
    throw new Error(`Review dossier ${label} path escapes the review root.`);
  }
  return resolved;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function resolvePhysicalPath(targetPath) {
  let existingAncestor = path.resolve(targetPath);
  const missingComponents = [];
  while (!(await exists(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingComponents.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  return path.join(await realpath(existingAncestor), ...missingComponents);
}

async function assertOutputOutsideImmutableRoots(outputRoot, immutableRoots) {
  const physicalOutput = await resolvePhysicalPath(outputRoot);
  for (const immutableRoot of immutableRoots) {
    const physicalImmutableRoot = await resolvePhysicalPath(immutableRoot);
    if (
      isPathInside(physicalImmutableRoot, physicalOutput) ||
      isPathInside(physicalOutput, physicalImmutableRoot)
    ) {
      throw new Error("Output must be outside immutable narration inputs.");
    }
  }
}

async function assertFreshDirectory(directory, label) {
  if (!(await exists(directory))) return;
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (await readdir(directory)).length > 0) {
    throw new Error(`${label} must be a fresh empty directory.`);
  }
}

function parseCommaSeparated(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

async function buildPrivateReviewMaterialBinding(selectionId) {
  const catalogRaw = await readFile(REFERENCE_CATALOG_PATH);
  const generationMaterials = {
    selectionId,
    catalogDigest: sha256(catalogRaw),
    templateDigest: await digestMaterialFiles(TEMPLATE_MATERIAL_PATHS),
    rendererDigest: await digestMaterialFiles(RENDERER_MATERIAL_PATHS),
  };

  return {
    catalogSnapshot: JSON.parse(catalogRaw.toString("utf8")),
    generationMaterials,
    materialDigest: sha256(JSON.stringify(generationMaterials)),
  };
}

async function digestMaterialFiles(paths) {
  const digest = createHash("sha256");
  for (const materialPath of paths) {
    digest.update(path.relative(PROJECT_ROOT, materialPath));
    digest.update("\0");
    digest.update(await readFile(materialPath));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function digestArtifactDirectory(directory) {
  const files = [];

  async function collect(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Artifact bundle contains a symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(`Artifact bundle contains an unsupported entry: ${entryPath}`);
      }
    }
  }

  await collect(directory);
  const digest = createHash("sha256");
  for (const filePath of files) {
    digest.update(relativeArtifactPath(directory, filePath));
    digest.update("\0");
    digest.update(sha256(await readFile(filePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function approvalHmacKey() {
  const key = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("Approval requires BEBEBONJOUR_APPROVAL_HMAC_KEY with at least 32 bytes.");
  }
  return key;
}

function signApprovalRecord(approval) {
  const { signature: _signature, ...unsignedApproval } = approval;
  return createHmac("sha256", approvalHmacKey())
    .update(JSON.stringify(unsignedApproval))
    .digest("hex");
}

function assertValidApprovalSignature(approval) {
  if (
    approval?.signatureAlgorithm !== "hmac-sha256" ||
    !/^[a-f0-9]{64}$/.test(approval?.signature || "")
  ) {
    throw new Error("Approved page has no valid operator approval signature.");
  }
  const expected = Buffer.from(signApprovalRecord(approval), "hex");
  const actual = Buffer.from(approval.signature, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error("Approved page operator approval signature is invalid.");
  }
}

async function assertNoExistingSymbolicLinkComponents(targetPath) {
  const absolutePath = path.resolve(targetPath);
  const trustedTempRoot = path.resolve(os.tmpdir());
  const parsed = path.parse(absolutePath);
  let currentPath = parsed.root;

  for (const component of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, component);
    try {
      const metadata = await lstat(currentPath);
      if (metadata.isSymbolicLink()) {
        const isTrustedTempAlias =
          trustedTempRoot === currentPath || trustedTempRoot.startsWith(`${currentPath}${path.sep}`);
        if (!isTrustedTempAlias) {
          throw new Error(`Private review output path contains a symbolic link: ${currentPath}`);
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertPrivateOutputCompatible(
  outputRoot,
  inputDigest,
  materialDigest,
  expectedPreviewRoot,
) {
  if (!(await exists(outputRoot))) return;
  await assertNoSymbolicLinks(outputRoot);
  const entries = await readdir(outputRoot);
  if (entries.length === 0) return;

  const expectedTopLevelEntries = new Set(["artifacts", "private-preview", "review.json"]);
  if (
    entries.length !== expectedTopLevelEntries.size ||
    entries.some((entry) => !expectedTopLevelEntries.has(entry))
  ) {
    throw new Error("Private review output contains unexpected entries; use a fresh output root.");
  }

  const expectedSlug = expectedPreviewRoot.split("/").at(-1);
  const previewEntries = await readdir(path.join(outputRoot, "private-preview"));
  if (previewEntries.length !== 1 || previewEntries[0] !== expectedSlug) {
    throw new Error("Private review output contains an unexpected preview family; use a fresh output root.");
  }

  const dossierPath = path.join(outputRoot, "review.json");
  if (!(await exists(dossierPath))) {
    throw new Error("Private review output is not empty; use a fresh output root.");
  }
  const dossier = await readJson(dossierPath);
  if (
    dossier.inputDigest !== inputDigest ||
    dossier?.artifacts?.privatePreviewRoot !== expectedPreviewRoot
  ) {
    throw new Error("Private review output belongs to a different intake; use a fresh output root.");
  }
  if (dossier.materialDigest !== materialDigest) {
    throw new Error("Private review output belongs to different material inputs; use a fresh output root.");
  }
  assertValidReviewDossier(dossier);
  const privatePreviewBundle = resolveReviewArtifact(
    outputRoot,
    dossier.artifacts.privatePreviewBundle,
    "private preview bundle",
  );
  if (await digestArtifactDirectory(privatePreviewBundle) !== dossier.artifacts.privatePreviewDigest) {
    throw new Error("The existing private preview bundle has changed; use a fresh output root.");
  }
}

async function assertNoSymbolicLinks(targetPath) {
  const metadata = await lstat(targetPath);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Private review output contains a symbolic link: ${targetPath}`);
  }
  if (!metadata.isDirectory()) return;

  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    await assertNoSymbolicLinks(path.join(targetPath, entry.name));
  }
}

export async function commandRender(args, unsupportedOptions) {
  if (args["private-review"] || args["input-digest"] || unsupportedOptions !== undefined) {
    throw new Error("Private rendering is only available through prepare-review.");
  }
  return renderPage(args);
}

async function renderPrivateReview(args, materialBinding) {
  return renderPage(args, { privateReview: true, ...materialBinding });
}

async function writeProjectionArtifacts(
  page,
  outputRoot,
  { privateReview = false, includeCanonicalArtifacts = true } = {},
) {
  const renderPaths = getRenderPaths(page, outputRoot, {
    bundleDirectory: privateReview ? "private-preview" : "deploy",
  });
  await ensureDir(renderPaths.assetRoot);
  if (includeCanonicalArtifacts) await ensureDir(renderPaths.revisionsRoot);
  await ensureDir(path.join(renderPaths.slugRoot, "ar"));
  await ensureDir(path.join(renderPaths.slugRoot, "fr"));
  await copyTemplateAsset(TEMPLATE_APP_PATH, renderPaths.appJsPath);
  await copyTemplateAsset(
    TEMPLATE_PHRASE_PROGRESS_PATH,
    path.join(renderPaths.assetRoot, "phrase-progress.mjs"),
  );
  await copyTemplateAsset(TEMPLATE_STYLES_PATH, renderPaths.stylesPath);
  await copyTemplateAsset(TEMPLATE_OG_PATH, renderPaths.ogImagePath);

  const transcript = buildTranscript(page);
  const canonicalPage = cloneJson(page);
  canonicalPage.buildId = renderPaths.buildId;
  const publicPage = buildPublicPage(canonicalPage);
  await writeJson(renderPaths.deployedPagePath, publicPage);
  await writeJson(renderPaths.transcriptPath, transcript);
  if (includeCanonicalArtifacts) {
    await writeJson(renderPaths.currentPagePath, canonicalPage);
    await writeJson(renderPaths.pageRevisionPath, canonicalPage);
    await writeJson(renderPaths.currentTranscriptPath, transcript);
    await writeJson(renderPaths.transcriptRevisionPath, transcript);
  }

  for (const language of page.languages) {
    const languageDir = path.join(renderPaths.slugRoot, language);
    const assetBasePath = `../_assets/${renderPaths.buildId}`;
    const transcriptUrl = "../transcript.json";
    const ambientAudioUrl = `${assetBasePath}/audio/ambient.mp3`;
    const html = renderHtml({
      page,
      language,
      assetBasePath,
      transcriptUrl,
      ambientAudioUrl,
      reviewMode: privateReview ? "private" : null,
    });
    await writeText(path.join(languageDir, "index.html"), html);
  }

  return { renderPaths, transcript, canonicalPage };
}

export async function computePreparedProjectionDigest(page) {
  assertValidPage(page);
  const projectionRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-approved-projection-"));
  try {
    const { renderPaths } = await writeProjectionArtifacts(page, projectionRoot, {
      privateReview: false,
      includeCanonicalArtifacts: false,
    });
    return await digestArtifactDirectory(renderPaths.deployRoot);
  } finally {
    await rm(projectionRoot, { recursive: true, force: true });
  }
}

async function renderPage(args, options = {}) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const pageRaw = await readFile(input, "utf8");
  const page = JSON.parse(pageRaw);
  assertValidPage(page);

  const privateReview = options.privateReview === true;
  let approvalBinding = null;
  if (!privateReview && page.review.status === "approved") {
    approvalBinding = await verifyApprovalForRender(args, input, pageRaw, page);
  } else if (page.review.status !== "approved" && !args["allow-draft"]) {
    throw new Error("Render requires an approved page. Pass --allow-draft to override.");
  }

  if (privateReview && !/^[a-f0-9]{64}$/.test(options.inputDigest || "")) {
    throw new Error("Private rendering requires the prepared intake digest.");
  }
  const { renderPaths } = await writeProjectionArtifacts(page, outputRoot, { privateReview });

  if (privateReview) {
    const privatePreviewDigest = await digestArtifactDirectory(renderPaths.deployRoot);
    const dossier = buildReviewDossier(page, renderPaths, {
      inputDigest: options.inputDigest,
      materialDigest: options.materialDigest,
      generationMaterials: options.generationMaterials,
      privatePreviewDigest,
    });
    assertValidNameResolutionEvidence(dossier.evidence.nameResolution);
    assertValidReviewDossier(dossier);
    await writeJson(path.join(outputRoot, "review.json"), dossier);
    console.log(
      JSON.stringify(
        {
          state: "private_review_ready",
          outputRoot,
          privatePreviewRoot: renderPaths.deployRoot,
          revision: page.pageRevision,
          buildId: renderPaths.buildId,
        },
        null,
        2,
      ),
    );
    return dossier;
  }

  const preparedBundleDigest = await digestArtifactDirectory(renderPaths.deployRoot);
  if (approvalBinding && approvalBinding.preparedBundleDigest !== preparedBundleDigest) {
    throw new Error("Rendered deploy bundle does not match the approved prepared projection.");
  }
  const preparedApprovalBinding = approvalBinding ? { ...approvalBinding } : null;
  const job = (await exists(renderPaths.jobPath))
    ? updateJobForRenderedRevision(
        await readJson(renderPaths.jobPath),
        page,
        input,
        renderPaths,
        preparedApprovalBinding,
      )
    : buildJobFromPage(page, input, renderPaths, preparedApprovalBinding);
  job.status = "rendered";
  await writeJson(renderPaths.jobPath, job);

  console.log(
    JSON.stringify(
      {
        state: "rendered",
        outputRoot,
        deployRoot: renderPaths.deployRoot,
        slugRoot: renderPaths.slugRoot,
        buildId: renderPaths.buildId,
      },
      null,
      2,
    ),
  );
}

async function verifyApprovalForRender(args, inputPath, pageRaw, page) {
  const approvalPath = path.resolve(process.cwd(), requireArg(args, "approval"));
  return verifyApprovalArtifact(approvalPath, inputPath, pageRaw, page);
}

async function verifyApprovalArtifact(approvalPath, inputPath, pageRaw, page) {
  await assertNoExistingSymbolicLinkComponents(approvalPath);
  await assertNoSymbolicLinks(inputPath);
  await assertNoSymbolicLinks(approvalPath);

  const approvalRaw = await readFile(approvalPath, "utf8");
  const approval = JSON.parse(approvalRaw);
  assertValidApprovalSignature(approval);
  const approvalRoot = path.dirname(approvalPath);
  const approvedPagePath = resolveReviewArtifact(
    approvalRoot,
    approval?.artifacts?.approvedPage,
    "approved page",
  );
  const recordedApprovalPath = resolveReviewArtifact(
    approvalRoot,
    approval?.artifacts?.approval,
    "approval artifact",
  );
  if (approvedPagePath !== inputPath || recordedApprovalPath !== approvalPath) {
    throw new Error("Render approval artifact is not bound to the supplied approved page.");
  }

  const digestFields = [
    approval.materialDigest,
    approval.dossierDigest,
    approval.approvedPageDigest,
    approval.preparedBundleDigest,
  ];
  if (
    approval.schemaVersion !== "1.0" ||
    approval.state !== "approved" ||
    digestFields.some((value) => !/^[a-f0-9]{64}$/.test(value || "")) ||
    approval.pageId !== page.pageId ||
    approval.revision !== page.pageRevision ||
    approval.buildId !== page.buildId ||
    approval.reviewer !== page.review.reviewedBy ||
    approval.reviewedAt !== page.review.reviewedAt ||
    approval.approvedPageDigest !== sha256(pageRaw)
  ) {
    throw new Error("Approved page does not match its approval artifact.");
  }

  return {
    approvalDigest: sha256(approvalRaw),
    approvedPageDigest: approval.approvedPageDigest,
    preparedBundleDigest: approval.preparedBundleDigest,
    dossierDigest: approval.dossierDigest,
    materialDigest: approval.materialDigest,
    reviewer: approval.reviewer,
    reviewedAt: approval.reviewedAt,
  };
}

function buildReviewDossier(
  page,
  renderPaths,
  { inputDigest, materialDigest, generationMaterials, privatePreviewDigest },
) {
  return {
    schemaVersion: "1.0",
    state: "review_required",
    inputDigest,
    materialDigest,
    generationMaterials: cloneJson(generationMaterials),
    requestId: page.provenance.sourceRequestId,
    pageId: page.pageId,
    revision: page.pageRevision,
    buildId: renderPaths.buildId,
    review: cloneJson(page.review),
    operatorContext: {
      specificDemands: cloneJson(page.provenance.specificDemands),
    },
    evidence: {
      nameResolution: cloneJson(page.provenance.nameResolution),
      templateFamily: page.templateFamily,
      templateVersion: page.templateVersion,
      rendererVersion: page.rendererVersion,
    },
    artifacts: {
      canonicalPage: relativeArtifactPath(renderPaths.outputRoot, renderPaths.currentPagePath),
      canonicalTranscript: relativeArtifactPath(renderPaths.outputRoot, renderPaths.currentTranscriptPath),
      privatePreviewBundle: relativeArtifactPath(renderPaths.outputRoot, renderPaths.deployRoot),
      privatePreviewRoot: relativeArtifactPath(renderPaths.outputRoot, renderPaths.slugRoot),
      privatePreviewDigest,
    },
    warnings: ["narration_pending"],
  };
}

function relativeArtifactPath(outputRoot, artifactPath) {
  return path.relative(outputRoot, artifactPath).split(path.sep).join("/");
}

export async function commandTts(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const approvalPath = path.resolve(process.cwd(), requireArg(args, "approval"));
  const preparedRoot = path.resolve(process.cwd(), requireArg(args, "prepared"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const languageArg = typeof args.lang === "string" ? args.lang : "all";
  const selectedLanguages = languageArg === "all" ? null : languageArg.split(",");
  const pageRaw = await readFile(input, "utf8");
  const page = JSON.parse(pageRaw);
  assertValidPage(page);
  const approvalBinding = await verifyApprovalArtifact(approvalPath, input, pageRaw, page);
  const preparedJob = await readJson(path.join(preparedRoot, "job.json"));
  assertValidJob(preparedJob);
  await assertApprovedPreparedRevision(preparedJob, path.join(preparedRoot, "deploy"));
  if (preparedJob.approval?.approvalDigest !== approvalBinding.approvalDigest) {
    throw new Error("Narration staging requires the prepared bundle's exact content approval.");
  }
  await assertNoExistingSymbolicLinkComponents(outputRoot);
  await assertOutputOutsideImmutableRoots(outputRoot, [preparedRoot, input, approvalPath]);
  await assertFreshDirectory(outputRoot, "Narration review output");

  const preparedPaths = getRenderPaths(page, preparedRoot);
  const transcript = await readJson(preparedPaths.transcriptPath);
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY for TTS generation.");
  }

  const activeLanguages = selectedLanguages || page.languages;
  if (
    activeLanguages.length === 0 ||
    activeLanguages.some((language) => !page.languages.includes(language))
  ) {
    throw new Error("TTS languages must be enabled on the approved page.");
  }
  if (new Set(activeLanguages).size !== activeLanguages.length) {
    throw new Error("Duplicate narration language selections are not allowed.");
  }
  assertFfprobeAvailable();
  const artifactsRoot = path.join(outputRoot, "artifacts");
  const stagedPaths = {
    ...preparedPaths,
    audioRoot: path.join(artifactsRoot, "audio"),
  };
  const results = [];
  let partialFailure = false;

  for (const language of activeLanguages) {
    try {
      const manifest = await generateNarrationForLanguage({
        apiKey,
        language,
        page,
        renderPaths: stagedPaths,
        force: Boolean(args.force),
      });
      results.push({ language, status: "ok", files: manifest.files.length });
    } catch (error) {
      partialFailure = true;
      results.push({ language, status: "failed", error: narrationFailureCode(error) });
    }
  }

  const updatedTranscript = await rebuildTranscriptTimes(page, stagedPaths, transcript);
  await writeJson(path.join(artifactsRoot, "transcript.json"), updatedTranscript);
  const mediaDigest = await digestArtifactDirectory(artifactsRoot);
  const review = {
    schemaVersion: "1.0",
    state: partialFailure ? "narration_generation_failed" : "narration_review_required",
    pageId: page.pageId,
    revision: page.pageRevision,
    buildId: page.buildId,
    contentApprovalDigest: preparedJob.approval.approvalDigest,
    preparedBundleDigest: preparedJob.approval.preparedBundleDigest,
    generatedAt: nowIso(),
    languages: activeLanguages,
    results,
    mediaDigest,
    generation: {
      provider: "openai",
      model: page.audioPlan.model,
      voiceByLanguage: Object.fromEntries(
        activeLanguages.map((language) => [language, page.audioPlan.voiceByLanguage[language]]),
      ),
    },
    artifacts: {
      root: "artifacts",
      transcript: "artifacts/transcript.json",
    },
  };
  assertValidNarrationReview(review);
  await writeJson(path.join(outputRoot, "review.json"), review);

  console.log(JSON.stringify({ state: review.state, outputRoot, results }, null, 2));
  if (partialFailure) process.exitCode = 9;
}

export async function commandApproveNarration(args) {
  const reviewPath = path.resolve(process.cwd(), requireArg(args, "review"));
  const preparedRoot = path.resolve(process.cwd(), requireArg(args, "prepared"));
  const outputRoot = path.resolve(process.cwd(), requireArg(args, "output"));
  const reviewer = requireArg(args, "reviewer").trim();
  if (!reviewer) throw new Error("Narration approval requires a reviewer identity.");

  approvalHmacKey();
  await Promise.all([
    assertNoExistingSymbolicLinkComponents(reviewPath),
    assertNoExistingSymbolicLinkComponents(preparedRoot),
    assertNoExistingSymbolicLinkComponents(outputRoot),
  ]);
  await assertOutputOutsideImmutableRoots(outputRoot, [preparedRoot, path.dirname(reviewPath)]);
  await assertNoSymbolicLinks(path.dirname(reviewPath));
  await assertFreshDirectory(outputRoot, "Narration approval output");

  const reviewRaw = await readFile(reviewPath, "utf8");
  const review = JSON.parse(reviewRaw);
  const reviewRoot = path.dirname(reviewPath);
  assertValidNarrationReview(review);
  if (reviewPath !== path.join(reviewRoot, "review.json")) {
    throw new Error("Narration approval requires the review root's review.json artifact.");
  }
  const entries = await readdir(reviewRoot);
  if (
    entries.length !== 2 ||
    !entries.includes("artifacts") ||
    !entries.includes("review.json")
  ) {
    throw new Error("Narration review root contains unexpected entries.");
  }
  const artifactsRoot = resolveReviewArtifact(reviewRoot, review?.artifacts?.root, "narration artifacts");
  const transcriptPath = resolveReviewArtifact(
    reviewRoot,
    review?.artifacts?.transcript,
    "narration transcript",
  );
  if (!isPathInside(artifactsRoot, transcriptPath)) {
    throw new Error("Narration transcript must be inside the reviewed artifact root.");
  }
  if (
    review.schemaVersion !== "1.0" ||
    review.state !== "narration_review_required" ||
    !/^[a-f0-9]{64}$/.test(review.contentApprovalDigest || "") ||
    !/^[a-f0-9]{64}$/.test(review.preparedBundleDigest || "") ||
    !/^[a-f0-9]{64}$/.test(review.mediaDigest || "") ||
    !Array.isArray(review.languages) ||
    review.languages.length === 0 ||
    review.results.length !== review.languages.length ||
    review.results.some((result, index) =>
      result.language !== review.languages[index] || result.status !== "ok"
    ) ||
    await digestArtifactDirectory(artifactsRoot) !== review.mediaDigest
  ) {
    throw new Error("Narration review material is invalid or has changed.");
  }
  const acknowledgedLanguages = parseCommaSeparated(args.acknowledge).sort();
  const reviewedLanguages = [...new Set(review.languages)].sort();
  if (!isDeepStrictEqual(acknowledgedLanguages, reviewedLanguages)) {
    throw new Error(`Narration approval must acknowledge exactly: ${reviewedLanguages.join(", ")}.`);
  }

  const preparedJob = await readJson(path.join(preparedRoot, "job.json"));
  assertValidJob(preparedJob);
  await assertApprovedPreparedRevision(preparedJob, path.join(preparedRoot, "deploy"));
  const sourcePagePath = preparedJob.paths.sourcePage;
  const page = await readJson(sourcePagePath);
  assertValidPage(page);
  if (
    preparedJob.pageId !== review.pageId ||
    preparedJob.currentPreparedRevision !== review.revision ||
    page.buildId !== review.buildId ||
    review.languages.some((language) => !page.languages.includes(language)) ||
    review.results.some((result) => result.files !== page.sectionOrder.length) ||
    preparedJob.approval?.approvalDigest !== review.contentApprovalDigest ||
    preparedJob.approval?.preparedBundleDigest !== review.preparedBundleDigest
  ) {
    throw new Error("Narration review does not match the prepared content approval.");
  }
  await assertNarrationArtifactInventory(page, artifactsRoot, reviewedLanguages);

  const sourceApprovalPath = path.join(path.dirname(sourcePagePath), "approval.json");
  await renderPage({
    input: sourcePagePath,
    approval: sourceApprovalPath,
    output: outputRoot,
  });
  const finalPaths = getRenderPaths(page, outputRoot);
  await cp(path.join(artifactsRoot, "audio"), finalPaths.audioRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const transcriptRaw = await readFile(transcriptPath, "utf8");
  await Promise.all([
    writeFile(finalPaths.transcriptPath, transcriptRaw, "utf8"),
    writeFile(finalPaths.currentTranscriptPath, transcriptRaw, "utf8"),
    writeFile(finalPaths.transcriptRevisionPath, transcriptRaw, "utf8"),
  ]);

  await cp(reviewRoot, path.join(outputRoot, "narration-review"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const reviewedAt = nowIso();
  const narrationApproval = {
    schemaVersion: "1.0",
    state: "approved",
    reviewer,
    reviewedAt,
    pageId: review.pageId,
    revision: review.revision,
    buildId: review.buildId,
    contentApprovalDigest: review.contentApprovalDigest,
    basePreparedBundleDigest: review.preparedBundleDigest,
    narrationReviewDigest: sha256(reviewRaw),
    mediaDigest: review.mediaDigest,
    preparedBundleDigest: await digestArtifactDirectory(finalPaths.deployRoot),
    acknowledgedLanguages,
    signatureAlgorithm: "hmac-sha256",
    artifacts: {
      narrationReview: "narration-review/review.json",
      narrationApproval: "narration-approval.json",
    },
  };
  narrationApproval.signature = signApprovalRecord(narrationApproval);
  assertValidNarrationApproval(narrationApproval);
  const narrationApprovalRaw = `${JSON.stringify(narrationApproval, null, 2)}\n`;
  await writeFile(path.join(outputRoot, "narration-approval.json"), narrationApprovalRaw, "utf8");

  const finalJob = await readJson(finalPaths.jobPath);
  finalJob.narrationApproval = {
    approvalDigest: sha256(narrationApprovalRaw),
    contentApprovalDigest: narrationApproval.contentApprovalDigest,
    narrationReviewDigest: narrationApproval.narrationReviewDigest,
    mediaDigest: narrationApproval.mediaDigest,
    preparedBundleDigest: narrationApproval.preparedBundleDigest,
    reviewer,
    reviewedAt,
  };
  await writeJson(finalPaths.jobPath, finalJob);
  console.log(JSON.stringify({
    state: "narration_approved",
    outputRoot,
    revision: narrationApproval.revision,
    languages: acknowledgedLanguages,
  }, null, 2));
  return narrationApproval;
}

export async function commandDeploy(args) {
  const input = path.resolve(process.cwd(), requireArg(args, "input"));
  const jobPath = args.job ? path.resolve(process.cwd(), args.job) : path.join(input, "job.json");
  await assertNoExistingSymbolicLinkComponents(input);
  await assertNoExistingSymbolicLinkComponents(jobPath);
  const job = await readJson(jobPath);
  assertValidJob(job);

  const deployRoot = path.join(input, "deploy");
  await assertNoExistingSymbolicLinkComponents(deployRoot);
  if (!job.paths?.deployRoot || path.resolve(process.cwd(), job.paths.deployRoot) !== deployRoot) {
    throw new Error("Deploy input must match the deploy root recorded in the job.");
  }
  if (!(await exists(deployRoot))) {
    throw new Error(`Missing deploy directory: ${deployRoot}`);
  }

  await assertApprovedPreparedRevision(job, deployRoot);

  if (args["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          state: "deploy_ready",
          deployRoot,
          revision: job.currentPreparedRevision,
        },
        null,
        2,
      ),
    );
    return;
  }

  const token = process.env.VERCEL_TOKEN;
  await ensureVercelProjectLink();
  const vercelArgs = ["deploy", deployRoot, "--prod", "--yes"];
  if (token) {
    vercelArgs.push("--token", token);
  }

  const result = spawnSync("vercel", vercelArgs, {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Vercel deploy failed.");
  }

  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  const aliasedUrl = findUrlInLines(lines, "Aliased:");
  const productionUrl = findUrlInLines(lines, "Production:");
  const publicUrl = aliasedUrl || productionUrl || findFirstUrl(lines);
  job.status = "deployed";
  job.currentLiveRevision = job.currentPreparedRevision || job.currentLiveRevision;
  job.deploy = {
    provider: "vercel",
    deployedAt: nowIso(),
    deployRoot,
    publicUrl: publicUrl || null,
    rawOutput: lines.slice(-10),
  };
  await writeJson(jobPath, job);

  console.log(JSON.stringify({ state: "deployed", publicUrl }, null, 2));
}

export async function commandSend(args) {
  const jobPath = path.resolve(process.cwd(), requireArg(args, "job"));
  const provider = typeof args.provider === "string" ? args.provider : "console";
  await assertNoExistingSymbolicLinkComponents(jobPath);
  const job = await readJson(jobPath);
  assertValidJob(job);

  if (provider !== "console") {
    throw new Error(`Unsupported send provider: ${provider}`);
  }

  const expectedDeployRoot = path.join(path.dirname(jobPath), "deploy");
  await assertNoExistingSymbolicLinkComponents(expectedDeployRoot);
  if (path.resolve(job.paths?.deployRoot || "") !== expectedDeployRoot) {
    throw new Error("Delivery requires the job-local prepared deploy root.");
  }
  await assertApprovedPreparedRevision(job, expectedDeployRoot);

  if (args["dry-run"]) {
    console.log(JSON.stringify({
      state: "delivery_preview",
      provider,
      deploymentReady: true,
      recipientConfigured: Boolean(job.customer?.email),
      publicUrlConfigured: false,
    }, null, 2));
    return;
  }

  if (!job.deploy?.publicUrl) {
    throw new Error("Cannot send delivery without a publicUrl in job.deploy.");
  }

  console.log(
    JSON.stringify(
      {
        state: "delivery_preview",
        provider,
        recipientConfigured: Boolean(job.customer?.email),
        publicUrlConfigured: true,
      },
      null,
      2,
    ),
  );
}

export async function commandStatus(args) {
  const target = args.job ? path.resolve(process.cwd(), args.job) : null;
  if (!target) {
    throw new Error("status requires --job <job.json>");
  }

  const job = await readJson(target);
  assertValidJob(job);
  const payload = {
    jobId: job.jobId,
    status: job.status,
    pageId: job.pageId,
    slug: job.slug,
    currentPreparedRevision: job.currentPreparedRevision || null,
    currentLiveRevision: job.currentLiveRevision || null,
    templateVersion: job.templateVersion,
    rendererVersion: job.rendererVersion,
    publicUrl: job.deploy?.publicUrl || null,
    email: job.email?.status || "pending",
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Job: ${payload.jobId}`);
  console.log(`Status: ${payload.status}`);
  console.log(`Slug: ${payload.slug}`);
  console.log(`Prepared Revision: ${payload.currentPreparedRevision ?? "none"}`);
  console.log(`Live Revision: ${payload.currentLiveRevision ?? "none"}`);
  console.log(`Template: ${payload.templateVersion}`);
  console.log(`Renderer: ${payload.rendererVersion}`);
  console.log(`Public URL: ${payload.publicUrl ?? "not deployed"}`);
  console.log(`Email: ${payload.email}`);
}

function buildDraftPage(intake, suggestion, nameResolution) {
  const slug = slugify(intake.slug || intake.baby.firstName);
  const pageId = `page_${slug}_${sha256(intake.requestId).slice(0, 16)}`;
  const pageRevision = "r1";
  const sectionOrder = Array.isArray(intake?.preferences?.sectionOrder)
    ? intake.preferences.sectionOrder
    : ["intro", "dua", "meaning", "reveal", "verses", "closing"];
  const languages = intake.languages;
  const nameLatin = nameResolution.display.latin;
  const nameArabic = nameResolution.display.arabic || nameLatin;
  const childLabel = intake.baby.gender === "boy"
    ? { ar: "بابننا", fr: "notre fils" }
    : { ar: "بابنتنا", fr: "notre fille" };

  const sections = buildSections({
    intake,
    suggestion,
    childLabel,
    nameLatin,
    nameArabic,
    languages,
  });

  return {
    schemaVersion: "1.0",
    pageId,
    slug,
    languages,
    defaultLanguage: languages.includes("ar") ? "ar" : languages[0],
    templateFamily: DEFAULT_TEMPLATE_FAMILY,
    templateVersion: DEFAULT_TEMPLATE_VERSION,
    rendererVersion: DEFAULT_RENDERER_VERSION,
    pageRevision,
    featureFlags: suggestion.featureFlags || [],
    sectionOrder,
    identity: {
      nameLatin,
      nameArabic,
      gender: intake.baby.gender,
      childLabel,
    },
    seo: {
      title: `Une Naissance Bénie | ${nameLatin}`,
      description: suggestion.description || `A birth announcement page for ${nameLatin}.`,
      ogImageMode: "static",
    },
    sections,
    audioPlan: {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voiceByLanguage: {
        ar: intake.voicePreference.gender === "female" ? "alloy" : "cedar",
        fr: intake.voicePreference.gender === "female" ? "alloy" : "cedar",
      },
      instructionsByLanguage: {
        ar: intake.voicePreference.gender === "female"
          ? "Soft, spiritual, contemplative, and warm."
          : "Speak in natural Modern Standard Arabic to one beloved family member sitting nearby. Do not perform, formally narrate, preach, or recite. Let the thoughts feel as if they are forming while you speak. Underplay the emotion: a private smile, quiet happiness, and affectionate closeness rather than projected excitement. Use tiny unsymmetrical hesitations before meaningful phrases, naturally uneven micro-pauses, slightly softer phrase endings, and relaxed articulation. Keep sacred wording respectful and keep the exact words, but do not over-enunciate them. Avoid polished voice-message energy, announcer cadence, rhythmic sentence symmetry, theatrical warmth, audiobook tone, and synthetic precision.",
        fr: intake.voicePreference.gender === "female"
          ? "Soft, spiritual, contemplative, and warm."
          : "Speak in natural metropolitan French to one beloved family member sitting nearby. Do not perform and do not narrate. Let the thoughts feel as if they are forming while you speak. Underplay the emotion: a private smile, quiet happiness, and affectionate closeness rather than projected excitement. Use tiny unsymmetrical hesitations before meaningful phrases, naturally uneven micro-pauses, slightly softer phrase endings, and relaxed articulation. Keep the exact words, but do not over-enunciate them. Avoid polished voice-message energy, announcer cadence, rhythmic sentence symmetry, theatrical warmth, audiobook tone, advertising tone, and synthetic precision.",
      },
    },
    review: {
      status: "draft",
      reviewedBy: null,
      reviewedAt: null,
      requiredReasons: nameResolution.reviewReasons,
    },
    provenance: {
      sourceRequestId: intake.requestId,
      composeSuggestionId: suggestion.id,
      composeBasis: suggestion.basis,
      customerEmail: intake.customer.email,
      specificDemands: normalizeSpecificDemands(intake?.notes?.specificDemands),
      nameResolution: buildNameResolutionEvidence(nameResolution),
    },
  };
}

function normalizeSpecificDemands(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized
    ? { value: normalized, applicationStatus: "not_evaluated" }
    : null;
}

function buildNameResolutionEvidence(nameResolution) {
  return cloneJson({
    status: nameResolution.status,
    normalized: nameResolution.normalized,
    match: nameResolution.match,
    confidence: nameResolution.confidence,
    claimPolicy: nameResolution.claimPolicy,
    reviewReasons: nameResolution.reviewReasons,
    sourceKeys: nameResolution.sourceKeys,
  });
}

function buildSections({ intake, suggestion, childLabel, nameLatin, nameArabic, languages }) {
  const religion = intake?.context?.religion || null;
  const sections = {};
  const meaning = suggestion.meaning || {};
  const verses = enforceScripturalClaimPolicy(suggestion);
  const meaningAllowed = suggestion.claimPolicy?.meaningAllowed !== false;

  sections.intro = {};
  sections.dua = {};
  sections.meaning = {};
  sections.reveal = {};
  sections.verses = {};
  sections.closing = {};

  if (languages.includes("ar")) {
    sections.intro.ar = {
      displayLines: suggestion.arIntroLines || [
        "بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ.",
        `بفضل الله استقبلنا ${childLabel.ar} ${nameArabic}.`,
      ],
      narrationText:
        suggestion.arIntroNarration ||
        `بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ. بفضل الله استقبلنا ${childLabel.ar} ${nameArabic}.`,
    };
    sections.dua.ar = {
      displayLines:
        religion === "islam"
          ? suggestion.arDuaLines || [
              `نسأل الله أن يجعل ${nameArabic} قرة عين لنا،`,
              "وأن يبارك في أيامها ويجعلها نورًا ورحمة.",
            ]
          : suggestion.arWishLines || [
              `نتمنى لـ ${nameArabic} حياة مليئة بالنور والسكينة،`,
              "وأيامًا لطيفة وبركة لمن حولها.",
            ],
      narrationText:
        religion === "islam"
          ? suggestion.arDuaNarration ||
            `نسأل الله أن يجعل ${nameArabic} قرة عين لنا، وأن يبارك في أيامها ويجعلها نورًا ورحمة.`
          : suggestion.arWishNarration ||
            `نتمنى لـ ${nameArabic} حياة مليئة بالنور والسكينة، وأيامًا لطيفة وبركة لمن حولها.`,
    };
    sections.meaning.ar = meaningAllowed && meaning.ar
      ? {
          displayLines: suggestion.arMeaningLines || [
            `اخترنا اسم ${nameArabic} لما يحمله من معنى ${meaning.ar}.`,
            "اسم يترك أثرًا من الوضوح والطمأنينة.",
          ],
          narrationText:
            suggestion.arMeaningNarration ||
            `اخترنا اسم ${nameArabic} لما يحمله من معنى ${meaning.ar}. اسم يترك أثرًا من الوضوح والطمأنينة.`,
        }
      : {
          displayLines: [
            `اخترنا اسم ${nameArabic} بمحبة.`,
            "اسم فريد يحمل القصة التي تمنحها له عائلته.",
          ],
          narrationText: `اخترنا اسم ${nameArabic} بمحبة. اسم فريد يحمل القصة التي تمنحها له عائلته.`,
        };
    sections.reveal.ar = {
      introLines: suggestion.arRevealIntroLines || ["بفضل الله ومنته", `رزقنا ${childLabel.ar}...`],
      name: suggestion.arRevealName || nameArabic,
      narrationText:
        suggestion.arRevealNarration || `بفضل الله ومنته رزقنا ${childLabel.ar} ${nameArabic}.`,
    };
    sections.verses.ar = {
      introLine: verses.ar.length
        ? (religion === "islam" ? "قال تعالى:" : "كلمات مختارة:")
        : (religion === "islam" ? "دعاء وأمنيات:" : "أمنيات جميلة:"),
      items: verses.ar.length
        ? verses.ar
        : [{ quote: "نور وأمل ورحمة", reference: "أمنية عامة", sourceKey: "generic-wish-ar" }],
      narrationText:
        (verses.ar.length
          ? verses.ar.map((item) => `${item.quote} ${item.reference}`).join(" ")
          : "نور وأمل ورحمة."),
    };
    sections.closing.ar = {
      displayLines: suggestion.arClosingLines || [
        `اللهم بارك في ${nameArabic}.`,
        "واجعل أيامها لطفًا ورحمة وسكينة.",
      ],
      narrationText:
        suggestion.arClosingNarration ||
        `اللهم بارك في ${nameArabic}. واجعل أيامها لطفًا ورحمة وسكينة.`,
    };
  }

  if (languages.includes("fr")) {
    sections.intro.fr = {
      displayLines: suggestion.frIntroLines || [
        `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr}.`,
        `${nameLatin} est entrée dans nos vies avec douceur.`,
      ],
      narrationText:
        suggestion.frIntroNarration ||
        `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr}. ${nameLatin} est entrée dans nos vies avec douceur.`,
    };
    sections.dua.fr = {
      displayLines:
        religion === "islam"
          ? suggestion.frDuaLines || [
              `Nous demandons à Dieu de bénir ${nameLatin},`,
              "et de faire de ses jours une lumière et une miséricorde.",
            ]
          : suggestion.frWishLines || [
              `Nous souhaitons à ${nameLatin} une vie douce et lumineuse,`,
              "faite de paix, de tendresse et de joie.",
            ],
      narrationText:
        religion === "islam"
          ? suggestion.frDuaNarration ||
            `Nous demandons à Dieu de bénir ${nameLatin}, et de faire de ses jours une lumière et une miséricorde.`
          : suggestion.frWishNarration ||
            `Nous souhaitons à ${nameLatin} une vie douce et lumineuse, faite de paix, de tendresse et de joie.`,
    };
    sections.meaning.fr = meaningAllowed && meaning.fr
      ? {
          displayLines: suggestion.frMeaningLines || [
            `Nous avons choisi ${nameLatin} pour la beauté de son sens : ${meaning.fr}.`,
            "Un nom porté par la clarté et l'espérance.",
          ],
          narrationText:
            suggestion.frMeaningNarration ||
            `Nous avons choisi ${nameLatin} pour la beauté de son sens : ${meaning.fr}. Un nom porté par la clarté et l'espérance.`,
        }
      : {
          displayLines: [
            `Nous avons choisi ${nameLatin} avec amour.`,
            "Un prénom unique, porté par l'histoire que sa famille lui donnera.",
          ],
          narrationText:
            `Nous avons choisi ${nameLatin} avec amour. Un prénom unique, porté par l'histoire que sa famille lui donnera.`,
        };
    sections.reveal.fr = {
      introLines: suggestion.frRevealIntroLines || ["Par la grâce de Dieu,", `nous avons accueilli ${childLabel.fr}...`],
      name: suggestion.frRevealName || nameLatin,
      narrationText:
        suggestion.frRevealNarration || `Par la grâce de Dieu, nous avons accueilli ${childLabel.fr} ${nameLatin}.`,
    };
    sections.verses.fr = {
      introLine: verses.fr.length
        ? (religion === "islam" ? "Versets choisis :" : "Textes choisis :")
        : (religion === "islam" ? "Vœux et bénédictions :" : "Vœux de bonheur :"),
      items: verses.fr.length
        ? verses.fr
        : [{ quote: "Lumière, paix et espérance.", reference: "Vœu général", sourceKey: "generic-wish-fr" }],
      narrationText:
        (verses.fr.length
          ? verses.fr.map((item) => `${item.quote} ${item.reference}`).join(" ")
          : "Lumière, paix et espérance."),
    };
    sections.closing.fr = {
      displayLines: suggestion.frClosingLines || [
        `Que ${nameLatin} grandisse dans la paix et la lumière,`,
        "et qu'elle soit une joie pour ceux qui l'entourent.",
      ],
      narrationText:
        suggestion.frClosingNarration ||
        `Que ${nameLatin} grandisse dans la paix et la lumière, et qu'elle soit une joie pour ceux qui l'entourent.`,
    };
  }

  return sections;
}

function enforceScripturalClaimPolicy(suggestion) {
  if (suggestion.claimPolicy?.scripturalNameAssociationAllowed !== true) {
    return { ar: [], fr: [] };
  }
  return Object.fromEntries(
    ["ar", "fr"].map((language) => [
      language,
      (suggestion?.verses?.[language] || []).filter(
        (item) => typeof item?.sourceKey === "string" && item.sourceKey.trim(),
      ),
    ]),
  );
}

function buildTranscript(page) {
  const transcript = { version: 1, tracks: {} };

  for (const language of page.languages) {
    let rolling = 0;
    transcript.tracks[language] = page.sectionOrder.map((sectionId) => {
      const text = sectionNarrationText(page.sections[sectionId], language);
      const entry = {
        section: sectionId,
        text,
        time: formatSecondsMmss(rolling),
        seconds: rolling,
      };
      rolling += estimateSecondsForText(text);
      return entry;
    });
  }

  return transcript;
}

function buildJobFromPage(page, inputPath, renderPaths, approvalBinding = null) {
  return {
    schemaVersion: "1.0",
    jobId: `job_${page.slug}`,
    pageId: page.pageId,
    slug: page.slug,
    status: "created",
    templateFamily: page.templateFamily,
    templateVersion: page.templateVersion,
    rendererVersion: page.rendererVersion,
    currentPreparedRevision: page.pageRevision,
    currentLiveRevision: null,
    paths: {
      sourcePage: inputPath,
      currentPage: renderPaths.currentPagePath,
      currentTranscript: renderPaths.currentTranscriptPath,
      deployRoot: renderPaths.deployRoot,
    },
    customer: {
      email: page.provenance?.customerEmail || null,
      nameLatin: page.identity.nameLatin,
      nameArabic: page.identity.nameArabic,
      languages: page.languages,
    },
    review: cloneJson(page.review),
    approval: cloneJson(approvalBinding),
    deploy: null,
    email: {
      status: "pending",
    },
    revisionHistory: [
      {
        revision: page.pageRevision,
        renderedAt: nowIso(),
        buildId: renderPaths.buildId,
      },
    ],
  };
}

function updateJobForRenderedRevision(job, page, inputPath, renderPaths, approvalBinding) {
  const next = cloneJson(job);
  const alreadyTracked = (next.revisionHistory || []).some((entry) => entry.revision === page.pageRevision);

  next.pageId = page.pageId;
  next.slug = page.slug;
  next.templateFamily = page.templateFamily;
  next.templateVersion = page.templateVersion;
  next.rendererVersion = page.rendererVersion;
  next.currentPreparedRevision = page.pageRevision;
  next.paths = {
    sourcePage: inputPath,
    currentPage: renderPaths.currentPagePath,
    currentTranscript: renderPaths.currentTranscriptPath,
    deployRoot: renderPaths.deployRoot,
  };
  next.customer = {
    email: page.provenance?.customerEmail || next.customer?.email || null,
    nameLatin: page.identity.nameLatin,
    nameArabic: page.identity.nameArabic,
    languages: page.languages,
  };
  next.review = cloneJson(page.review);
  next.approval = cloneJson(approvalBinding);
  next.revisionHistory = next.revisionHistory || [];

  if (!alreadyTracked) {
    next.revisionHistory.push({
      revision: page.pageRevision,
      renderedAt: nowIso(),
      buildId: renderPaths.buildId,
    });
  }

  return next;
}

function buildPublicPage(page) {
  const {
    schemaVersion,
    pageId,
    slug,
    languages,
    defaultLanguage,
    templateFamily,
    templateVersion,
    rendererVersion,
    pageRevision,
    buildId,
    sectionOrder,
    identity,
    seo,
    sections,
  } = page;

  return cloneJson({
    schemaVersion,
    pageId,
    slug,
    languages,
    defaultLanguage,
    templateFamily,
    templateVersion,
    rendererVersion,
    pageRevision,
    buildId,
    sectionOrder,
    identity,
    seo,
    sections,
  });
}

async function assertNarrationArtifactInventory(page, artifactsRoot, languages) {
  assertFfprobeAvailable();
  const artifactEntries = (await readdir(artifactsRoot)).sort();
  if (!isDeepStrictEqual(artifactEntries, ["audio", "transcript.json"])) {
    throw new Error("Reviewed narration artifacts contain unexpected inventory.");
  }
  const audioRoot = path.join(artifactsRoot, "audio");
  if (!isDeepStrictEqual(await readdir(audioRoot), ["narration"])) {
    throw new Error("Reviewed narration audio contains unexpected inventory.");
  }
  const narrationRoot = path.join(audioRoot, "narration");
  if (!isDeepStrictEqual((await readdir(narrationRoot)).sort(), [...languages].sort())) {
    throw new Error("Reviewed narration languages do not match their audio inventory.");
  }

  const transcript = await readJson(path.join(artifactsRoot, "transcript.json"));
  if (transcript.version !== 1 || !transcript.tracks || typeof transcript.tracks !== "object") {
    throw new Error("Reviewed narration transcript is invalid.");
  }
  assertValidTranscript(transcript);
  const expectedTranscript = buildTranscript(page);
  if (!isDeepStrictEqual(Object.keys(transcript.tracks).sort(), [...page.languages].sort())) {
    throw new Error("Narration transcript languages do not match the approved page.");
  }
  for (const language of page.languages) {
    const track = transcript.tracks[language];
    const expectedTrack = expectedTranscript.tracks[language];
    if (!Array.isArray(track) || track.length !== page.sectionOrder.length) {
      throw new Error(`Narration transcript is incomplete for ${language}.`);
    }
    for (const [index, section] of page.sectionOrder.entries()) {
      const entry = track[index];
      const expectedEntry = expectedTrack[index];
      if (
        entry.section !== section ||
        entry.text !== expectedEntry.text ||
        (!languages.includes(language) &&
          (entry.time !== expectedEntry.time || entry.seconds !== expectedEntry.seconds))
      ) {
        throw new Error(`Narration transcript does not match the approved page for ${language}.`);
      }
    }
  }
  const manifests = {};
  for (const language of languages) {
    const languageRoot = path.join(narrationRoot, language);
    const manifest = await readJson(path.join(languageRoot, "manifest.json"));
    assertValidNarrationManifest(manifest);
    manifests[language] = manifest;
    if (
      manifest.language !== language ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== page.sectionOrder.length ||
      "provider" in manifest ||
      "model" in manifest ||
      "voice" in manifest ||
      "instructions" in manifest
    ) {
      throw new Error(`Reviewed ${language} narration manifest is invalid.`);
    }
    const expectedFiles = ["manifest.json"];
    let rollingSeconds = 0;
    for (const [index, section] of page.sectionOrder.entries()) {
      const filename = `${String(index + 1).padStart(2, "0")}-${section}.mp3`;
      const entry = manifest.files[index];
      const expectedUrl = `../_assets/${page.buildId}/audio/narration/${language}/${filename}`;
      if (
        entry?.index !== index + 1 ||
        entry?.section !== section ||
        entry?.file !== expectedUrl ||
        typeof entry?.time !== "string" ||
        !Number.isFinite(entry?.seconds)
      ) {
        throw new Error(`Reviewed ${language} narration manifest segment is invalid.`);
      }
      if (
        entry.seconds !== rollingSeconds ||
        entry.time !== formatSecondsMmss(rollingSeconds)
      ) {
        throw new Error(
          `Narration manifest timing does not match decoded audio duration for ${language} segment ${index + 1}.`,
        );
      }
      const duration = await probeDurationSeconds(path.join(languageRoot, filename));
      if (!duration) {
        throw new Error(`Narration audio is not decodable: ${language}/${filename}`);
      }
      rollingSeconds += duration;
      expectedFiles.push(filename);
    }
    if (!isDeepStrictEqual((await readdir(languageRoot)).sort(), expectedFiles.sort())) {
      throw new Error(`Reviewed ${language} narration files contain unexpected inventory.`);
    }
    if (!Array.isArray(transcript.tracks[language]) || transcript.tracks[language].length !== page.sectionOrder.length) {
      throw new Error(`Reviewed ${language} narration transcript is incomplete.`);
    }
  }
  for (const language of languages) {
    const track = transcript.tracks[language];
    const manifest = manifests[language];
    for (const [index, section] of page.sectionOrder.entries()) {
      const transcriptEntry = track[index];
      const manifestEntry = manifest.files[index];
      if (
        transcriptEntry.section !== section ||
        transcriptEntry.text !== sectionNarrationText(page.sections[section], language) ||
        transcriptEntry.time !== manifestEntry.time ||
        transcriptEntry.seconds !== manifestEntry.seconds
      ) {
        throw new Error(`Narration transcript does not match its media manifest for ${language}.`);
      }
    }
  }
}

async function computeNarratedProjectionDigest(page, reviewedArtifactsRoot) {
  await assertNoSymbolicLinks(reviewedArtifactsRoot);
  const entries = await readdir(reviewedArtifactsRoot);
  if (
    entries.length !== 2 ||
    !entries.includes("audio") ||
    !entries.includes("transcript.json")
  ) {
    throw new Error("Reviewed narration artifacts contain unexpected inventory.");
  }

  const projectionRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-narrated-projection-"));
  try {
    const { renderPaths } = await writeProjectionArtifacts(page, projectionRoot, {
      privateReview: false,
      includeCanonicalArtifacts: false,
    });
    await cp(path.join(reviewedArtifactsRoot, "audio"), renderPaths.audioRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await copyFile(path.join(reviewedArtifactsRoot, "transcript.json"), renderPaths.transcriptPath);
    return await digestArtifactDirectory(renderPaths.deployRoot);
  } finally {
    await rm(projectionRoot, { recursive: true, force: true });
  }
}

async function assertAuthenticatedNarrationApproval(job, deployRoot, sourcePage) {
  const outputRoot = path.dirname(deployRoot);
  const approvalPath = path.join(outputRoot, "narration-approval.json");
  await assertNoExistingSymbolicLinkComponents(approvalPath);
  await assertNoSymbolicLinks(approvalPath);
  const approvalRaw = await readFile(approvalPath, "utf8");
  const approval = JSON.parse(approvalRaw);
  assertValidNarrationApproval(approval);
  assertValidApprovalSignature(approval);

  const recordedApprovalPath = resolveReviewArtifact(
    outputRoot,
    approval?.artifacts?.narrationApproval,
    "narration approval",
  );
  const reviewPath = resolveReviewArtifact(
    outputRoot,
    approval?.artifacts?.narrationReview,
    "narration review",
  );
  if (recordedApprovalPath !== approvalPath) {
    throw new Error("Narration approval is not bound to its recorded artifact.");
  }
  await assertNoSymbolicLinks(path.dirname(reviewPath));
  const reviewRaw = await readFile(reviewPath, "utf8");
  const review = JSON.parse(reviewRaw);
  assertValidNarrationReview(review);
  const reviewRoot = path.dirname(reviewPath);
  const reviewedArtifactsRoot = resolveReviewArtifact(
    reviewRoot,
    review?.artifacts?.root,
    "reviewed narration artifacts",
  );
  await assertNarrationArtifactInventory(sourcePage, reviewedArtifactsRoot, review.languages);

  const digestFields = [
    approval.contentApprovalDigest,
    approval.basePreparedBundleDigest,
    approval.narrationReviewDigest,
    approval.mediaDigest,
    approval.preparedBundleDigest,
  ];
  if (
    approval.schemaVersion !== "1.0" ||
    approval.state !== "approved" ||
    digestFields.some((value) => !/^[a-f0-9]{64}$/.test(value || "")) ||
    approval.pageId !== sourcePage.pageId ||
    approval.revision !== sourcePage.pageRevision ||
    approval.buildId !== sourcePage.buildId ||
    approval.contentApprovalDigest !== job.approval.approvalDigest ||
    approval.basePreparedBundleDigest !== job.approval.preparedBundleDigest ||
    approval.narrationReviewDigest !== sha256(reviewRaw) ||
    review.contentApprovalDigest !== approval.contentApprovalDigest ||
    review.preparedBundleDigest !== approval.basePreparedBundleDigest ||
    review.mediaDigest !== approval.mediaDigest ||
    await digestArtifactDirectory(reviewedArtifactsRoot) !== approval.mediaDigest ||
    !isDeepStrictEqual(
      [...approval.acknowledgedLanguages].sort(),
      [...new Set(review.languages)].sort(),
    )
  ) {
    throw new Error("Narration approval does not match its reviewed media or content approval.");
  }

  const jobBinding = job.narrationApproval;
  if (
    jobBinding.approvalDigest !== sha256(approvalRaw) ||
    jobBinding.contentApprovalDigest !== approval.contentApprovalDigest ||
    jobBinding.narrationReviewDigest !== approval.narrationReviewDigest ||
    jobBinding.mediaDigest !== approval.mediaDigest ||
    jobBinding.preparedBundleDigest !== approval.preparedBundleDigest ||
    jobBinding.reviewer !== approval.reviewer ||
    jobBinding.reviewedAt !== approval.reviewedAt
  ) {
    throw new Error("Prepared job narration binding does not match its approval artifact.");
  }

  const expectedDigest = await computeNarratedProjectionDigest(sourcePage, reviewedArtifactsRoot);
  if (
    approval.preparedBundleDigest !== expectedDigest ||
    await digestArtifactDirectory(deployRoot) !== expectedDigest
  ) {
    throw new Error("The narrated deploy bundle does not match its authenticated media approval.");
  }
}

async function assertApprovedPreparedRevision(job, deployRoot) {
  if (job.review?.status !== "approved") {
    throw new Error("Deploy requires an approved page revision.");
  }

  const currentPagePath = job.paths?.currentPage;
  if (!currentPagePath || !(await exists(currentPagePath))) {
    throw new Error("Deploy requires the canonical prepared page artifact.");
  }

  if (
    !job.approval ||
    !/^[a-f0-9]{64}$/.test(job.approval.approvalDigest || "") ||
    !/^[a-f0-9]{64}$/.test(job.approval.approvedPageDigest || "") ||
    !/^[a-f0-9]{64}$/.test(job.approval.preparedBundleDigest || "")
  ) {
    throw new Error("Deploy requires the prepared revision's approval binding.");
  }

  const currentPageRaw = await readFile(currentPagePath, "utf8");
  const page = JSON.parse(currentPageRaw);
  assertValidPage(page);
  if (page.review?.status !== "approved" || page.pageRevision !== job.currentPreparedRevision) {
    throw new Error("Deploy requires an approved page revision matching the prepared job revision.");
  }

  if (typeof page.buildId !== "string" || page.buildId.length === 0) {
    throw new Error("Deploy requires a prepared page build identifier.");
  }
  if (
    sha256(currentPageRaw) !== job.approval.approvedPageDigest ||
    page.review.reviewedBy !== job.approval.reviewer ||
    page.review.reviewedAt !== job.approval.reviewedAt
  ) {
    throw new Error("Prepared page does not match its approval binding.");
  }

  const publicPagePath = path.join(deployRoot, page.slug, "page.json");
  if (!(await exists(publicPagePath))) {
    throw new Error("Deploy requires the prepared public page artifact.");
  }
  const publicPage = await readJson(publicPagePath);
  if (!isDeepStrictEqual(publicPage, buildPublicPage(page))) {
    throw new Error("The public deploy bundle does not match the approved prepared page.");
  }
  const sourcePagePath = job.paths?.sourcePage;
  if (!sourcePagePath || !(await exists(sourcePagePath))) {
    throw new Error("Deploy requires the original approved page artifact.");
  }
  const sourcePageRaw = await readFile(sourcePagePath, "utf8");
  const sourcePage = JSON.parse(sourcePageRaw);
  assertValidPage(sourcePage);
  const recordedApproval = await verifyApprovalArtifact(
    path.join(path.dirname(sourcePagePath), "approval.json"),
    sourcePagePath,
    sourcePageRaw,
    sourcePage,
  );
  const approvalBindingFields = [
    "approvalDigest",
    "approvedPageDigest",
    "dossierDigest",
    "materialDigest",
    "reviewer",
    "reviewedAt",
  ];
  if (
    sourcePageRaw !== currentPageRaw ||
    approvalBindingFields.some((field) => recordedApproval[field] !== job.approval[field])
  ) {
    throw new Error("The approval artifact or job approval binding changed after render.");
  }
  const expectedPreparedBundleDigest = await computePreparedProjectionDigest(sourcePage);
  if (
    recordedApproval.preparedBundleDigest !== expectedPreparedBundleDigest ||
    job.approval.preparedBundleDigest !== expectedPreparedBundleDigest
  ) {
    throw new Error("The prepared deploy bundle does not match its approval binding.");
  }
  if (job.narrationApproval) {
    await assertAuthenticatedNarrationApproval(job, deployRoot, sourcePage);
  } else if (await digestArtifactDirectory(deployRoot) !== expectedPreparedBundleDigest) {
    throw new Error("The prepared deploy bundle does not match its approval binding.");
  }
}

async function loadOrCreateJob(page, inputPath, renderPaths) {
  if (await exists(renderPaths.jobPath)) {
    return readJson(renderPaths.jobPath);
  }
  return buildJobFromPage(page, inputPath, renderPaths);
}

async function generateNarrationForLanguage({ apiKey, language, page, renderPaths, force }) {
  const audioDir = path.join(renderPaths.audioRoot, "narration", language);
  await ensureDir(audioDir);
  const track = page.sectionOrder.map((sectionId, index) => ({
    index: index + 1,
    section: sectionId,
    text: sectionNarrationText(page.sections[sectionId], language),
  }));

  const manifest = {
    language,
    generatedAt: nowIso(),
    files: [],
  };

  let rolling = 0;
  for (const segment of track) {
    const filename = `${String(segment.index).padStart(2, "0")}-${segment.section}.mp3`;
    const outPath = path.join(audioDir, filename);
    if (!force && (await exists(outPath))) {
      const seconds = await probeDurationSeconds(outPath);
      if (!seconds) throw new Error(`Existing narration audio is not decodable: ${filename}`);
      manifest.files.push({
        index: segment.index,
        section: segment.section,
        time: formatSecondsMmss(rolling),
        seconds: rolling,
        file: `../_assets/${renderPaths.buildId}/audio/narration/${language}/${filename}`,
      });
      rolling += seconds;
      continue;
    }

    const audioBytes = await requestSpeech({
      apiKey,
      model: page.audioPlan.model,
      voice: page.audioPlan.voiceByLanguage[language],
      input: segment.text,
      instructions: page.audioPlan.instructionsByLanguage[language],
    });
    await writeFile(outPath, audioBytes);
    const seconds = await probeDurationSeconds(outPath);
    if (!seconds) {
      await rm(outPath, { force: true });
      throw new Error(`Generated narration audio is not decodable: ${filename}`);
    }
    manifest.files.push({
      index: segment.index,
      section: segment.section,
      time: formatSecondsMmss(rolling),
      seconds: rolling,
      file: `../_assets/${renderPaths.buildId}/audio/narration/${language}/${filename}`,
    });
    rolling += seconds;
  }

  const manifestPath = path.join(audioDir, "manifest.json");
  assertValidNarrationManifest(manifest);
  await writeJson(manifestPath, manifest);
  return manifest;
}

async function requestSpeech({ apiKey, model, voice, input, instructions }) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: "mp3",
      instructions,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TTS request failed (${response.status}): ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function rebuildTranscriptTimes(page, renderPaths, transcript) {
  const next = cloneJson(transcript);

  for (const language of page.languages) {
    const manifestPath = path.join(renderPaths.audioRoot, "narration", language, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readJson(manifestPath);
    next.tracks[language] = next.tracks[language].map((entry, index) => {
      const fileEntry = manifest.files[index];
      if (!fileEntry) return entry;
      return {
        ...entry,
        time: fileEntry.time,
        seconds: fileEntry.seconds,
      };
    });
  }

  return next;
}

async function probeDurationSeconds(filePath) {
  const ffprobe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], { encoding: "utf8" });

  if (ffprobe.status === 0) {
    const value = Number.parseFloat(ffprobe.stdout.trim());
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function assertFfprobeAvailable() {
  const result = spawnSync("ffprobe", ["-version"], { stdio: "ignore" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "ffprobe is required for narration media validation; install FFmpeg and confirm `ffprobe -version` succeeds.",
    );
  }
}

function narrationFailureCode(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/not decodable/i.test(message)) return "media_not_decodable";
  if (/^TTS request failed/i.test(message)) return "provider_request_failed";
  return "generation_failed";
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function findUrlInLines(lines, prefix) {
  for (const line of lines) {
    if (!line.includes(prefix)) continue;
    const match = line.match(/https:\/\/\S+/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function findFirstUrl(lines) {
  for (const line of lines) {
    const match = line.match(/https:\/\/\S+/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

async function ensureVercelProjectLink() {
  if (await exists(VERCEL_PROJECT_LINK_PATH)) return;

  const orgId = process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!orgId || !projectId) return;

  await ensureDir(path.dirname(VERCEL_PROJECT_LINK_PATH));
  await writeJson(VERCEL_PROJECT_LINK_PATH, { orgId, projectId });
}
