import { createHash } from "node:crypto";

import {
  commandDeploy,
  commandPrepareReview,
  commandRender,
  commandSend,
  commandStatus,
} from "../../scripts/lib/commands.mjs";

const DEFAULT_COMMANDS = Object.freeze({
  prepareReview: commandPrepareReview,
  render: commandRender,
  deploy: commandDeploy,
  send: commandSend,
  status: commandStatus,
});

export function createLocalCommandStageHandlers(options = {}) {
  if ((options.mode || "local-test") !== "local-test") {
    throw new Error("These command handlers are for TEST-A local verification only.");
  }
  if (typeof options.resolveJobPaths !== "function" || typeof options.collectArtifactSet !== "function") {
    throw new Error("Path resolution and deterministic artifact collection are required.");
  }
  const commands = { ...DEFAULT_COMMANDS, ...options.commands };
  for (const name of ["prepareReview", "render", "tts", "deploy", "send", "status"]) {
    if (typeof commands[name] !== "function") {
      if (name === "tts") {
        throw new Error("An explicitly injected no-network TTS adapter is required for TEST-A.");
      }
      throw new Error(`Command adapter ${name} is required.`);
    }
  }

  async function pathsFor(context) {
    const paths = await options.resolveJobPaths(context.job);
    if (!paths || typeof paths !== "object") throw new Error("Job paths could not be resolved.");
    return paths;
  }

  async function artifactsFor(
    kind,
    context,
    paths,
    expectedRevisionId = context.job.currentRevisionId,
  ) {
    const artifactSet = await options.collectArtifactSet({ kind, context, paths });
    if (artifactSet?.kind !== kind || artifactSet.revisionId !== expectedRevisionId) {
      throw new Error(`${kind} artifact collection must bind the exact current revision.`);
    }
    return artifactSet;
  }

  async function existingArtifactsFor(kind, context, paths, expectedRevisionId) {
    if (typeof options.cleanupStageOutput !== "function") return null;
    const artifactSet = await options.collectArtifactSet({ kind, context, paths });
    if (artifactSet === null || artifactSet === undefined) return null;
    if (artifactSet.kind !== kind || artifactSet.revisionId !== expectedRevisionId) {
      throw new Error(`${kind} artifact collection must bind the exact current revision.`);
    }
    return artifactSet;
  }

  async function runGenerationCommand({ kind, context, paths, command, expectedRevisionId }) {
    const existing = await existingArtifactsFor(kind, context, paths, expectedRevisionId);
    if (existing) return existing;
    try {
      await command();
    } catch (error) {
      if (typeof options.cleanupStageOutput === "function") {
        await options.cleanupStageOutput({ kind, context, paths });
      }
      throw error;
    }
    return artifactsFor(kind, context, paths, expectedRevisionId);
  }

  return {
    async prepare_delivery(context) {
      const paths = await pathsFor(context);
      return targetBindingForPath(requiredPath(paths, "jobPath"));
    },

    async prepare_review(context) {
      const paths = await pathsFor(context);
      const commandArgs = {
        input: requiredPath(paths, "intakePath"),
        output: requiredPath(paths, "reviewRoot"),
        ...(paths.selectionId ? { select: paths.selectionId } : {}),
      };
      const artifactSet = await runGenerationCommand({
        kind: "private_review",
        context,
        paths,
        expectedRevisionId: paths.revision?.revisionId,
        command: () => commands.prepareReview(commandArgs),
      });
      return {
        revision: structuredClone(paths.revision),
        artifactSet,
      };
    },

    async render_approved(context) {
      const paths = await pathsFor(context);
      const artifactSet = await runGenerationCommand({
        kind: "prepared_bundle",
        context,
        paths,
        expectedRevisionId: context.job.currentRevisionId,
        command: () => commands.render({
          input: requiredPath(paths, "approvedPagePath"),
          approval: requiredPath(paths, "approvalPath"),
          output: requiredPath(paths, "preparedRoot"),
        }),
      });
      return { artifactSet };
    },

    async generate_tts(context) {
      const paths = await pathsFor(context);
      const artifactSet = await runGenerationCommand({
        kind: "narration_review",
        context,
        paths,
        expectedRevisionId: context.job.currentRevisionId,
        command: () => commands.tts({
          input: requiredPath(paths, "approvedPagePath"),
          approval: requiredPath(paths, "approvalPath"),
          prepared: requiredPath(paths, "preparedRoot"),
          output: requiredPath(paths, "narrationReviewRoot"),
          lang: paths.languages?.join(",") || "all",
        }),
      });
      return { artifactSet };
    },

    async publish(context) {
      const paths = await pathsFor(context);
      await commands.deploy({
        input: requiredPath(paths, "finalRoot"),
        job: requiredPath(paths, "jobPath"),
        "dry-run": true,
        "idempotency-key": context.idempotencyKey,
      });
      const releaseKind = context.job.narrationDecision ? "narration_review" : "prepared_bundle";
      const artifactSet = await artifactsFor(releaseKind, context, paths);
      const stableUrl = requiredPath(paths, "stableUrl");
      assertLocalVerificationUrl(stableUrl);
      return {
        publication: {
          provider: "vercel-dry-run",
          revisionId: context.job.currentRevisionId,
          stableUrl,
          artifactManifestDigest: artifactSet.assetManifestDigest,
          providerReceiptId: context.idempotencyKey,
        },
      };
    },

    async deliver(context) {
      const paths = await pathsFor(context);
      const jobPath = requiredPath(paths, "jobPath");
      if (context.operation?.deliveryTarget) {
        const currentBinding = targetBindingForPath(jobPath);
        if (
          currentBinding.targetRef !== context.operation.deliveryTarget.targetRef
          || currentBinding.targetDigest !== context.operation.deliveryTarget.targetDigest
        ) {
          throw new Error("Resolved local delivery target changed after the operation was claimed.");
        }
      }
      await commands.send({
        job: jobPath,
        provider: "console",
        "dry-run": true,
        "idempotency-key": context.idempotencyKey,
      });
      return {
        delivery: {
          provider: "console-dry-run",
          revisionId: context.job.currentRevisionId,
          providerMessageId: context.idempotencyKey,
        },
      };
    },

    async legacyStatus(context) {
      const paths = await pathsFor(context);
      return commands.status({ job: requiredPath(paths, "jobPath"), json: true });
    },
  };
}

function requiredPath(paths, key) {
  const value = paths[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Resolved job path ${key} is required.`);
  }
  return value;
}

function assertLocalVerificationUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Local verification URL must use HTTP(S).");
  }
  const local = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
    || url.hostname.endsWith(".invalid");
  if (!local) throw new Error("TEST-A publication cannot record a remotely reachable URL.");
}

function targetBindingForPath(jobPath) {
  return {
    targetRef: jobPath,
    targetDigest: createHash("sha256").update(jobPath).digest("hex"),
  };
}
