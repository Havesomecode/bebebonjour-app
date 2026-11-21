import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { convexTest } from "convex-test";
import { makeFunctionReference as ref } from "convex/server";
import schema from "../support/legacy-schema.mjs";
const ops = process.env.BEBEBONJOUR_OPS_WORKTREE;
test(
  "cross-worktree: supported bootstrap → actual worker → durable decoded MP3 → approval → private readback",
  { skip: !ops },
  async () => {
    const { createNarrationWorker } = await import(
      pathToFileURL(`${ops}/src/server/narration-worker.mjs`)
    );
    const { generateNarration, decodeMp3Duration } = await import(
      pathToFileURL(`${ops}/src/server/narration-media.mjs`)
    );
    const { deriveCommandRequest, commandPrecondition } = await import(
      pathToFileURL(`${ops}/src/server/derive-command.mjs`)
    );
    const workerToken = "contract-narration-worker-test-32-characters";
    const operatorToken = "contract-operator-token-test-32-characters";
    process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN = workerToken;
    process.env.BEBEBONJOUR_OPERATIONS_TOKEN = operatorToken;
    process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED = "true";
    const t = convexTest(schema, {
      "./_generated/server.js": () => import("convex/server"),
      "./operations.js": () => import("../../convex/operations.js"),
      "./narration.js": () => import("../../convex/narration.js"),
      "./narrationRuntime.js": () => import("../../convex/narrationRuntime.js"),
      "./http.js": () => import("../../convex/http.js"),
    });
    const errors = [];
    const client = {
      query: (name, args) => t.query(ref(name), args),
      mutation: async (name, args) => {
        try {
          return await t.mutation(ref(name), args);
        } catch (error) {
          errors.push(`${name}: ${error.message}`);
          throw error;
        }
      },
      action: async (name, args) => {
        try {
          return await t.action(ref(name), args);
        } catch (error) {
          errors.push(error.message);
          throw error;
        }
      },
    };
    const { jobId } = await client.action(
      "narrationRuntime:createFictionalTest",
      {
        operatorToken,
        language: "fr",
        text: "Bienvenue dans cette famille fictive.",
        acknowledgement: "fictional-operator-authored-not-codex",
      },
    );
    const tone = await readFile(`${ops}/test/fixtures/narration-tone.mp3`);
    let requests = 0;
    const worker = createNarrationWorker({
      client,
      workerToken,
      generate: async (auth) => {
        const prepared = await client.query("narration:readPrepared", auth);
        const file = prepared.files.find(
          (f) => f.path === "artifacts/current/page.json",
        );
        const page = await t.run(async (ctx) =>
          JSON.parse(await (await ctx.storage.get(file.storageId)).text()),
        );
        return generateNarration({
          jobId,
          prepared,
          page,
          apiKey: "test-only",
          signal: AbortSignal.timeout(5000),
          fetch: async () => {
            requests++;
            return new Response(tone);
          },
          upload: async (_path, bytes) => {
            await client.mutation("narration:createUploadUrl", auth);
            return t.run((ctx) => ctx.storage.store(new Blob([bytes])));
          },
        });
      },
    });
    for (const [index, action] of [
      "approve_content",
      "render",
      "generate_narration",
      "request_narration_changes",
      "generate_narration",
      "approve_narration",
    ].entries()) {
      const job = await client.query("operations:getJob", {
        operatorToken,
        jobId,
      });
      const request = deriveCommandRequest(job, {
        action,
        ...(action === "request_narration_changes"
          ? { reasonCodes: ["narration_quality"] }
          : {}),
        precondition: commandPrecondition(job, action),
      });
      await client.mutation("operations:requestCommand", {
        ...request,
        operatorToken,
        commandId: `command_contract_${index}`,
      });
      assert.deepEqual(
        await worker.runOnce(jobId),
        {
          claimed: 1,
          completed: 1,
          failed: 0,
        },
        `${action}: ${errors.join("; ")}`,
      );
    }
    assert.equal(requests, 2);
    const job = await client.query("operations:getJob", {
      operatorToken,
      jobId,
    });
    assert.equal(job.fulfillment.state, "publish_ready");
    assert.equal(job.customer.payment.status, "not_applicable");
    assert.ok(!job.availableActions.includes("publish"));
    const artifact = job.fulfillment.artifactSets.at(-1);
    const audio = artifact.files.find((f) => f.path.endsWith(".mp3"));
    const url = `/narration/artifact?${new URLSearchParams({ mode: "operator", jobId, revisionId: "r1", path: audio.path })}`;
    const response = await t.fetch(url, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(response.status, 200);
    assert.ok(
      (await decodeMp3Duration(Buffer.from(await response.arrayBuffer()))) >
        0.4,
    );
    assert.deepEqual(await worker.runOnce(jobId), {
      claimed: 0,
      completed: 0,
      failed: 0,
    });
    assert.equal(requests, 2);
  },
);
