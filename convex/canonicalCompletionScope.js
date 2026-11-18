// Shared, fail-closed authority for the one fictional canonical completion run.
// The first command claim pins the target in Convex; env changes cannot redirect an in-flight effect.
const OWNER_JOB = 'job_narration_test_650a15d1-39bd-4dec-bc0d-3519ace71aa7';
const TEST_A_JOB = 'job_03c25b08-8476-4fe1-923b-43d73feab3ff';
const PIN_KEY = 'canonical_test_completion';
export const CANONICAL_WORKER_ID = 'canonical-test-completion-worker';
export const CANONICAL_ACTIONS = Object.freeze(['deliver', 'publish', 'queue_delivery']);
const HEX = /^[a-f0-9]{64}$/u;

export function canonicalConfig() {
  const env = process.env;
  const config = {
    jobId: env.BEBEBONJOUR_CANONICAL_COMPLETION_JOB_ID,
    revisionId: env.BEBEBONJOUR_CANONICAL_COMPLETION_REVISION_ID,
    manifestDigest: env.BEBEBONJOUR_CANONICAL_COMPLETION_MANIFEST_DIGEST,
    recipient: env.BEBEBONJOUR_CANONICAL_COMPLETION_RECIPIENT,
    contentApprovalId: env.BEBEBONJOUR_CANONICAL_COMPLETION_CONTENT_APPROVAL_ID,
    narrationApprovalId: env.BEBEBONJOUR_CANONICAL_COMPLETION_NARRATION_APPROVAL_ID || null,
    origin: env.CANONICAL_PUBLICATION_ORIGIN,
  };
  if (!/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(config.jobId || '')
      || [OWNER_JOB, TEST_A_JOB].includes(config.jobId)
      || !/^[A-Za-z0-9_-]{1,160}$/u.test(config.revisionId || '')
      || !HEX.test(config.manifestDigest || '')
      || !/^approval_[a-f0-9]{24}$/u.test(config.contentApprovalId || '')
      || (config.narrationApprovalId && !/^approval_[a-f0-9]{24}$/u.test(config.narrationApprovalId))
      || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(config.recipient || '')
      || ['delivered@resend.dev', 'z@havesomecode.io'].includes(config.recipient?.toLowerCase())
      || !isExactHttpsOrigin(config.origin)
      || typeof env.BEBEBONJOUR_APPROVAL_HMAC_KEY !== 'string'
      || new TextEncoder().encode(env.BEBEBONJOUR_APPROVAL_HMAC_KEY).length < 32) {
    throw new Error('Canonical TEST completion scope configuration is invalid.');
  }
  return config;
}

export function assertCanonicalToken(token) {
  const expected = process.env.BEBEBONJOUR_CANONICAL_COMPLETION_WORKER_TOKEN;
  if (typeof expected !== 'string' || expected.length < 32 || token !== expected) {
    throw new Error('Canonical TEST completion authorization failed.');
  }
  return canonicalConfig();
}

export async function canonicalScope(context, jobId, { pin = false } = {}) {
  const config = canonicalConfig();
  if (jobId !== config.jobId) throw new Error('Canonical TEST completion job authorization failed.');
  const pinned = await context.db.query('canonicalCompletionScopes')
    .withIndex('by_scope', (query) => query.eq('scope', PIN_KEY)).unique();
  if (pinned && canonicalJson(pinned.binding) !== canonicalJson(config)) {
    throw new Error('Canonical TEST completion binding changed after the first claim.');
  }
  if (pin && !pinned) {
    await context.db.insert('canonicalCompletionScopes', { scope: PIN_KEY, binding: config });
  }
  return config;
}

