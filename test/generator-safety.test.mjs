import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandCompose,
  computePreparedProjectionDigest,
  commandDeploy,
  commandRender,
  commandSend,
  commandTts,
} from "../scripts/lib/commands.mjs";
import { buildIdFromPage } from "../scripts/lib/common.mjs";
import { assertValidPage } from "../scripts/lib/validators.mjs";

const fixturePage = JSON.parse(
  await readFile(new URL("../data/examples/bayane/page.json", import.meta.url), "utf8"),
);
const fixtureIntake = JSON.parse(
  await readFile(new URL("../data/examples/bayane/intake.json", import.meta.url), "utf8"),
);
const fixtureJobs = await Promise.all(
  ["amal", "bayane", "noor"].map(async (name) => JSON.parse(
    await readFile(new URL(`../data/examples/${name}/job.json`, import.meta.url), "utf8"),
  )),
);
const TEST_APPROVAL_KEY = "synthetic-fixture-approval-key-material-not-for-production";
process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = TEST_APPROVAL_KEY;

function cloneFixturePage() {
  return structuredClone(fixturePage);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signApproval(approval) {
  const { signature: _signature, ...unsignedApproval } = approval;
  return createHmac("sha256", TEST_APPROVAL_KEY)
    .update(JSON.stringify(unsignedApproval))
    .digest("hex");
}

async function digestArtifactDirectory(directory) {
  const files = [];
  async function collect(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) await collect(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await collect(directory);
  const digest = createHash("sha256");
  for (const filePath of files) {
    digest.update(path.relative(directory, filePath).split(path.sep).join("/"));
    digest.update("\0");
    digest.update(sha256(await readFile(filePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function jobApprovalBinding(page, pageRaw) {
  return {
    approvalDigest: "a".repeat(64),
    approvedPageDigest: sha256(pageRaw),
    preparedBundleDigest: "d".repeat(64),
    dossierDigest: "b".repeat(64),
    materialDigest: "c".repeat(64),
    reviewer: page.review.reviewedBy,
    reviewedAt: page.review.reviewedAt,
  };
}

async function writeApprovedFixture(pagePath, page) {
  const approvedPage = structuredClone(page);
  approvedPage.buildId ||= buildIdFromPage(approvedPage);
  const pageRaw = `${JSON.stringify(approvedPage, null, 2)}\n`;
  const approvalPath = path.join(path.dirname(pagePath), "approval.json");
  const approval = {
    schemaVersion: "1.0",
    state: "approved",
    reviewer: approvedPage.review.reviewedBy,
    reviewedAt: approvedPage.review.reviewedAt,
    pageId: approvedPage.pageId,
    revision: approvedPage.pageRevision,
    buildId: approvedPage.buildId,
    materialDigest: "c".repeat(64),
    dossierDigest: "b".repeat(64),
    approvedPageDigest: sha256(pageRaw),
    preparedBundleDigest: await computePreparedProjectionDigest(approvedPage),
    signatureAlgorithm: "hmac-sha256",
    acknowledgedReasons: [],
    demandsDisposition: null,
    artifacts: {
      approvedPage: path.basename(pagePath),
      approval: path.basename(approvalPath),
    },
  };
  approval.signature = signApproval(approval);
  await writeFile(pagePath, pageRaw, "utf8");
  await writeFile(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  return approvalPath;
}

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

async function createTempDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("page validation rejects a path-bearing slug", () => {
  const page = cloneFixturePage();
  page.slug = "../../outside";

  assert.throws(() => assertValidPage(page), /slug must contain only lowercase letters, digits, and hyphens/);
});

test("page validation rejects a path-bearing revision", () => {
  const page = cloneFixturePage();
  page.pageRevision = "../../outside";

  assert.throws(() => assertValidPage(page), /pageRevision must match r<number>/);
});

test("page validation rejects unexpected section language keys", () => {
  const page = cloneFixturePage();
  page.sections.intro['fr" onmouseover="alert(1)'] = structuredClone(page.sections.intro.fr);

  assert.throws(() => assertValidPage(page), /Unsupported language key in sections.intro/);
});

test("compose preserves the customer email in private provenance", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-compose-test-");
  const intakePath = path.join(directory, "intake.json");
  const pagePath = path.join(directory, "page.json");
  await writeFile(intakePath, `${JSON.stringify(fixtureIntake, null, 2)}\n`, "utf8");

  await captureConsole(() => commandCompose({
    input: intakePath,
    output: pagePath,
    select: "religious-bayane",
  }));

  const page = JSON.parse(await readFile(pagePath, "utf8"));
  assert.equal(page.provenance.customerEmail, fixtureIntake.customer.email);
});

test("render separates private canonical artifacts from the public page", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-render-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const page = cloneFixturePage();
  page.featureFlags = ["private-preview-flag"];
  page.provenance.customerEmail = "family@example.com";
  const approvalPath = await writeApprovedFixture(pagePath, page);

  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));

  const publicPage = JSON.parse(await readFile(path.join(outputRoot, "deploy", "bayane", "page.json"), "utf8"));
  const canonicalPage = JSON.parse(await readFile(path.join(outputRoot, "artifacts", "current", "page.json"), "utf8"));
  const job = JSON.parse(await readFile(path.join(outputRoot, "job.json"), "utf8"));

  assert.equal(publicPage.provenance, undefined);
  assert.equal(publicPage.review, undefined);
  assert.equal(publicPage.featureFlags, undefined);
  assert.equal(publicPage.audioPlan, undefined);
  assert.equal(canonicalPage.provenance.customerEmail, "family@example.com");
  assert.equal(canonicalPage.review.status, "approved");
  assert.equal(job.customer.email, "family@example.com");
  assert.equal(job.currentPreparedRevision, "r1");
  assert.equal(job.currentLiveRevision, null);
});

test("deployable narration manifests omit provider metadata", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-public-audio-metadata-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([0]).buffer,
  });
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  await captureConsole(() => commandTts({ input: pagePath, output: outputRoot, lang: "fr" }));
  const manifest = JSON.parse(await readFile(path.join(
    outputRoot,
    "deploy",
    "bayane",
    "_assets",
    buildIdFromPage(cloneFixturePage()),
    "audio",
    "narration",
    "fr",
    "manifest.json",
  ), "utf8"));

  assert.equal(manifest.provider, undefined);
  assert.equal(manifest.model, undefined);
  assert.equal(manifest.voice, undefined);
  assert.ok(Array.isArray(manifest.files));
});

test("deploy refuses a rendered draft even in dry-run mode", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-draft-deploy-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const page = cloneFixturePage();
  page.review = { status: "draft", reviewedBy: null, reviewedAt: null };
  await writeFile(pagePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");
  await captureConsole(() => commandRender({ input: pagePath, output: outputRoot, "allow-draft": true }));

  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /approved page revision/,
  );
});

