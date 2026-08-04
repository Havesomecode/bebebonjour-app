export function createSupabaseGenerationStore(options = {}) {
  if (typeof options.client?.rpc !== "function") {
    throw new Error("An injected client with an RPC method is required.");
  }
  const client = options.client;

  return {
    async claimNextPreviewRun(materials, { leaseSeconds }) {
      return callRpc(client, "claim_next_preview_run", {
        p_catalog_digest: materials.catalogDigest,
        p_template_digest: materials.templateDigest,
        p_renderer_digest: materials.rendererDigest,
        p_lease_seconds: leaseSeconds,
      });
    },

    async completePreviewRun(completion) {
      return callRpc(client, "complete_preview_run", {
        p_run_id: completion.runId,
        p_lease_token: completion.leaseToken,
        p_artifact_key: completion.artifactKey,
        p_artifact_manifest_digest: completion.artifactManifestDigest,
        p_artifact_byte_count: completion.artifactByteCount,
      });
    },

    async failPreviewRun(failure) {
      return callRpc(client, "fail_preview_run", {
        p_run_id: failure.runId,
        p_lease_token: failure.leaseToken,
        p_failure_kind: failure.kind,
        p_reason_code: failure.reasonCode,
      });
    },
  };
}

async function callRpc(client, name, parameters) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) {
    throw new Error(`Supabase RPC ${name} failed.`, { cause: error });
  }
  return data;
}
