import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
import * as narrationCommands from "../scripts/lib/commands.mjs";
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
const SYNTHETIC_MP3 = Buffer.from(
  "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYyLjEyLjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAACQAAA2AAVVVVVVVVVVVVVVVqampqampqampqaoCAgICAgICAgICAlZWVlZWVlZWVlZWqqqqqqqqqqqqqqsDAwMDAwMDAwMDA1dXV1dXV1dXV1dXq6urq6urq6urq6v//////////////AAAAAExhdmM2Mi4yOAAAAAAAAAAAAAAAACQCYAAAAAAAAANgUN+kLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  "base64",
);
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

async function stageNarrationFixture(t, prefix, language = "fr") {
  const directory = await createTempDirectory(t, prefix);
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
  });
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });
  await captureConsole(() => commandTts({
    input: pagePath,
    approval: approvalPath,
    prepared: preparedRoot,
    output: narrationReviewRoot,
    lang: language,
  }));
  return { directory, pagePath, preparedRoot, narrationReviewRoot, approvalPath };
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

test("tts stages private narration review material without mutating the prepared bundle", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-public-audio-metadata-test-");
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const narrationReviewRoot = path.join(directory, "narration-review");
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
    arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
  });
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  const preparedDigestBefore = await digestArtifactDirectory(outputRoot);
  const ttsLogs = await captureConsole(() => commandTts({
    input: pagePath,
    approval: approvalPath,
    prepared: outputRoot,
    output: narrationReviewRoot,
    lang: "fr",
  }));
  assert.equal(await digestArtifactDirectory(outputRoot), preparedDigestBefore);

  const review = JSON.parse(await readFile(path.join(narrationReviewRoot, "review.json"), "utf8"));
  assert.equal(review.state, "narration_review_required", ttsLogs.join("\n"));

  const manifest = JSON.parse(await readFile(path.join(
    narrationReviewRoot,
    "artifacts",
    "audio",
    "narration",
    "fr",
    "manifest.json",
  ), "utf8"));

  assert.equal(manifest.provider, undefined);
  assert.equal(manifest.model, undefined);
  assert.equal(manifest.voice, undefined);
  assert.ok(Array.isArray(manifest.files));
  assert.equal(review.contentApprovalDigest.length, 64);
  assert.equal(review.mediaDigest.length, 64);
  await assert.rejects(readFile(path.join(narrationReviewRoot, "deploy"), "utf8"), { code: "ENOENT" });
});

test("tts rejects duplicate languages before any provider call", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-duplicate-tts-language-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
    };
  };
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  await assert.rejects(
    commandTts({
      input: pagePath,
      approval: approvalPath,
      prepared: preparedRoot,
      output: narrationReviewRoot,
      lang: "fr,fr",
    }),
    /duplicate narration language/i,
  );
  assert.equal(providerCalls, 0);
});

test("tts requires ffprobe before any provider call", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-tts-ffprobe-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const emptyPath = path.join(directory, "empty-path");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await mkdir(emptyPath);
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalPath = process.env.PATH;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider must not be called without ffprobe.");
  };
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.PATH = emptyPath;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  await assert.rejects(
    commandTts({
      input: pagePath,
      approval: approvalPath,
      prepared: preparedRoot,
      output: narrationReviewRoot,
      lang: "fr",
    }),
    /ffprobe.*required/i,
  );
  assert.equal(providerCalls, 0);
});

