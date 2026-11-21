// Indexes used by the six PostgreSQL document tables. Existing rows remain unchanged.
export default {
  deliveryLoopJobs: { by_job_id:['jobId'], by_public_token:['publicToken'], by_idempotency_key:['idempotencyKey'], by_status:['status'] },
  deliveryLoopIntakeThrottle: { by_bucket_key:['bucketKey'] },
  deliveryLoopPaymentEvidence: { by_payment_id:['providerPaymentId'], by_promotion_policy:['promotion.policyId'] },
  deliveryLoopPaymentEvents: { by_identity:['providerAccountId','providerEventId'], by_fingerprint:['providerAccountId','providerEventId','rawBodySha256'] },
  deliveryLoopRetainedEvidence: { by_job_id:['jobId'] },
  customerFlowOperationsLoginThrottle: { by_bucket_key:['bucketKey'] },
};
