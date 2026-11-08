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
COMMIT;