test("partial narration generation records failed evidence that cannot be approved", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-partial-tts-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const finalRoot = path.join(directory, "final");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({ input: pagePath, output: preparedRoot, approval: approvalPath }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalExitCode = process.exitCode;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return {
      ok: true,
      arrayBuffer: async () => (
        providerCalls <= cloneFixturePage().sectionOrder.length
          ? Uint8Array.from(SYNTHETIC_MP3).buffer
          : new Uint8Array([0]).buffer
      ),
    };
  };
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    process.exitCode = originalExitCode;
  });

  await captureConsole(() => commandTts({
    input: pagePath,
    approval: approvalPath,
    prepared: preparedRoot,
    output: narrationReviewRoot,
    lang: "all",
  }));
  assert.equal(process.exitCode, 9);
  process.exitCode = originalExitCode;
  const review = JSON.parse(await readFile(path.join(narrationReviewRoot, "review.json"), "utf8"));
  assert.equal(review.state, "narration_generation_failed");
  assert.deepEqual(review.results, [
    { language: "ar", status: "ok", files: cloneFixturePage().sectionOrder.length },
    { language: "fr", status: "failed", error: "media_not_decodable" },
  ]);
  assert.equal(providerCalls, cloneFixturePage().sectionOrder.length + 1);

  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: path.join(narrationReviewRoot, "review.json"),
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator@example.test",
      acknowledge: "ar,fr",
    }),
    /narration review material is invalid/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval assembles a fresh signed bundle without mutating reviewed inputs", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-narration-approval-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const finalRoot = path.join(directory, "final");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
  });
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });
  await captureConsole(() => commandTts({
    input: pagePath,
    approval: approvalPath,
    prepared: preparedRoot,
    output: narrationReviewRoot,
    lang: "fr",
  }));

  const preparedDigestBefore = await digestArtifactDirectory(preparedRoot);
  const reviewDigestBefore = await digestArtifactDirectory(narrationReviewRoot);
  await captureConsole(() => narrationCommands.commandApproveNarration({
    review: path.join(narrationReviewRoot, "review.json"),
    prepared: preparedRoot,
    output: finalRoot,
    reviewer: "operator@example.test",
    acknowledge: "fr",
  }));

  assert.equal(await digestArtifactDirectory(preparedRoot), preparedDigestBefore);
  assert.equal(await digestArtifactDirectory(narrationReviewRoot), reviewDigestBefore);
  const narrationApprovalRaw = await readFile(path.join(finalRoot, "narration-approval.json"), "utf8");
  const narrationApproval = JSON.parse(narrationApprovalRaw);
  assert.equal(narrationApproval.state, "approved");
  assert.equal(narrationApproval.reviewer, "operator@example.test");
  assert.deepEqual(narrationApproval.acknowledgedLanguages, ["fr"]);
  assert.match(narrationApproval.signature, /^[a-f0-9]{64}$/);
  const job = JSON.parse(await readFile(path.join(finalRoot, "job.json"), "utf8"));
  assert.equal(job.narrationApproval.approvalDigest, sha256(narrationApprovalRaw));
  await readFile(path.join(
    finalRoot,
    "deploy",
    "bayane",
    "_assets",
    buildIdFromPage(cloneFixturePage()),
    "audio",
    "narration",
    "fr",
    "01-intro.mp3",
  ));
});

test("deploy verifies the signed narrated bundle and rejects changed audio", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-narrated-deploy-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const narrationReviewRoot = path.join(directory, "narration-review");
  const finalRoot = path.join(directory, "final");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.from(SYNTHETIC_MP3).buffer,
  });
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });
  await captureConsole(() => commandTts({
    input: pagePath,
    approval: approvalPath,
    prepared: preparedRoot,
    output: narrationReviewRoot,
    lang: "fr",
  }));
  await captureConsole(() => narrationCommands.commandApproveNarration({
    review: path.join(narrationReviewRoot, "review.json"),
    prepared: preparedRoot,
    output: finalRoot,
    reviewer: "operator@example.test",
    acknowledge: "fr",
  }));

  const finalDigestBefore = await digestArtifactDirectory(finalRoot);
  await captureConsole(() => commandDeploy({ input: finalRoot, "dry-run": true }));
  await captureConsole(() => commandSend({
    job: path.join(finalRoot, "job.json"),
    provider: "console",
    "dry-run": true,
  }));
  assert.equal(await digestArtifactDirectory(finalRoot), finalDigestBefore);

  const audioPath = path.join(
    finalRoot,
    "deploy",
    "bayane",
    "_assets",
    buildIdFromPage(cloneFixturePage()),
    "audio",
    "narration",
    "fr",
    "01-intro.mp3",
  );
  await appendFile(audioPath, "changed");
  await assert.rejects(
    commandDeploy({ input: finalRoot, "dry-run": true }),
    /narrat|prepared deploy bundle/i,
  );
  await assert.rejects(
    commandSend({
      job: path.join(finalRoot, "job.json"),
      provider: "console",
      "dry-run": true,
    }),
    /narrat|prepared deploy bundle/i,
  );
});

