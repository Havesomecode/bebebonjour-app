import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseGenerationStore } from "../../src/persistence/supabase-generation-store.mjs";

function recordingClient(result = { data: { status: "leased" }, error: null }) {
  const calls = [];
  return {
    calls,
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return result;
    },
  };
}

test("the generation store requires an injected client", () => {
  assert.throws(
    () => createSupabaseGenerationStore(),
    /client with an rpc method is required/i,
  );
});

test("the generation store rejects an injected client without an RPC method", () => {
  assert.throws(
    () => createSupabaseGenerationStore({ client: {} }),
    /client with an rpc method is required/i,
  );
});

test("the generation store claims one preview run with immutable material digests", async () => {
  const client = recordingClient();
  const store = createSupabaseGenerationStore({ client });
  const materials = {
    catalogDigest: "1".repeat(64),
    templateDigest: "2".repeat(64),
    rendererDigest: "3".repeat(64),
  };

  const result = await store.claimNextPreviewRun(materials, { leaseSeconds: 300 });

  assert.deepEqual(result, { status: "leased" });
  assert.deepEqual(client.calls, [{
    name: "claim_next_preview_run",
    parameters: {
      p_catalog_digest: materials.catalogDigest,
      p_template_digest: materials.templateDigest,
      p_renderer_digest: materials.rendererDigest,
      p_lease_seconds: 300,
    },
  }]);
});

test("the generation store propagates RPC errors with operation context", async () => {
  const rpcError = new Error("permission denied for function claim_next_preview_run");
  const client = recordingClient({ data: null, error: rpcError });
  const store = createSupabaseGenerationStore({ client });
  const materials = {
    catalogDigest: "1".repeat(64),
    templateDigest: "2".repeat(64),
    rendererDigest: "3".repeat(64),
  };

  await assert.rejects(
    () => store.claimNextPreviewRun(materials, { leaseSeconds: 300 }),
    (error) => {
      assert.equal(error.message, "Supabase RPC claim_next_preview_run failed.");
      assert.equal(error.cause, rpcError);
      return true;
    },
  );
});

test("the generation store completes only the leased digest-bound preview", async () => {
  const client = recordingClient({ data: { status: "preview_ready" }, error: null });
  const store = createSupabaseGenerationStore({ client });
  const completion = {
    runId: "11111111-1111-4111-8111-111111111111",
    leaseToken: "22222222-2222-4222-8222-222222222222",
    artifactKey: "order/run/digest",
    artifactManifestDigest: "4".repeat(64),
    artifactByteCount: 12345,
  };

  const result = await store.completePreviewRun(completion);

  assert.deepEqual(result, { status: "preview_ready" });
  assert.deepEqual(client.calls, [{
    name: "complete_preview_run",
    parameters: {
      p_run_id: completion.runId,
      p_lease_token: completion.leaseToken,
      p_artifact_key: completion.artifactKey,
      p_artifact_manifest_digest: completion.artifactManifestDigest,
      p_artifact_byte_count: completion.artifactByteCount,
    },
  }]);
});

test("the generation store records a bounded lease failure without diagnostics", async () => {
  const client = recordingClient({ data: { status: "needs_editorial_input" }, error: null });
  const store = createSupabaseGenerationStore({ client });
  const failure = {
    runId: "11111111-1111-4111-8111-111111111111",
    leaseToken: "22222222-2222-4222-8222-222222222222",
    kind: "review_required",
    reasonCode: "ambiguous_name",
  };

  const result = await store.failPreviewRun(failure);

  assert.deepEqual(result, { status: "needs_editorial_input" });
  assert.deepEqual(client.calls, [{
    name: "fail_preview_run",
    parameters: {
      p_run_id: failure.runId,
      p_lease_token: failure.leaseToken,
      p_failure_kind: failure.kind,
      p_reason_code: failure.reasonCode,
    },
  }]);
});
