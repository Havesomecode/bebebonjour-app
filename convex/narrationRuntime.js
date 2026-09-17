"use node";
import { actionGeneric, makeFunctionReference as ref } from "convex/server";
import { v } from "convex/values";
import { randomUUID } from "node:crypto";
import {
  reviewTransition,
  beginTransition,
  promote,
  completeTransition,
  failTransition,
  validateNarration,
  validateNarrationBytes,
} from "../src/fulfillment/hosted-narration-transitions.mjs";
import { createOperatorNarrationTestAggregate } from "../src/fulfillment/job-machine.mjs";
import {
  manifest,
  hash,
} from "../src/fulfillment/hosted-narration-transitions.mjs";
const authorityArgs = {
  workerToken: v.string(),
  workerId: v.string(),
  commandId: v.string(),
  leaseToken: v.string(),
  jobId: v.string(),
};
export const createFictionalTest = actionGeneric({
  args: {
    operatorToken: v.string(),
    language: v.string(),
    text: v.string(),
    acknowledgement: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      process.env.BEBEBONJOUR_NARRATION_TESTS_ENABLED !== "true" ||
      !args.operatorToken ||
      args.operatorToken.length < 32 ||
      args.operatorToken !== process.env.BEBEBONJOUR_OPERATIONS_TOKEN ||
      args.operatorToken === process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN
    )
      throw new Error("Fictional test creation disabled or unauthorized.");
    if (
      args.acknowledgement !== "fictional-operator-authored-not-codex" ||
      !["fr", "ar"].includes(args.language) ||
      !args.text.trim() ||
      args.text.length > 2000
    )
      throw new Error("Invalid fictional content.");
    const jobId = `job_narration_test_${randomUUID()}`;
    const language = args.language;
    const text = args.text.trim();
    const page = {
      schemaVersion: "operator-narration-test-v1",
      jobId,
      pageRevision: "r1",
      languages: [language],
      sectionOrder: ["intro"],
      sections: { intro: { [language]: { narrationText: text } } },
      provenance: "fictional-operator-authored-not-codex",
    };
    const escape = (s) =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
    const values = [
      ["artifacts/current/page.json", JSON.stringify(page)],
      [
        "artifacts/current/transcript.json",
        JSON.stringify({
          version: 1,
          tracks: {
            [language]: [{ section: "intro", text, seconds: 0, time: "00:00" }],
          },
        }),
      ],
      [
        `private-preview/narration-test/${language}/index.html`,
        `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>Fictional narration test</title><body><h1>Fictional operator-authored test</h1><p>${escape(text)}</p></body></html>`,
      ],
    ];
    const files = [];
    for (const [path, raw] of values) {
      const bytes = Buffer.from(raw);
      const storageId = await ctx.storage.store(new Blob([bytes]));
      files.push({ path, storageId, bytes: bytes.length, sha256: hash(bytes) });
    }
    const artifactSet = manifest(
      { jobId, currentRevisionId: "r1" },
      "private_review",
      files,
      files[0].sha256,
      files[1].sha256,
    );
    const aggregate = createOperatorNarrationTestAggregate({
      jobId,
      artifactSet,
      at: new Date().toISOString(),
    });
    return ctx.runMutation(ref("narration:insertFictionalTest"), {
      operatorToken: args.operatorToken,
      aggregate,
      language,
    });
  },
});
export const advance = actionGeneric({
  args: {
    ...authorityArgs,
    operation: v.string(),
    artifactSet: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { operation, artifactSet, ...auth } = args;
    let { job, command } = await ctx.runQuery(ref("narration:readClaim"), auth);
    async function persist(next) {
      await ctx.runMutation(ref("narration:commitTransition"), {
        ...auth,
        expectedVersion: job.version,
        aggregate: next,
      });
      job = next;
    }
    const now = () => new Date().toISOString();
    if (operation === "review") {
      await persist(reviewTransition(job, command, now()));
      return {
        code: "review_recorded",
        decisionId: job.reviewDecisions.at(-1).decisionId,
        jobVersion: job.version,
      };
    }
    if (operation === "render" && command.action === "render") {
      await persist(beginTransition(job, command, now(), randomUUID()));
      await persist(completeTransition(job, command, promote(job), now()));
    } else if (
      operation === "begin" &&
      command.action === "generate_narration"
    ) {
      await persist(beginTransition(job, command, now(), randomUUID()));
      return { state: job.state };
    } else if (
      operation === "complete" &&
      command.action === "generate_narration" &&
      Number.isFinite(command.claim.effectStartedAtMs)
    ) {
      validateNarration(job, artifactSet);
      await validateNarrationBytes(job, artifactSet, (id) =>
        ctx.storage.get(id),
      );
      await persist(completeTransition(job, command, artifactSet, now()));
    } else if (
      operation === "fail" &&
      command.action === "generate_narration"
    ) {
      await persist(failTransition(job, command, now()));
      return { state: job.state };
    } else throw new Error("Narration operation rejected.");
    const artifact = job.artifactSets.at(-1);
    return {
      code: operation === "render" ? "release_rendered" : "narration_prepared",
      revisionId: job.currentRevisionId,
      artifactSetId: artifact.artifactSetId,
      jobVersion: job.version,
    };
  },
});
