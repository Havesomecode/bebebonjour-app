export function canonicalizeJobScopedEditorialApproval(value) {
  return {
    record: canonicalizeJobScopedEditorialApprovalRecord(value.record),
    recordDigest: value.recordDigest,
  };
}

export function canonicalizeJobScopedEditorialApprovalRecord(record) {
  return {
    schemaVersion: record.schemaVersion,
    approvalType: record.approvalType,
    jobId: record.jobId,
    policy: {
      id: record.policy.id,
      preserveSubmittedName: record.policy.preserveSubmittedName,
      meaningAllowed: record.policy.meaningAllowed,
      scripturalNameAssociationAllowed: record.policy.scripturalNameAssociationAllowed,
      genericBlessingsAllowed: record.policy.genericBlessingsAllowed,
      maxStage: record.policy.maxStage,
    },
    sourceEvidence: {
      kind: record.sourceEvidence.kind,
      reference: record.sourceEvidence.reference,
    },
    sourceDigest: record.sourceDigest,
  };
}

export function serializeCanonicalJobScopedEditorialApprovalRecord(record) {
  return `${JSON.stringify(canonicalizeJobScopedEditorialApprovalRecord(record), null, 2)}\n`;
}
