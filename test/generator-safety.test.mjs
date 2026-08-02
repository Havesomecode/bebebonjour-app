import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandCompose,
  commandDeploy,
  commandRender,
  commandSend,
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

function cloneFixturePage() {
  return structuredClone(fixturePage);
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
  await writeFile(pagePath, `${JSON.stringify(page, null, 2)}\n`, "utf8");

  await captureConsole(() => commandRender({ input: pagePath, output: outputRoot }));

  const publicPage = JSON.parse(await readFile(path.join(outputRoot, "deploy", "bayane", "page.json"), "utf8"));
  const canonicalPage = JSON.parse(await readFile(path.join(outputRoot, "artifacts", "current", "page.json"), "utf8"));
  const job = JSON.parse(await readFile(path.join(outputRoot, "job.json"), "utf8"));

  assert.equal(publicPage.provenance, undefined);
  assert.equal(publicPage.review, undefined);
  assert.equal(publicPage.featureFlags, undefined);
  assert.equal(canonicalPage.provenance.customerEmail, "family@example.com");
  assert.equal(canonicalPage.review.status, "approved");
  assert.equal(job.customer.email, "family@example.com");
  assert.equal(job.currentPreparedRevision, "r1");
  assert.equal(job.currentLiveRevision, null);
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
  const publicPage = structuredClone(canonicalPage);
  delete publicPage.provenance;
  delete publicPage.review;
  delete publicPage.featureFlags;
  publicPage.pageRevision = "r2";
  await Promise.all([
    writeFile(canonicalPagePath, `${JSON.stringify(canonicalPage, null, 2)}\n`, "utf8"),
    writeFile(publicPagePath, `${JSON.stringify(publicPage, null, 2)}\n`, "utf8"),
  ]);

  const jobPath = path.join(outputRoot, "job.json");
  const job = {
    ...fixtureJobs[1],
    currentPreparedRevision: "r1",
    currentLiveRevision: null,
    review: canonicalPage.review,
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

test("deploy dry-run does not mutate an approved job", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-dry-run-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  await writeFile(pagePath, `${JSON.stringify(cloneFixturePage(), null, 2)}\n`, "utf8");
  await captureConsole(() => commandRender({ input: pagePath, output: outputRoot }));
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