test("deploy refuses a root that is not the job's prepared deploy bundle", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-root-test-");
  const expectedOutputRoot = path.join(directory, "prepared-output");
  const expectedDeployRoot = path.join(expectedOutputRoot, "deploy");
  const unrelatedOutputRoot = path.join(directory, "unrelated-output");
  await Promise.all([
    mkdir(expectedDeployRoot, { recursive: true }),
    mkdir(path.join(unrelatedOutputRoot, "deploy"), { recursive: true }),
  ]);
  const jobPath = path.join(directory, "job.json");
  const job = {
    ...fixtureJobs[1],
    currentPreparedRevision: "r1",
    currentLiveRevision: null,
    review: { status: "approved", reviewedBy: "operator", reviewedAt: "2026-08-02T00:00:00Z" },
    paths: {
      ...fixtureJobs[1].paths,
      currentPage: path.join(directory, "missing-current-page.json"),
      deployRoot: expectedDeployRoot,
    },
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandDeploy({ input: unrelatedOutputRoot, job: jobPath, "dry-run": true }),
    /must match the deploy root recorded in the job/,
  );
});

test("deploy refuses a missing canonical prepared page", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-page-test-");
  const outputRoot = path.join(directory, "output");
  const deployRoot = path.join(outputRoot, "deploy");
  await mkdir(deployRoot, { recursive: true });
  const jobPath = path.join(directory, "job.json");
  const job = {
    ...fixtureJobs[1],
    currentPreparedRevision: "r1",
    currentLiveRevision: null,
    review: { status: "approved", reviewedBy: "operator", reviewedAt: "2026-08-02T00:00:00Z" },
    paths: {
      ...fixtureJobs[1].paths,
      currentPage: path.join(directory, "missing-current-page.json"),
      deployRoot,
    },
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandDeploy({ input: outputRoot, job: jobPath, "dry-run": true }),
    /canonical prepared page artifact/,
  );
});