test("deploy rejects a schema-invalid manifest despite coordinated valid-HMAC rebinding", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narrated-deploy-schema-test-");
  const finalRoot = path.join(directory, "final");
  await captureConsole(() => narrationCommands.commandApproveNarration({
    review: path.join(narrationReviewRoot, "review.json"),
    prepared: preparedRoot,
    output: finalRoot,
    reviewer: "operator@example.test",
    acknowledge: "fr",
  }));

  const buildId = buildIdFromPage(cloneFixturePage());
  const privateManifestPath = path.join(
    finalRoot,
    "narration-review",
    "artifacts",
    "audio",
    "narration",
    "fr",
    "manifest.json",
  );
  const publicManifestPath = path.join(
    finalRoot,
    "deploy",
    "bayane",
    "_assets",
    buildId,
    "audio",
    "narration",
    "fr",
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(privateManifestPath, "utf8"));
  manifest.rawProviderResponse = { requestId: "must-not-deploy" };
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(privateManifestPath, manifestRaw, "utf8");
  await writeFile(publicManifestPath, manifestRaw, "utf8");

  const reviewedArtifactsRoot = path.join(finalRoot, "narration-review", "artifacts");
  const reviewPath = path.join(finalRoot, "narration-review", "review.json");
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(reviewedArtifactsRoot);
  const reviewRaw = `${JSON.stringify(review, null, 2)}\n`;
  await writeFile(reviewPath, reviewRaw, "utf8");

  const approvalPath = path.join(finalRoot, "narration-approval.json");
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  approval.narrationReviewDigest = sha256(reviewRaw);
  approval.mediaDigest = review.mediaDigest;
  approval.preparedBundleDigest = await digestArtifactDirectory(path.join(finalRoot, "deploy"));
  approval.signature = signApproval(approval);
  const approvalRaw = `${JSON.stringify(approval, null, 2)}\n`;
  await writeFile(approvalPath, approvalRaw, "utf8");

  const jobPath = path.join(finalRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.narrationApproval.approvalDigest = sha256(approvalRaw);
  job.narrationApproval.narrationReviewDigest = approval.narrationReviewDigest;
  job.narrationApproval.mediaDigest = approval.mediaDigest;
  job.narrationApproval.preparedBundleDigest = approval.preparedBundleDigest;
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandDeploy({ input: finalRoot, "dry-run": true }),
    /invalid narration manifest/i,
  );
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console", "dry-run": true }),
    /invalid narration manifest/i,
  );
});

