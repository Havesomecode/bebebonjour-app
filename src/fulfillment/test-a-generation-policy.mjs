export const TEST_A_PREPARE_REVIEW_RETRY_POLICY = Object.freeze({
  leaseMs: 300_000,
  maxAttempts: 2,
  backoffMs: Object.freeze([60_000]),
});