export async function assertCanonicalRelease(context, config, aggregate) {
  if (!aggregate || aggregate.jobId !== config.jobId || aggregate.environment !== 'test'
      || aggregate.product !== 'announcement-page' || aggregate.currentRevisionId !== config.revisionId
      || typeof aggregate.narrationRequired !== 'boolean') {
    throw new Error('Canonical TEST completion aggregate is outside the exact fictional job and revision.');
  }
  const customer = (await context.db.query('customerFlowJobs')
    .withIndex('by_job_id', (query) => query.eq('jobId', config.jobId)).unique())?.job;
  const correlation = aggregate.paymentCorrelation;
  if (customer?.jobId !== config.jobId || customer.intakeDigest !== aggregate.intakeDigest
      || customer.payment?.status !== 'paid' || !customer.payment.paymentIntentId
      || !customer.payment.acceptedEventId || !aggregate.payment?.providerPaymentId
      || !aggregate.payment.providerEventId
      || customer.payment.paymentIntentId !== aggregate.payment.providerPaymentId
      || customer.payment.acceptedEventId !== aggregate.payment.providerEventId
      || correlation?.project !== 'bebebonjour' || correlation.product !== aggregate.product
      || correlation.environment !== aggregate.environment || correlation.jobId !== config.jobId
      || correlation.intakeDigest !== aggregate.intakeDigest
      || canonicalJson(aggregate.payment.correlation) !== canonicalJson(correlation)) {
    throw new Error('Canonical TEST completion requires a correlated paid customer job.');
  }
  const kind = aggregate.narrationRequired ? 'narration_review' : 'prepared_bundle';
  const release = aggregate.artifactSets?.filter((entry) => entry.kind === kind && entry.revisionId === config.revisionId);
  if (release?.length !== 1 || release[0].assetManifestDigest !== config.manifestDigest
      || !Array.isArray(release[0].files) || !release[0].files.length
      || (aggregate.narrationRequired ? !config.narrationApprovalId : Boolean(config.narrationApprovalId))) {
    throw new Error('Canonical TEST completion manifest or narration approval is invalid.');
  }
  if (aggregate.publication && (aggregate.publication.stableUrl !== `${config.origin}/announcements/${config.jobId}`
      || aggregate.publication.artifactManifestDigest !== config.manifestDigest
      || aggregate.publication.revisionId !== config.revisionId)) {
    throw new Error('Canonical TEST completion publication origin or manifest changed.');
  }
  const targetRef = `resend:fictional:${config.jobId}`;
  const targetDigest = await sha256(canonicalJson({ targetRef, email: config.recipient }));
  for (const attempt of aggregate.stageAttempts || []) {
    if (attempt.stage === 'deliver' && (attempt.operationBinding?.targetRef !== targetRef
        || attempt.operationBinding?.targetDigest !== targetDigest)) {
      throw new Error('Canonical TEST completion recipient binding changed.');
    }
  }
  for (const delivery of aggregate.deliveryAttempts || []) {
    if (delivery.targetRef !== targetRef || delivery.revisionId !== config.revisionId) {
      throw new Error('Canonical TEST completion delivery target changed.');
    }
  }
  for (const [type, id, sourceKind] of [
    ['content', config.contentApprovalId, 'private_review'],
    ...(aggregate.narrationRequired ? [['narration', config.narrationApprovalId, 'narration_review']] : []),
  ]) {
    const row = await context.db.query('fulfillmentReviewApprovals')
      .withIndex('by_approval_id', (query) => query.eq('approvalId', id)).unique();
    const approval = row?.approval;
    if (!approval || approval.approvalId !== id || approval.schemaVersion !== '1.0'
        || approval.binding?.jobId !== config.jobId || approval.binding?.revisionId !== config.revisionId
        || approval.binding?.intakeDigest !== aggregate.intakeDigest
        || approval.binding?.environment !== 'test' || approval.binding?.product !== 'announcement-page'
        || approval.decision?.decisionType !== type || approval.decision?.outcome !== 'approved'
        || approval.decision?.revisionId !== config.revisionId || !HEX.test(approval.signature || '')) {
      throw new Error('Canonical TEST completion signed approval binding is invalid.');
    }
    const signed = { schemaVersion: approval.schemaVersion, approvalId: id,
      binding: approval.binding, decision: approval.decision };
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalJson(signed))))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (signature !== approval.signature) throw new Error('Canonical TEST completion approval signature invalid.');
    const source = aggregate.artifactSets?.filter((entry) => entry.kind === sourceKind && entry.revisionId === config.revisionId);
    const recorded = aggregate.reviewDecisions?.filter((entry) => entry.decisionType === type
      && entry.revisionId === config.revisionId && entry.outcome === 'approved'
      && entry.artifactDigests?.assetManifestDigest === approval.binding.artifactManifestDigest);
    if (source?.length !== 1 || recorded?.length !== 1
        || !['pageDigest', 'transcriptDigest', 'assetManifestDigest'].every((field) =>
          source[0][field] === approval.decision.artifactDigests?.[field]
          && recorded[0].artifactDigests?.[field] === approval.decision.artifactDigests?.[field])
        || approval.binding.artifactManifestDigest !== source[0].assetManifestDigest) {
      throw new Error('Canonical TEST completion approval does not bind the exact source artifact.');
    }
  }
  return release[0];
}

function isExactHttpsOrigin(value) {
  try { return new URL(value).protocol === 'https:' && new URL(value).origin === value; }
  catch { return false; }
}
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Canonical TEST completion binding is not deterministic JSON.');
}
async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