test("deploy and send reject narration approval signature tampering without mutation", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-signature-test-");
  const finalRoot = path.join(directory, "final");
  await captureConsole(() => narrationCommands.commandApproveNarration({
    review: path.join(narrationReviewRoot, "review.json"),
    prepared: preparedRoot,
    output: finalRoot,
    reviewer: "operator@example.test",
    acknowledge: "fr",
  }));

  const approvalPath = path.join(finalRoot, "narration-approval.json");
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  approval.reviewer = "forged-reviewer@example.test";
  await writeFile(approvalPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
  const jobPath = path.join(finalRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.deploy = {
    provider: "vercel",
    deployedAt: "2026-08-04T12:00:00.000Z",
    deployRoot: path.join(finalRoot, "deploy"),
    publicUrl: "https://example.test/bayane",
    rawOutput: [],
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  const tamperedDigest = await digestArtifactDirectory(finalRoot);

  await assert.rejects(
    commandDeploy({ input: finalRoot, "dry-run": true }),
    /approval signature/i,
  );
  await assert.rejects(
    commandSend({
      job: path.join(finalRoot, "job.json"),
      provider: "console",
      "dry-run": true,
    }),
    /approval signature/i,
  );
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console" }),
    /approval signature/i,
  );
  assert.equal(await digestArtifactDirectory(finalRoot), tamperedDigest);
});

test("narration approval rejects unmanaged media even when the unsigned review digest is rebound", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } = await stageNarrationFixture(
    t,
    "bebebonjour-narration-inventory-test-",
  );
  const artifactsRoot = path.join(narrationReviewRoot, "artifacts");
  await writeFile(path.join(artifactsRoot, "unexpected.bin"), "unreviewable");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(artifactsRoot);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  const finalRoot = path.join(directory, "final");

  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator@example.test",
      acknowledge: "fr",
    }),
    /unexpected inventory/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects unmanaged files beside the private review evidence", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-review-inventory-test-");
  await writeFile(
    path.join(narrationReviewRoot, "raw-provider-response.json"),
    '{"unexpected":true}\n',
    "utf8",
  );

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: path.join(narrationReviewRoot, "review.json"),
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /review root.*unexpected entr/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects schema-invalid manifest metadata after digest rebound", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-manifest-schema-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const manifestPath = path.join(narrationReviewRoot, "artifacts", "audio", "narration", "fr", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.rawProviderResponse = { requestId: "must-not-survive" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(path.join(narrationReviewRoot, "artifacts"));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /invalid narration manifest/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects undeclared transcript metadata after digest rebound", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-transcript-schema-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const transcriptPath = path.join(narrationReviewRoot, "artifacts", "transcript.json");
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  transcript.rawProviderResponse = { requestId: "must-not-survive" };
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(path.join(narrationReviewRoot, "artifacts"));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /invalid transcript/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects schema-valid text rebound in an unselected transcript track", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-unselected-track-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const artifactsRoot = path.join(narrationReviewRoot, "artifacts");
  const transcriptPath = path.join(artifactsRoot, "transcript.json");
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  transcript.tracks.ar[0].text = "private schema-valid replacement";
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(artifactsRoot);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /transcript/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects corrupt media after digest rebound", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-corrupt-media-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const manifestPath = path.join(narrationReviewRoot, "artifacts", "audio", "narration", "fr", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const corruptAudioPath = path.join(
    narrationReviewRoot,
    "artifacts",
    "audio",
    "narration",
    "fr",
    path.basename(manifest.files[0].file),
  );
  await writeFile(corruptAudioPath, new Uint8Array([0]));

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(path.join(narrationReviewRoot, "artifacts"));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /audio is not decodable/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects output nested inside immutable review material before writing", async (t) => {
  const { preparedRoot, narrationReviewRoot } = await stageNarrationFixture(
    t,
    "bebebonjour-narration-output-alias-test-",
  );
  const reviewDigestBefore = await digestArtifactDirectory(narrationReviewRoot);
  const nestedOutput = path.join(narrationReviewRoot, "final");

  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: path.join(narrationReviewRoot, "review.json"),
      prepared: preparedRoot,
      output: nestedOutput,
      reviewer: "operator@example.test",
      acknowledge: "fr",
    }),
    /outside immutable narration inputs/i,
  );
  assert.equal(await digestArtifactDirectory(narrationReviewRoot), reviewDigestBefore);
  await assert.rejects(readFile(path.join(nestedOutput, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects transcript timing rebound away from its media manifest", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-transcript-rebind-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const transcriptPath = path.join(narrationReviewRoot, "artifacts", "transcript.json");
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  transcript.tracks.fr[0].time = "02:03";
  transcript.tracks.fr[0].seconds = 123;
  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(path.join(narrationReviewRoot, "artifacts"));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /transcript.*manifest/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
});

test("narration approval rejects coordinated manifest and transcript timing rebound", async (t) => {
  const { directory, preparedRoot, narrationReviewRoot } =
    await stageNarrationFixture(t, "bebebonjour-narration-coordinated-timing-test-");
  const reviewPath = path.join(narrationReviewRoot, "review.json");
  const artifactsRoot = path.join(narrationReviewRoot, "artifacts");
  const transcriptPath = path.join(artifactsRoot, "transcript.json");
  const manifestPath = path.join(artifactsRoot, "audio", "narration", "fr", "manifest.json");
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  transcript.tracks.fr[0].time = "02:03";
  transcript.tracks.fr[0].seconds = 123;
  manifest.files[0].time = "02:03";
  manifest.files[0].seconds = 123;
  await Promise.all([
    writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8"),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);

  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  review.mediaDigest = await digestArtifactDirectory(artifactsRoot);
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const finalRoot = path.join(directory, "prepared-narrated");
  await assert.rejects(
    narrationCommands.commandApproveNarration({
      review: reviewPath,
      prepared: preparedRoot,
      output: finalRoot,
      reviewer: "operator-test",
      acknowledge: "fr",
    }),
    /timing.*audio duration/i,
  );
  await assert.rejects(readFile(path.join(finalRoot, "job.json"), "utf8"), { code: "ENOENT" });
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

test("deploy and send reject a symlink-aliased non-narrated root after mutable job path rewrite", async (t) => {
  const directory = await createTempDirectory(t, "bebebonjour-deploy-symlink-test-");
  const pagePath = path.join(directory, "page.json");
  const preparedRoot = path.join(directory, "prepared");
  const aliasedRoot = path.join(directory, "prepared-alias");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: preparedRoot,
    approval: approvalPath,
  }));
  await symlink(preparedRoot, aliasedRoot, "dir");

  const jobPath = path.join(preparedRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.paths.deployRoot = path.join(aliasedRoot, "deploy");
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  await assert.rejects(
    commandDeploy({ input: aliasedRoot, "dry-run": true }),
    /symbolic link/i,
  );
  await assert.rejects(
    commandSend({ job: path.join(aliasedRoot, "job.json"), provider: "console", "dry-run": true }),
    /symbolic link/i,
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
  const pagePath = path.join(directory, "page.json");
  const outputRoot = path.join(directory, "out");
  const approvalPath = await writeApprovedFixture(pagePath, cloneFixturePage());
  await captureConsole(() => commandRender({
    input: pagePath,
    output: outputRoot,
    approval: approvalPath,
  }));
  const jobPath = path.join(outputRoot, "job.json");
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  job.status = "deployed";
  job.currentLiveRevision = job.currentPreparedRevision;
  job.deploy = {
    provider: "vercel",
    deployedAt: "2026-08-04T12:00:00.000Z",
    deployRoot: path.join(outputRoot, "deploy"),
    publicUrl: "https://example.com/bayane",
    rawOutput: [],
  };
  await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  const before = await readFile(jobPath, "utf8");

  const lines = await captureConsole(() => commandSend({ job: jobPath, provider: "console" }));

  assert.equal(await readFile(jobPath, "utf8"), before);
  assert.match(lines.join("\n"), /delivery_preview/);
  assert.doesNotMatch(lines.join("\n"), /family@example\.com/);
  assert.doesNotMatch(lines.join("\n"), /https:\/\/example\.com\/bayane/);

  await appendFile(path.join(outputRoot, "deploy", "bayane", "index.html"), "<!-- tampered -->", "utf8");
  await assert.rejects(
    commandSend({ job: jobPath, provider: "console" }),
    /prepared deploy bundle/i,
  );
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
