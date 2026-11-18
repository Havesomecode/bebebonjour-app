import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  claimStageTransition,
  completeStageTransition,
  failStageTransition,
  recordReviewDecisionTransition,
  EDITORIAL_POLICY_VERSION,
} from "./job-machine.mjs";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const latest = (job, kind) =>
  [...job.artifactSets]
    .reverse()
    .find((a) => a.kind === kind && a.revisionId === job.currentRevisionId);
export function manifest(job, kind, files, pageDigest, transcriptDigest) {
  files = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    kind,
    revisionId: job.currentRevisionId,
    pageDigest,
    transcriptDigest,
    assetManifestDigest: hash(
      `${JSON.stringify({ schemaVersion: "1.0", kind, revisionId: job.currentRevisionId, files: files.map(({ path, storageId, bytes, sha256 }) => ({ path, storageId, bytes, sha256 })) }, null, 2)}\n`,
    ),
    manifestRef: `jobs/${job.jobId}/revisions/${job.currentRevisionId}/manifests/${kind}.json`,
    files,
  };
}
export function reviewTransition(job, command, at) {
  if (
    job.state !== command.expectedState ||
    job.version !== command.expectedVersion
  )
    throw new Error("Stale operator decision.");
  const decisionType = command.action.includes("narration")
    ? "narration"
    : "content";
  const outcome = command.action.startsWith("approve_")
    ? "approved"
    : command.action.startsWith("request_")
      ? "request_changes"
      : command.action.startsWith("reject_")
        ? "rejected"
        : null;
  if (!outcome) throw new Error("Not a review command.");
  const source = latest(
    job,
    decisionType === "content" ? "private_review" : "narration_review",
  );
  if (command.payload.artifactManifestDigest !== source?.assetManifestDigest)
    throw new Error("Review manifest changed.");
  return recordReviewDecisionTransition(
    job,
    {
      commandId: command.commandId,
      operationsCommandId: command.commandId,
      decisionType,
      outcome,
      revisionId: command.payload.revisionId,
      artifactDigests: command.payload.artifactDigests,
      policyVersion: EDITORIAL_POLICY_VERSION,
      rubricVersion: "ops-human-narration-v1",
      reviewer: {
        id: command.requestedBy,
        role: "operator",
        competencies: ["operator_content_review"],
      },
      decidedAt: command.requestedAt,
      reasons: command.payload.reasonCodes || [],
    },
    at,
  );
}
export function beginTransition(job, command, at, leaseToken) {
  const stage =
    command.action === "render"
      ? "render_approved"
      : command.action === "generate_narration"
        ? "generate_tts"
        : null;
  if (
    !stage ||
    job.version !== command.expectedVersion ||
    job.state !== command.expectedState
  )
    throw new Error("Stale stage request.");
  return claimStageTransition(
    job,
    {
      commandId: `claim:${command.commandId}`,
      operationsCommandId: command.commandId,
      stage,
      leaseToken,
      leaseMs: 300000,
      maxAttempts: 32,
    },
    at,
  );
}
export function promote(job) {
  const source = latest(job, "private_review");
  const decision = [...job.reviewDecisions]
    .reverse()
    .find(
      (d) =>
        d.decisionType === "content" && d.revisionId === job.currentRevisionId,
    );
  if (
    decision?.outcome !== "approved" ||
    !source ||
    !isDeepStrictEqual(decision.artifactDigests, {
      pageDigest: source.pageDigest,
      transcriptDigest: source.transcriptDigest,
      assetManifestDigest: source.assetManifestDigest,
    })
  )
    throw new Error("Exact content approval required.");
  // The approved digests must bind the canonical files handed to narration.
  for (const [path, digest] of [
    ["artifacts/current/page.json", source.pageDigest],
    ["artifacts/current/transcript.json", source.transcriptDigest],
  ]) {
    const matches = source.files.filter((file) => file.path === path);
    if (matches.length !== 1 || matches[0].sha256 !== digest)
      throw new Error("Canonical narration source commitment invalid.");
  }
  const namespace = source.files
    .find((f) => f.path.startsWith("private-preview/"))
    ?.path.split("/")[1];
  if (
    !namespace ||
    source.files
      .filter((f) => f.path.startsWith("private-preview/"))
      .some((f) => !f.path.startsWith(`private-preview/${namespace}/`))
  )
    throw new Error("Private render namespace invalid.");
  const files = source.files.map((f) => ({
    ...f,
    path: f.path.startsWith(`private-preview/${namespace}/`)
      ? `deploy/${f.path.slice(`private-preview/${namespace}/`.length)}`
      : f.path,
  }));
  if (!files.some((f) => /^deploy\/(?:[a-z]{2}\/)?index\.html$/.test(f.path)))
    throw new Error("Approved HTML render missing.");
  return manifest(
    job,
    "prepared_bundle",
    files,
    source.pageDigest,
    source.transcriptDigest,
  );
}
export function completeTransition(job, command, artifactSet, at) {
  const attempt = job.stageAttempts.at(-1);
  if (attempt?.operationsCommandId !== command.commandId)
    throw new Error("Stage command changed.");
  return completeStageTransition(
    job,
    {
      commandId: `complete:${attempt.attemptId}`,
      stage: attempt.stage,
      leaseToken: attempt.leaseToken,
      result: { artifactSet },
    },
    at,
  );
}
export function failTransition(job, command, at) {
  const attempt = job.stageAttempts.at(-1);
  if (attempt?.operationsCommandId !== command.commandId)
    throw new Error("Stage command changed.");
  return failStageTransition(
    job,
    {
      commandId: `fail:${attempt.attemptId}:narration_failed`,
      stage: attempt.stage,
      leaseToken: attempt.leaseToken,
      retryable: false,
      reasonCode: "narration_failed",
    },
    { maxAttemptsByStage: { generate_tts: 32 } },
    at,
  );
}
export async function validateNarrationBytes(job, artifact, getBlob) {
  async function json(path, maxBytes) {
    const file = artifact.files.find((f) => f.path === path);
    if (!file || file.bytes > maxBytes)
      throw new Error("Narration metadata missing.");
    const blob = await getBlob(file.storageId);
    if (!blob || blob.size !== file.bytes)
      throw new Error("Narration metadata size changed.");
    const raw = Buffer.from(await blob.arrayBuffer());
    if (hash(raw) !== file.sha256)
      throw new Error("Narration metadata hash changed.");
    return JSON.parse(raw.toString("utf8"));
  }
  const page = await json("artifacts/current/page.json", 1024 * 1024);
  const transcript = await json("artifacts/transcript.json", 256 * 1024);
  const review = await json("artifacts/narration-review.json", 256 * 1024);
  const prepared = latest(job, "prepared_bundle");
  if (
    review.jobId !== job.jobId ||
    review.revisionId !== job.currentRevisionId ||
    review.preparedManifestDigest !== prepared.assetManifestDigest ||
    review.model !== "gpt-4o-mini-tts" ||
    review.voice !== "cedar" ||
    review.provider !== "openai" ||
    review.aiGenerated !== true
  )
    throw new Error("Narration provenance invalid.");
  if (
    !Array.isArray(page.languages) ||
    !page.languages.length ||
    page.languages.length > 2 ||
    page.languages.some((l) => !["fr", "ar"].includes(l)) ||
    !Array.isArray(page.sectionOrder) ||
    !page.sectionOrder.length ||
    page.sectionOrder.length > 6 ||
    transcript.version !== 1 ||
    Object.keys(transcript.tracks || {})
      .sort()
      .join() !== [...page.languages].sort().join()
  )
    throw new Error("Narration track binding invalid.");
  const expectedPaths = [];
  for (const language of page.languages) {
    const track = transcript.tracks[language];
    let rolling = 0;
    if (!Array.isArray(track) || track.length !== page.sectionOrder.length)
      throw new Error("Narration track length invalid.");
    for (const [index, section] of page.sectionOrder.entries()) {
      const entry = track[index];
      const path = `artifacts/audio/${language}/${section}.mp3`;
      expectedPaths.push(path);
      const clip = review.clips?.find(
        (c) => c.language === language && c.section === section,
      );
      const time = Math.floor(rolling);
      const formatted = `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
      if (
        entry.section !== section ||
        entry.text !==
          page.sections?.[section]?.[language]?.narrationText?.trim() ||
        !entry.text ||
        entry.seconds !== rolling ||
        entry.time !== formatted ||
        clip?.path !== path ||
        !Number.isFinite(clip.durationSeconds) ||
        clip.durationSeconds < 0.1 ||
        clip.durationSeconds > 180
      )
        throw new Error("Narration text or timing changed.");
      rolling += clip.durationSeconds;
    }
  }
  if (
    review.clips.length !== expectedPaths.length ||
    artifact.files
      .filter((f) => f.path.startsWith("artifacts/audio/"))
      .map((f) => f.path)
      .sort()
      .join() !== expectedPaths.sort().join()
  )
    throw new Error("Narration audio coverage invalid.");
}
export function validateNarration(job, value) {
  const source = latest(job, "prepared_bundle");
  if (
    !value ||
    value.kind !== "narration_review" ||
    value.revisionId !== job.currentRevisionId ||
    value.pageDigest !== source?.pageDigest ||
    !Array.isArray(value.files)
  )
    throw new Error("Narration source binding invalid.");
  const expected = manifest(
    job,
    "narration_review",
    value.files,
    source.pageDigest,
    value.transcriptDigest,
  );
  if (!isDeepStrictEqual(value, expected))
    throw new Error("Narration manifest commitment invalid.");
  // Existing prepared bytes cannot be removed or overwritten; the timed transcript has a distinct path.
  for (const f of source.files)
    if (!value.files.some((v) => isDeepStrictEqual(v, f)))
      throw new Error("Approved prepared bytes changed.");
  const additions = value.files.filter(
    (f) => !source.files.some((s) => s.path === f.path),
  );
  if (
    !additions.some(
      (f) =>
        f.path === "artifacts/transcript.json" &&
        f.sha256 === value.transcriptDigest,
    ) ||
    !additions.some((f) =>
      /^artifacts\/audio\/[a-z]{2}\/[A-Za-z0-9_-]+\.mp3$/.test(f.path),
    ) ||
    additions.some(
      (f) =>
        !/^artifacts\/(?:audio\/[a-z]{2}\/[A-Za-z0-9_-]+\.mp3|transcript\.json|narration-review\.json)$/.test(
          f.path,
        ),
    )
  )
    throw new Error("Narration media inventory invalid.");
}