test("deploy refuses a public bundle that differs from the prepared page", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-bundle-test-");
  const outputRoot = path.join(directory, "output");
  const deployRoot = path.join(outputRoot, "deploy");
  const canonicalPagePath = path.join(outputRoot, "artifacts", "current", "page.json");
  const publicPagePath = path.join(deployRoot, "bayane", "page.json");
  await Promise.all([
    mkdir(path.dirname(canonicalPagePath), { recursive: true }),
    mkdir(path.dirname(publicPagePath), { recursive: true }),
  ]);

  const canonicalPage = cloneFixturePage();
  canonicalPage.buildId = buildIdFromPage(canonicalPage);
  const canonicalPageRaw = `${JSON.stringify(canonicalPage, null, 2)}\n`;
  const publicPage = structuredClone(canonicalPage);
  delete publicPage.provenance;
  delete publicPage.review;
  delete publicPage.featureFlags;
  publicPage.pageRevision = "r2";
  await Promise.all([
    writeFile(canonicalPagePath, canonicalPageRaw, "utf8"),
    writeFile(publicPagePath, `${JSON.stringify(publicPage, null, 2)}\n`, "utf8"),
  ]);

  const jobPath = path.join(outputRoot, "job.json");
  const job = {
    ...fixtureJobs[1],
    currentPreparedRevision: "r1",
    currentLiveRevision: null,
    review: canonicalPage.review,
    approval: jobApprovalBinding(canonicalPage, canonicalPageRaw),
    paths: {
      ...fixtureJobs[1].paths,
      currentPage: canonicalPagePath,
      deployRoot,
    },
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandDeploy({ input: outputRoot, job: jobPath, "dry-run": true }),
    /public deploy bundle does not match/,
  );
});

test("deploy and send dry-runs reject a prepared runtime asset changed after render", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-prepared-asset-tamper-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));

  const runtimePath = path.join(
    outputRoot,
    "deploy",
    "bayane",
    "_assets",
    buildIdFromPage(cloneFixturePage()),
    "app.js",
  );
  await appendFile(runtimePath, "\n// adversarial post-render mutation\n", "utf8");

  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /prepared deploy bundle does not match its approval binding/,
  );
  await assert.rejects(
    commandSend({
      job: path.join(outputRoot, "job.json"),
      provider: "console",
      "dry-run": true,
    }),
    /prepared deploy bundle does not match its approval binding/,
  );

  const jobPath = path.join(outputRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.approval.preparedBundleDigest = await digestArtifactDirectory(path.join(outputRoot, "deploy"));
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /prepared deploy bundle does not match its approval binding/,
  );
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console", "dry-run": true }),
    /prepared deploy bundle does not match its approval binding/,
  );

  const approvalPathAfterRender = path.join(path.dirname(pagePath), "approval.json");
  const approval = JSON.parse(await readFile(approvalPathAfterRender, "utf8"));
  approval.preparedBundleDigest = job.approval.preparedBundleDigest;
  approval.signature = signApproval(approval);
  const approvalRaw = `${JSON.stringify(approval, null, 2)}\n`;
  await writeFile(approvalPathAfterRender, approvalRaw, "utf8");
  job.approval.approvalDigest = sha256(approvalRaw);
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /prepared deploy bundle does not match its approval binding/,
  );
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console", "dry-run": true }),
    /prepared deploy bundle does not match its approval binding/,
  );
});

test("deploy rejects post-render approval artifact and job binding mutations", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-prepared-approval-tamper-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));

  const approvalRaw = await readFile(approvalPath, "utf8");
  await writeFile(approvalPath, `${approvalRaw}\n`, "utf8");
  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /approval artifact or job approval binding changed after render/,
  );
  await assert.rejects(
    commandSend({ job: path.join(outputRoot, "job.json"), provider: "console", "dry-run": true }),
    /approval artifact or job approval binding changed after render/,
  );

  await writeFile(approvalPath, approvalRaw, "utf8");
  const jobPath = path.join(outputRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.approval.approvalDigest = "e".repeat(64);
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await assert.rejects(
    commandDeploy({ input: outputRoot, "dry-run": true }),
    /approval artifact or job approval binding changed after render/,
  );
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console", "dry-run": true }),
    /approval artifact or job approval binding changed after render/,
  );
});

test("deploy and send reject a coordinated forged reviewer rewrite", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-forged-reviewer-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));

  const page = JSON.parse(await readFile(pagePath, "utf8"));
  page.review.reviewedBy = "forged-reviewer";
  const pageRaw = `${JSON.stringify(page, null, 2)}\n`;
  await Promise.all([
    writeFile(pagePath, pageRaw, "utf8"),
    writeFile(path.join(outputRoot, "artifacts", "current", "page.json"), pageRaw, "utf8"),
  ]);

  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  approval.reviewer = "forged-reviewer";
  approval.approvedPageDigest = sha256(pageRaw);
  const approvalRaw = `${JSON.stringify(approval, null, 2)}\n`;
  await writeFile(approvalPath, approvalRaw, "utf8");

  const jobPath = path.join(outputRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.review.reviewedBy = "forged-reviewer";
  job.approval.reviewer = "forged-reviewer";
  job.approval.approvedPageDigest = sha256(pageRaw);
  job.approval.approvalDigest = sha256(approvalRaw);
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(commandDeploy({ input: outputRoot, "dry-run": true }), /approval signature/);
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console", "dry-run": true }),
    /approval signature/,
  );
});

