import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { manifest, promote } from "../../src/fulfillment/hosted-narration-transitions.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const jobId = "job_canonical_narration_handoff";
const page = Buffer.from('{"sectionOrder":["welcome"],"languages":["fr"]}');
const transcript = Buffer.from('{"tracks":{"fr":[]}}');
const html = Buffer.from("<html lang='fr'>Approved content</html>");
const file = (path, bytes) => ({ path, storageId: `stored_${hash(bytes)}`, bytes: bytes.length, sha256: hash(bytes) });
function approvedJob() {
  const job = { jobId, currentRevisionId: "r1", artifactSets: [], reviewDecisions: [] };
  const source = manifest(job, "private_review", [
    file("artifacts/current/page.json", page),
    file("artifacts/current/transcript.json", transcript),
    file("private-preview/canonical/fr/index.html", html),
  ], hash(page), hash(transcript));
  job.artifactSets.push(source);
  job.reviewDecisions.push({
    decisionType: "content", revisionId: "r1", outcome: "approved",
    artifactDigests: { pageDigest: source.pageDigest, transcriptDigest: source.transcriptDigest, assetManifestDigest: source.assetManifestDigest },
  });
  return job;
}

test("approved canonical page and transcript commitments hand off to prepared storage without changing bytes", () => {
  const job = approvedJob();
  const prepared = promote(job);
  assert.equal(prepared.kind, "prepared_bundle");
  assert.equal(prepared.pageDigest, hash(page));
  assert.equal(prepared.transcriptDigest, hash(transcript));
  assert.deepEqual(prepared.files.find((entry) => entry.path === "deploy/fr/index.html"), {
    ...job.artifactSets[0].files.find((entry) => entry.path.endsWith("index.html")),
    path: "deploy/fr/index.html",
  });
});

test("handoff rejects a source whose claimed page or transcript digest is not the stored canonical file", () => {
  for (const [path, digest] of [["artifacts/current/page.json", "pageDigest"], ["artifacts/current/transcript.json", "transcriptDigest"]]) {
    const job = approvedJob();
    const source = job.artifactSets[0];
    source.files.find((entry) => entry.path === path).sha256 = hash("different stored bytes");
    source.assetManifestDigest = manifest(job, "private_review", source.files, source.pageDigest, source.transcriptDigest).assetManifestDigest;
    job.reviewDecisions[0].artifactDigests.assetManifestDigest = source.assetManifestDigest;
    assert.throws(() => promote(job), /canonical|digest|commitment/i, digest);
  }
});

test("handoff refuses missing canonical source or conflicting approval digests", () => {
  const missing = approvedJob();
  missing.artifactSets[0].files = missing.artifactSets[0].files.filter((entry) => entry.path !== "artifacts/current/page.json");
  assert.throws(() => promote(missing), /canonical|digest|commitment/i);
  const divergent = approvedJob();
  divergent.reviewDecisions[0].artifactDigests.pageDigest = hash("other approved page");
  assert.throws(() => promote(divergent), /approval|digest/i);
});