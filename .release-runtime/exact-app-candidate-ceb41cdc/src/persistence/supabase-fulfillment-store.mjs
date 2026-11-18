import { createClient } from "@supabase/supabase-js";

export function createSupabaseFulfillmentStore(options = {}) {
  const client = options.client || createServerClient(options);

  return {
    async ingestTallySubmission(normalized, evidence) {
      return callRpc(client, "ingest_tally_submission_v2", {
        p_event_id: normalized.source.eventId,
        p_submission_id: normalized.source.submissionId,
        p_payment_id: normalized.payment.paymentId,
        p_intake: normalized.intake,
        p_payload_sha256: evidence.payloadSha256,
      });
    },

    async ingestStripePayment(normalized, evidence) {
      return callRpc(client, "ingest_stripe_payment_v2", {
        p_event_id: normalized.source.eventId,
        p_payment_id: normalized.payment.paymentId,
        p_status: normalized.payment.status,
        p_amount_minor: normalized.payment.amountMinor,
        p_currency: normalized.payment.currency,
        p_email: normalized.payment.email,
        p_payload_sha256: evidence.payloadSha256,
      });
    },

    async recordRejectedProviderEvent(rejection) {
      return callRpc(client, "record_rejected_webhook_event", {
        p_provider: rejection.provider,
        p_event_id: rejection.eventId,
        p_reason_code: rejection.reasonCode,
        p_payload_sha256: rejection.payloadSha256,
      });
    },
  };
}

function createServerClient({ url, serviceRoleKey }) {
  if (!isNonEmptyString(url) || !isNonEmptyString(serviceRoleKey)) {
    throw new Error("Supabase URL and service-role key are required.");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function callRpc(client, name, parameters) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) {
    throw new Error(`Supabase RPC ${name} failed.`, { cause: error });
  }
  return data;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
