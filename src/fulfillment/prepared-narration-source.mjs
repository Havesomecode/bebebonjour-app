const latest = (job, kind) =>
  [...job.artifactSets].reverse().find((a) => a.kind === kind && a.revisionId === job.currentRevisionId);

export function validatePreparedSource(job, prepared = latest(job, "prepared_bundle")) {
  const source = latest(job, "private_review");
  const decision = [...job.reviewDecisions]
    .reverse()
    .find(
      (entry) =>
        entry.decisionType === "content" &&
        entry.revisionId === job.currentRevisionId,
    );
  if (
    !prepared ||
    !source ||
    prepared.revisionId !== job.currentRevisionId ||
    prepared.sourcePrivateReviewManifestDigest !== source.assetManifestDigest ||
    prepared.pageDigest !== source.pageDigest ||
    prepared.transcriptDigest !== source.transcriptDigest ||
    decision?.outcome !== "approved" ||
    decision.artifactDigests?.assetManifestDigest !== source.assetManifestDigest ||
    decision.artifactDigests?.pageDigest !== source.pageDigest ||
    decision.artifactDigests?.transcriptDigest !== source.transcriptDigest
  ) {
    throw new Error("Approved prepared source binding invalid.");
  }
  return prepared;
}
