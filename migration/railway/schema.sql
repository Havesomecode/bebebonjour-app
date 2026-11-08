BEGIN;
CREATE SCHEMA IF NOT EXISTS bb_candidate;
CREATE TABLE IF NOT EXISTS bb_candidate.customer_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  job jsonb NOT NULL CHECK ((job->>'jobId' = job_id AND (job->>'version')::int >= 1) IS TRUE)
);
CREATE TABLE IF NOT EXISTS bb_candidate.fulfillment_jobs (
  job_id text PRIMARY KEY REFERENCES bb_candidate.customer_jobs(job_id),
  aggregate jsonb NOT NULL CHECK ((aggregate->>'jobId' = job_id AND (aggregate->>'version')::int >= 1) IS TRUE)
);
CREATE TABLE IF NOT EXISTS bb_candidate.submissions (
  idempotency_key text PRIMARY KEY,
  job_id text NOT NULL REFERENCES bb_candidate.customer_jobs(job_id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK ((NOT (response ? 'intakeToken') AND response->>'jobId' = job_id
    AND response->>'intakeTokenCiphertext' ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') IS TRUE)
);
CREATE TABLE IF NOT EXISTS bb_candidate.provider_events (
  provider_event_id text PRIMARY KEY CHECK (provider_event_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb
);
CREATE TABLE IF NOT EXISTS bb_candidate.review_approvals (
  approval_id text PRIMARY KEY,
  approval jsonb NOT NULL CHECK ((approval->>'approvalId' = approval_id) IS TRUE)
);
CREATE TABLE IF NOT EXISTS bb_candidate.email_effects (
  idempotency_key text PRIMARY KEY,
  job_id text NOT NULL REFERENCES bb_candidate.customer_jobs(job_id),
  revision integer NOT NULL CHECK (revision > 0),
  stage text NOT NULL CHECK (stage IN ('draft_email', 'final_email')),
  provider text NOT NULL CHECK (provider IN ('resend', 'cloudflare')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  lease_token_digest text NOT NULL CHECK (lease_token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'issued', 'reconciliation_required', 'accepted', 'delivered', 'failed')),
  execution_id text,
  admitted_at timestamptz,
  provider_message_id text COLLATE "C" CHECK (provider_message_id IS NULL OR
    (length(provider_message_id) BETWEEN 1 AND 998 AND provider_message_id ~ '^[!-~]+$')),
  receipt jsonb,
  inspection jsonb,
  UNIQUE(job_id, revision, stage),
  UNIQUE(provider, provider_message_id),
  CHECK ((receipt IS NULL) = (provider_message_id IS NULL)),
  CHECK (receipt IS NULL OR ((receipt->>'provider' = provider AND receipt->>'providerMessageId' = provider_message_id
    AND receipt->>'idempotencyKey' = idempotency_key) IS TRUE)),
  CHECK (state NOT IN ('accepted', 'delivered', 'failed') OR receipt IS NOT NULL)
);
COMMIT;