test("render fails closed when operator approval key configuration is missing", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-missing-approval-key-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  const configuredKey = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  delete process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  try {
    await assert.rejects(
      commandRender({ input: pagePath, output: outputRoot, approval: approvalPath }),
      /BEBEBONJOUR_APPROVAL_HMAC_KEY with at least 32 bytes/,
    );
    await assert.rejects(readFile(path.join(outputRoot, "job.json"), "utf8"), { code: "ENOENT" });
  } finally {
    process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY = configuredKey;
  }
});

test("deploy dry-run does not mutate an approved job", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-dry-run-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));
  const jobPath = path.join(outputRoot, "job.json");
  const before = await readFile(jobPath, "utf8");

  await captureConsole(() => commandDeploy({ input: outputRoot, "dry-run": true }));

  assert.equal(await readFile(jobPath, "utf8"), before);
});

test("console delivery is a redacted non-mutating preview", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-send-preview-test-");
  const jobPath = path.join(directory, "job.json");
  const job = {
    schemaVersion: "1.0",
    jobId: "job_test_001",
    pageId: "page_test_001",
    slug: "test-page",
    status: "deployed",
    templateFamily: "blessed-arrival",
    templateVersion: "1.0.0",
    rendererVersion: "1.0.0",
    currentPreparedRevision: "r1",
    currentLiveRevision: "r1",
    customer: { email: "family@example.com" },
    review: { status: "approved" },
    deploy: { publicUrl: "https://example.com/test-page" },
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  const lines = await captureConsole(() => commandSend({ job: jobPath, provider: "console" }));

  assert.deepEqual(JSON.parse(await readFile(jobPath, "utf8")), job);
  assert.match(lines.join("\n"), /delivery_preview/);
  assert.doesNotMatch(lines.join("\n"), /family@example\.com/);
  assert.doesNotMatch(lines.join("\n"), /https:\/\/example\.com\/test-page/);
});

test("console delivery dry-run verifies an approved prepared bundle without a public URL", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-send-dry-run-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));
  const jobPath = path.join(outputRoot, "job.json");
  const before = await readFile(jobPath, "utf8");

  const lines = await captureConsole(() => commandSend({
    job: jobPath,
    provider: "console",
    "dry-run": true,
  }));
  const payload = JSON.parse(lines.join("\n"));

  assert.equal(await readFile(jobPath, "utf8"), before);
  assert.equal(payload.state, "delivery_preview");
  assert.equal(payload.deploymentReady, true);
  assert.equal(payload.publicUrlConfigured, false);
  assert.equal(payload.recipientConfigured, true);
  assert.doesNotMatch(lines.join("\n"), /family@example\.com/);
});

test("unsupported send providers do not mutate the persisted job", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-send-test-");
  const jobPath = path.join(directory, "job.json");
  const job = {
    schemaVersion: "1.0",
    jobId: "job_test_001",
    pageId: "page_test_001",
    slug: "test-page",
    status: "deployed",
    templateFamily: "blessed-arrival",
    templateVersion: "1.0.0",
    rendererVersion: "1.0.0",
    currentPreparedRevision: "r1",
    currentLiveRevision: "r1",
    customer: { email: "family@example.com" },
    review: { status: "approved" },
    deploy: { publicUrl: "https://example.com/test-page" },
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandSend({ job: jobPath, provider: "smtp" }),
    /Unsupported send provider: smtp/,
  );

  assert.deepEqual(JSON.parse(await readFile(jobPath, "utf8")), job);
});

test("build IDs preserve semantic-version boundaries", () => {
  assert.equal(
    buildIdFromPage({
      templateFamily: "blessed-arrival",
      templateVersion: "1.0.0",
      pageRevision: "r1",
    }),
    "blessed-arrival-1-0-0-r1",
  );
});

test("undeployed example jobs have a prepared revision but no live revision", () => {
  for (const job of fixtureJobs) {
    assert.equal(job.deploy, null);
    assert.equal(job.currentPreparedRevision, "r1");
    assert.equal(job.currentLiveRevision, null);
  }
});
