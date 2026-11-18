import {
  actionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

const TEST_A_JOB_ID = "job_03c25b08-8476-4fe1-923b-43d73feab3ff";
const TEST_A_WORKER_ID = "test-a-narration-worker";
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION_ID = /^r[1-9][0-9]*$/u;
const GRANT_ID = /^narration_upload_[a-f0-9]{24}$/u;
const MAX_FILES = 256;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const UPLOAD_GRANT_TTL_MS = 5 * 60 * 1_000;
const CANONICAL_NARRATION_INPUT_PATH = "deploy/narration-input.json";
const OPENAI_SPEECH_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const CANONICAL_NARRATION_PROVIDER = "openai";
const CANONICAL_NARRATION_MODEL = "gpt-4o-mini-tts";
const NARRATION_LANGUAGES = ["ar", "fr"];
const NARRATION_SECTIONS = ["intro", "dua", "meaning", "reveal", "verses", "closing"];
const APPROVED_NARRATION_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "marin", "nova", "onyx", "sage",
  "shimmer", "verse", "cedar",
]);
const MAX_NARRATION_SEGMENT_TEXT_BYTES = 8 * 1024;
const MAX_NARRATION_TOTAL_TEXT_BYTES = 48 * 1024;
const CLAIMED_NARRATION_ARGS = Object.freeze({
  workerToken: v.string(),
  workerId: v.string(),
  commandId: v.string(),
  leaseToken: v.string(),
  jobId: v.string(),
});
const READ_CANONICAL_NARRATION_INPUT = makeFunctionReference("narration:readCanonicalNarrationInput");
const COMMIT_SERVER_GENERATED_NARRATION = makeFunctionReference(
  "narration:commitServerGeneratedNarrationReviewArtifactSet",
);
const READ_COMPLETED_NARRATION_ACTION_OUTCOME = makeFunctionReference(
  "narration:readCompletedNarrationActionOutcome",
);
const CLAIM_NARRATION_PROVIDER_EFFECT = makeFunctionReference(
  "narration:claimNarrationProviderEffect",
);
const RECORD_NARRATION_PROVIDER_EFFECT = makeFunctionReference(
  "narration:recordNarrationProviderEffect",
);

export const readPreparedBundle = internalQueryGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    const { preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    await assertArtifactBlobs(context, preparedBundle.files);
    const files = preparedBundle.files.map(publicArtifactFile);
    return {
      artifactSet: { ...preparedBundle, files },
      files,
    };
  },
});

export const authorizePreparedBundleRead = internalQueryGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    revisionId: v.string(),
    path: v.string(),
  },
  handler: async (context, args) => {
    const { preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    if (args.revisionId !== preparedBundle.revisionId || !safeRelativePath(args.path)) {
      throw new Error("Narration prepared bundle lookup is invalid.");
    }
    const file = preparedBundle.files.find((entry) => entry.path === args.path);
    if (!file) throw new Error("Narration prepared bundle file is missing.");
    await assertArtifactBlobs(context, [file]);
    return file;
  },
});

export const readCanonicalNarrationInput = internalQueryGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    const { preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    const file = preparedBundle.files.find((entry) => entry.path === CANONICAL_NARRATION_INPUT_PATH);
    if (!file) throw new Error("Narration canonical input is missing from the approved prepared bundle.");
    await assertArtifactBlobs(context, [file]);
    return {
      file,
      revisionId: preparedBundle.revisionId,
      pageDigest: preparedBundle.pageDigest,
      transcriptDigest: preparedBundle.transcriptDigest,
      sourcePreparedBundleManifestDigest: preparedBundle.assetManifestDigest,
    };
  },
});

function publicArtifactFile({ path, bytes, sha256 }) {
  return { path, bytes, sha256 };
}

export const createNarrationReviewUploadUrl = internalMutationGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    expectedFile: v.any(),
  },
  handler: async (context, args) => {
    const { command, preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    if (!validUploadIntent(args.expectedFile) || !args.expectedFile.path.startsWith("narration/")) {
      throw new Error("Narration upload intent is invalid.");
    }
    const nowMs = Date.now();
    const scopeKey = await uploadGrantScope(args, preparedBundle.revisionId, args.expectedFile);
    const { liveGrants } = await collectLiveNarrationUploadGrants(
      context,
      args.jobId,
      preparedBundle.revisionId,
      nowMs,
    );
    const scopedLiveGrants = liveGrants.filter((grant) => (
      grant.commandId === command.commandId && grant.leaseToken === args.leaseToken
    ));
    const existing = await context.db
      .query("fulfillmentNarrationUploadGrants")
      .withIndex("by_scope_key", (query) => query.eq("scopeKey", scopeKey))
      .unique();
    if (existing || scopedLiveGrants.some((grant) => (
      canonicalJson(grant.expectedFile) === canonicalJson(uploadIntent(args.expectedFile))
    ))) {
      throw new Error("Narration upload grant is already active or consumed.");
    }
    const totalExpectedBytes = scopedLiveGrants.reduce(
      (total, grant) => total + grant.expectedFile.bytes,
      args.expectedFile.bytes,
    );
    if (scopedLiveGrants.length >= MAX_FILES || totalExpectedBytes > MAX_TOTAL_BYTES) {
      throw new Error("Narration upload grant budget is exhausted.");
    }
    const grantId = `narration_upload_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const uploadUrl = await context.storage.generateUploadUrl();
    await context.db.insert("fulfillmentNarrationUploadGrants", {
      grantId,
      scopeKey,
      jobId: args.jobId,
      revisionId: preparedBundle.revisionId,
      commandId: command.commandId,
      leaseToken: args.leaseToken,
      expectedFile: uploadIntent(args.expectedFile),
      expiresAtMs: nowMs + UPLOAD_GRANT_TTL_MS,
      consumedAtMs: null,
      storageId: null,
    });
    return { grantId, uploadUrl, expiresAtMs: nowMs + UPLOAD_GRANT_TTL_MS };
  },
});

export const cleanupExpiredNarrationReviewUploadGrants = internalMutationGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    const { preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    const { deleted } = await collectLiveNarrationUploadGrants(
      context,
      args.jobId,
      preparedBundle.revisionId,
      Date.now(),
    );
    return { deleted };
  },
});

export const commitNarrationReviewArtifactSet = internalMutationGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    artifactSet: v.any(),
    uploadGrantIds: v.array(v.string()),
  },
  handler: (context, args) => commitNarrationReviewArtifactSetInternal(
    context,
    args,
    { consumeUploadGrants: true },
  ),
});

export const commitServerGeneratedNarrationReviewArtifactSet = internalMutationGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    artifactSet: v.any(),
  },
  handler: (context, args) => commitNarrationReviewArtifactSetInternal(context, args),
});

export const claimNarrationProviderEffect = internalMutationGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    segment: v.any(),
    requestDigest: v.string(),
  },
  handler: async (context, args) => {
    const { command, preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    const segmentKey = canonicalNarrationSegmentKey(args.segment);
    if (!DIGEST.test(args.requestDigest)) {
      throw new Error("Narration provider effect request binding is invalid.");
    }
    const scopeKey = await narrationProviderEffectScope(args, preparedBundle.revisionId, segmentKey);
    const providerRequestKey = await narrationProviderRequestKey(
      command.commandId,
      preparedBundle.assetManifestDigest,
      segmentKey,
      args.requestDigest,
    );
    const existing = await context.db
      .query("fulfillmentNarrationProviderEffects")
      .withIndex("by_scope_key", (query) => query.eq("scopeKey", scopeKey))
      .unique();
    if (existing) {
      if (
        existing.jobId !== args.jobId
        || existing.revisionId !== preparedBundle.revisionId
        || existing.commandId !== command.commandId
        || existing.leaseToken !== args.leaseToken
        || existing.segmentKey !== segmentKey
        || existing.requestDigest !== args.requestDigest
        || existing.providerRequestKey !== providerRequestKey
      ) {
        throw new Error("Narration provider effect scope is immutable.");
      }
      if (existing.state === "stored") {
        if (!validStoredNarrationProviderEffect(existing)) {
          throw new Error("Narration provider effect output is malformed.");
        }
        await assertArtifactBlobs(context, [providerEffectFile(existing)]);
        return { state: "stored", file: providerEffectFile(existing) };
      }
      throw new Error("Narration provider effect is unresolved; reconciliation is required before replay.");
    }
    await context.db.insert("fulfillmentNarrationProviderEffects", {
      scopeKey,
      jobId: args.jobId,
      revisionId: preparedBundle.revisionId,
      commandId: command.commandId,
      leaseToken: args.leaseToken,
      segmentKey,
      requestDigest: args.requestDigest,
      providerRequestKey,
      state: "issued",
      issuedAtMs: Date.now(),
      storageId: null,
      bytes: null,
      sha256: null,
    });
    return { state: "issued", providerRequestKey };
  },
});

export const recordNarrationProviderEffect = internalMutationGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    segment: v.any(),
    requestDigest: v.string(),
    providerRequestKey: v.string(),
    file: v.any(),
  },
  handler: async (context, args) => {
    const { command, preparedBundle } = await assertApprovedNarrationAuthority(context, args);
    const segmentKey = canonicalNarrationSegmentKey(args.segment);
    if (!DIGEST.test(args.requestDigest) || !DIGEST.test(args.providerRequestKey) || !validNarrationProviderEffectFile(args.file)) {
      throw new Error("Narration provider effect output is invalid.");
    }
    const scopeKey = await narrationProviderEffectScope(args, preparedBundle.revisionId, segmentKey);
    const existing = await context.db
      .query("fulfillmentNarrationProviderEffects")
      .withIndex("by_scope_key", (query) => query.eq("scopeKey", scopeKey))
      .unique();
    const expectedProviderRequestKey = await narrationProviderRequestKey(
      command.commandId,
      preparedBundle.assetManifestDigest,
      segmentKey,
      args.requestDigest,
    );
    if (
      !existing
      || existing.jobId !== args.jobId
      || existing.revisionId !== preparedBundle.revisionId
      || existing.commandId !== command.commandId
      || existing.leaseToken !== args.leaseToken
      || existing.state !== "issued"
      || existing.requestDigest !== args.requestDigest
      || existing.providerRequestKey !== expectedProviderRequestKey
      || args.providerRequestKey !== expectedProviderRequestKey
    ) {
      throw new Error("Narration provider effect issuance is not authorized.");
    }
    await assertArtifactBlobs(context, [args.file]);
    await context.db.patch(existing._id, {
      state: "stored",
      storageId: args.file.storageId,
      bytes: args.file.bytes,
      sha256: args.file.sha256,
    });
    return { file: args.file };
  },
});

export const generateNarrationReview = actionGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    const completed = await context.runQuery(READ_COMPLETED_NARRATION_ACTION_OUTCOME, args);
    if (completed) return completed;
    const inputBinding = await context.runQuery(READ_CANONICAL_NARRATION_INPUT, args);
    const sourceBlob = await context.storage.get(inputBinding.file.storageId);
    if (!sourceBlob || sourceBlob.size !== inputBinding.file.bytes) {
      throw new Error("Narration canonical input blob is unavailable or changed.");
    }
    const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer());
    if (sourceBytes.byteLength !== inputBinding.file.bytes || await sha256Bytes(sourceBytes) !== inputBinding.file.sha256) {
      throw new Error("Narration canonical input blob integrity verification failed.");
    }
    const input = parseCanonicalNarrationInput(sourceBytes, inputBinding);
    const apiKey = requiredOpenAiApiKey();
    const files = [];
    let totalBytes = 0;
    for (const segment of input.segments) {
      const requestDigest = await narrationSegmentRequestDigest(segment);
      const effect = await context.runMutation(CLAIM_NARRATION_PROVIDER_EFFECT, {
        ...args,
        segment,
        requestDigest,
      });
      let file;
      if (effect.state === "stored") {
        file = effect.file;
      } else {
        const audio = await requestNarrationSpeech(apiKey, segment, effect.providerRequestKey);
        if (audio.byteLength < 1 || audio.byteLength > MAX_FILE_BYTES) {
          throw new Error("Narration provider returned an out-of-bounds audio artifact.");
        }
        const sha256 = await sha256Bytes(audio);
        const storageId = await context.storage.store(new Blob([audio]), { sha256 });
        file = (await context.runMutation(RECORD_NARRATION_PROVIDER_EFFECT, {
          ...args,
          segment,
          requestDigest,
          providerRequestKey: effect.providerRequestKey,
          file: {
            path: narrationSegmentPath(segment),
            storageId,
            bytes: audio.byteLength,
            sha256,
          },
        })).file;
      }
      totalBytes += file.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Narration provider output exceeds the total artifact-byte limit.");
      }
      files.push(file);
    }
    const artifactSet = {
      kind: "narration_review",
      revisionId: inputBinding.revisionId,
      pageDigest: inputBinding.pageDigest,
      transcriptDigest: inputBinding.transcriptDigest,
      assetManifestDigest: await narrationArtifactManifestDigest(inputBinding.revisionId, files),
      sourcePreparedBundleManifestDigest: inputBinding.sourcePreparedBundleManifestDigest,
      manifestRef: `jobs/${args.jobId}/revisions/${inputBinding.revisionId}/manifests/narration_review.json`,
      files,
    };
    return context.runMutation(COMMIT_SERVER_GENERATED_NARRATION, { ...args, artifactSet });
  },
});

export const readCompletedNarrationActionOutcome = internalQueryGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    let completed;
    try {
      completed = await findNarrationActionCompletionAuthority(context, args);
    } catch {
      return null;
    }
    if (!completed) return null;
    const narration = findNarrationReviewArtifactSet(
      completed.aggregate,
      completed.aggregate.currentRevisionId,
    );
    return { created: false, artifactSet: publicNarrationArtifactSet(narration) };
  },
});

export const readNarrationFulfillmentJob = queryGeneric({
  args: CLAIMED_NARRATION_ARGS,
  handler: async (context, args) => {
    const authority = await findNarrationActionCompletionAuthority(context, args);
    if (!authority) throw new Error("Narration action completion is not yet canonical.");
    const { aggregate } = authority;
    const narration = findNarrationReviewArtifactSet(aggregate, aggregate.currentRevisionId);
    return {
      jobId: aggregate.jobId,
      state: aggregate.state,
      version: aggregate.version,
      currentRevisionId: aggregate.currentRevisionId,
      artifactSets: narration ? [narration] : [],
    };
  },
});

async function commitNarrationReviewArtifactSetInternal(context, args, options = {}) {
  const completed = await assertCompletedNarrationAuthority(context, args);
  if (completed) {
    await assertNarrationReviewArtifactSet(
      context,
      args.jobId,
      args.artifactSet,
      completed.preparedBundle,
    );
    const existing = findNarrationReviewArtifactSet(completed.aggregate, args.artifactSet.revisionId);
    if (!existing || !sameNarrationArtifactSet(existing, args.artifactSet)) {
      throw new Error("Narration review artifact set is immutable once committed.");
    }
    return { created: false, artifactSet: publicNarrationArtifactSet(existing) };
  }
  const active = await assertApprovedNarrationAuthority(context, args);
  const { command, aggregate, jobDocument, preparedBundle, attempt } = active;
  await assertNarrationReviewArtifactSet(context, args.jobId, args.artifactSet, preparedBundle);
  const existing = findNarrationReviewArtifactSet(aggregate, args.artifactSet.revisionId);
  if (existing) {
    if (!sameNarrationArtifactSet(existing, args.artifactSet)) {
      throw new Error("Narration review artifact set is immutable once committed.");
    }
    return { created: false, artifactSet: publicNarrationArtifactSet(existing) };
  }
  const nextAggregate = await completeNarrationStage(aggregate, attempt, args, preparedBundle);
  if (options.consumeUploadGrants === true) {
    await assertAndConsumeUploadGrants(context, args, command, preparedBundle, args.artifactSet.files);
  }
  await context.db.patch(jobDocument._id, { aggregate: nextAggregate });
  return { created: true, artifactSet: args.artifactSet };
}

function parseCanonicalNarrationInput(bytes, binding) {
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Narration canonical input is not valid UTF-8 JSON.");
  }
  assertCanonicalNarrationInput(input, binding);
  return input;
}

function assertCanonicalNarrationInput(input, binding) {
  if (
    !exactObject(input, ["schemaVersion", "pageId", "revisionId", "provider", "model", "languages", "sectionOrder", "segments"])
    || input.schemaVersion !== "1.0"
    || typeof input.pageId !== "string"
    || input.pageId.length < 1
    || input.revisionId !== binding.revisionId
    || input.provider !== CANONICAL_NARRATION_PROVIDER
    || input.model !== CANONICAL_NARRATION_MODEL
    || !validOrderedSubset(input.languages, NARRATION_LANGUAGES)
    || !sameOrderedValues(input.sectionOrder, NARRATION_SECTIONS)
    || !Array.isArray(input.segments)
    || input.segments.length !== input.languages.length * input.sectionOrder.length
    || input.segments.length > MAX_FILES
  ) {
    throw new Error("Narration canonical input does not satisfy the approved bounded contract.");
  }
  let totalBytes = 0;
  const seen = new Set();
  for (const [index, segment] of input.segments.entries()) {
    if (
      !exactObject(segment, ["language", "section", "ordinal", "voice", "instructions", "text"])
      || !input.languages.includes(segment.language)
      || !input.sectionOrder.includes(segment.section)
      || !Number.isInteger(segment.ordinal)
      || segment.ordinal !== input.sectionOrder.indexOf(segment.section) + 1
      || !APPROVED_NARRATION_VOICES.has(segment.voice)
      || !boundedNarrationText(segment.instructions, MAX_NARRATION_SEGMENT_TEXT_BYTES)
      || !boundedNarrationText(segment.text, MAX_NARRATION_SEGMENT_TEXT_BYTES)
    ) {
      throw new Error("Narration canonical input segment is invalid.");
    }
    const expectedLanguage = input.languages[Math.floor(index / input.sectionOrder.length)];
    const expectedSection = input.sectionOrder[index % input.sectionOrder.length];
    if (segment.language !== expectedLanguage || segment.section !== expectedSection) {
      throw new Error("Narration canonical input segment ordering is invalid.");
    }
    const key = `${segment.language}\u0000${segment.section}`;
    if (seen.has(key)) throw new Error("Narration canonical input contains duplicate segments.");
    seen.add(key);
    totalBytes += new TextEncoder().encode(segment.text).byteLength;
    if (totalBytes > MAX_NARRATION_TOTAL_TEXT_BYTES) {
      throw new Error("Narration canonical input total text exceeds its byte limit.");
    }
  }
}

function boundedNarrationText(value, maximumBytes) {
  return typeof value === "string"
    && /\S/u.test(value)
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function validOrderedSubset(values, allowed) {
  return Array.isArray(values)
    && values.length >= 1
    && values.length <= allowed.length
    && new Set(values).size === values.length
    && values.every((value, index) => allowed.indexOf(value) === index);
}

function sameOrderedValues(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requiredOpenAiApiKey() {
  const value = process.env.OPENAI_API_KEY;
  if (typeof value !== "string" || value.length < 32) {
    throw new Error("Narration provider configuration is unavailable.");
  }
  return value;
}

async function requestNarrationSpeech(apiKey, segment, providerRequestKey) {
  const response = await fetch(OPENAI_SPEECH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": providerRequestKey,
    },
    body: JSON.stringify({
      model: CANONICAL_NARRATION_MODEL,
      voice: segment.voice,
      input: segment.text,
      response_format: "mp3",
      instructions: segment.instructions,
    }),
  });
  if (!response.ok) {
    throw new Error(`Narration provider request failed (${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Narration provider returned an empty audio artifact.");
  return bytes;
}

function canonicalNarrationSegmentKey(segment) {
  if (!segment || typeof segment !== "object"
    || typeof segment.language !== "string"
    || typeof segment.section !== "string"
    || !Number.isInteger(segment.ordinal)
    || !NARRATION_LANGUAGES.includes(segment.language)
    || !NARRATION_SECTIONS.includes(segment.section)
    || segment.ordinal !== NARRATION_SECTIONS.indexOf(segment.section) + 1) {
    throw new Error("Narration provider effect segment is invalid.");
  }
  return `${segment.language}/${String(segment.ordinal).padStart(2, "0")}-${segment.section}`;
}

function narrationSegmentPath(segment) {
  return `narration/${canonicalNarrationSegmentKey(segment)}.mp3`;
}

async function narrationSegmentRequestDigest(segment) {
  return sha256Hex(canonicalJson({
    instructions: segment.instructions,
    model: CANONICAL_NARRATION_MODEL,
    response_format: "mp3",
    text: segment.text,
    voice: segment.voice,
  }));
}

async function narrationProviderEffectScope(args, revisionId, segmentKey) {
  return sha256Hex(canonicalJson({
    commandId: args.commandId,
    jobId: args.jobId,
    revisionId,
    segmentKey,
  }));
}

async function narrationProviderRequestKey(commandId, preparedBundleManifestDigest, segmentKey, requestDigest) {
  return sha256Hex(canonicalJson({
    commandId,
    preparedBundleManifestDigest,
    requestDigest,
    segmentKey,
  }));
}

function validNarrationProviderEffectFile(file) {
  return file
    && typeof file === "object"
    && typeof file.path === "string"
    && /^narration\/(?:ar|fr)\/[0-9]{2}-(?:intro|dua|meaning|reveal|verses|closing)\.mp3$/u.test(file.path)
    && typeof file.storageId === "string"
    && file.storageId.length > 0
    && Number.isInteger(file.bytes)
    && file.bytes > 0
    && file.bytes <= MAX_FILE_BYTES
    && DIGEST.test(file.sha256);
}

function validStoredNarrationProviderEffect(effect) {
  return validNarrationProviderEffectFile({
    path: `narration/${effect.segmentKey}.mp3`,
    storageId: effect.storageId,
    bytes: effect.bytes,
    sha256: effect.sha256,
  });
}

function providerEffectFile(effect) {
  return {
    path: `narration/${effect.segmentKey}.mp3`,
    storageId: effect.storageId,
    bytes: effect.bytes,
    sha256: effect.sha256,
  };
}

async function narrationArtifactManifestDigest(revisionId, files) {
  return sha256Hex(`${JSON.stringify({
    schemaVersion: "1.0",
    kind: "narration_review",
    revisionId,
    files: normalizeInventory(files),
  }, null, 2)}\n`);
}

async function sha256Bytes(bytes) {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export const readNarrationReviewArtifactSet = internalQueryGeneric({
  args: {
    ...CLAIMED_NARRATION_ARGS,
    revisionId: v.string(),
  },
  handler: async (context, args) => {
    const authority = await assertCompletedNarrationAuthority(context, args)
      || await assertApprovedNarrationAuthority(context, args);
    const { aggregate, preparedBundle } = authority;
    if (args.revisionId !== preparedBundle.revisionId) {
      throw new Error("Narration review revision is not authorized.");
    }
    const artifactSet = findNarrationReviewArtifactSet(aggregate, args.revisionId);
    if (!artifactSet) return null;
    await assertAggregateNarrationReviewArtifactSet(context, args.jobId, artifactSet, preparedBundle);
    await assertArtifactBlobs(context, artifactSet.files);
    return { artifactSet: publicNarrationArtifactSet(artifactSet), files: artifactSet.files };
  },
});

async function assertApprovedNarrationAuthority(context, args) {
  assertNarrationWorkerToken(args.workerToken);
  if (args.jobId !== TEST_A_JOB_ID || args.workerId !== TEST_A_WORKER_ID) {
    throw new Error("Narration authority is restricted to the fixed TEST-A worker and job.");
  }
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", args.commandId))
    .unique();
  if (
    !command
    || command.jobId !== TEST_A_JOB_ID
    || command.action !== "generate_narration"
    || command.state !== "running"
    || command.claim?.workerId !== TEST_A_WORKER_ID
    || command.claim?.leaseToken !== args.leaseToken
    || !Number.isFinite(command.claim?.effectStartedAtMs)
    || !Number.isFinite(command.claim?.leaseExpiresAtMs)
    || command.claim.leaseExpiresAtMs <= Date.now()
  ) {
    throw new Error("Narration generate_narration claim authorization failed.");
  }
  const jobDocument = await context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", TEST_A_JOB_ID))
    .unique();
  const aggregate = jobDocument?.aggregate;
  if (
    !aggregate
    || aggregate.jobId !== TEST_A_JOB_ID
    || aggregate.schemaVersion !== "1.1"
    || aggregate.environment !== "test"
    || aggregate.product !== "announcement-page"
    || aggregate.narrationRequired !== true
    || aggregate.state !== "tts_generating"
    || !REVISION_ID.test(aggregate.currentRevisionId || "")
    || aggregate.version !== command.expectedVersion + 1
    || command.expectedState !== "tts_queued"
    || !exactObject(command.payload, ["artifactManifestDigest", "revisionId"])
    || command.payload.revisionId !== aggregate.currentRevisionId
  ) {
    throw new Error("Narration command does not bind the exact TEST-A tts transition.");
  }
  const preparedBundle = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "prepared_bundle" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  const privateReview = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "private_review" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  await assertPreparedBundle(preparedBundle, privateReview, aggregate.currentRevisionId);
  if (command.payload.artifactManifestDigest !== await canonicalManifestDigest(preparedBundle)) {
    throw new Error("Narration command does not bind the canonical prepared-bundle manifest.");
  }
  await assertSignedContentApproval(context, aggregate, privateReview, preparedBundle);
  const attempt = assertActiveNarrationStage(aggregate, command, args.leaseToken);
  return { command, aggregate, jobDocument, preparedBundle, attempt };
}

function assertActiveNarrationStage(aggregate, command, leaseToken) {
  const active = (aggregate.stageAttempts || []).filter((attempt) => (
    attempt?.stage === "generate_tts"
    && attempt?.status === "running"
    && attempt?.revisionId === aggregate.currentRevisionId
  ));
  const attempt = active[0];
  const expiry = Date.parse(attempt?.leaseExpiresAt || "");
  const effectStarted = Date.parse(attempt?.effectStartedAt || "");
  if (
    active.length !== 1
    || attempt.operationsCommandId !== command.commandId
    || typeof attempt.leaseToken !== "string"
    || attempt.leaseToken.length < 8
    || !Number.isFinite(expiry)
    || new Date(expiry).toISOString() !== attempt.leaseExpiresAt
    || expiry <= Date.now()
    || !Number.isFinite(effectStarted)
    || new Date(effectStarted).toISOString() !== attempt.effectStartedAt
    || command.claim?.leaseToken !== leaseToken
    || attempt.leaseToken !== leaseToken
  ) {
    throw new Error("Narration active stage does not match the exact command effect fence.");
  }
  return attempt;
}

async function assertCompletedNarrationAuthority(context, args) {
  assertNarrationWorkerToken(args.workerToken);
  if (args.jobId !== TEST_A_JOB_ID || args.workerId !== TEST_A_WORKER_ID) return null;
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", args.commandId))
    .unique();
  const jobDocument = await context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", TEST_A_JOB_ID))
    .unique();
  const aggregate = jobDocument?.aggregate;
  if (
    !command
    || command.jobId !== TEST_A_JOB_ID
    || command.action !== "generate_narration"
    || command.state !== "completed"
    || !aggregate
    || aggregate.jobId !== TEST_A_JOB_ID
    || aggregate.schemaVersion !== "1.1"
    || aggregate.environment !== "test"
    || aggregate.product !== "announcement-page"
    || aggregate.narrationRequired !== true
    || aggregate.state !== "narration_review_required"
    || aggregate.version < command.expectedVersion + 2
    || command.expectedState !== "tts_queued"
    || !exactObject(command.payload, ["artifactManifestDigest", "revisionId"])
    || aggregate.currentRevisionId !== command.payload.revisionId
  ) return null;
  const preparedBundle = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "prepared_bundle" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  const privateReview = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "private_review" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  const narration = findNarrationReviewArtifactSet(aggregate, aggregate.currentRevisionId);
  if (
    !preparedBundle
    || !narration
    || narration.operationsCommandId !== command.commandId
    || narration.revisionId !== aggregate.currentRevisionId
    || narration.sourcePreparedBundleManifestDigest !== preparedBundle.assetManifestDigest
    || command.payload.artifactManifestDigest !== await canonicalManifestDigest(preparedBundle)
    || !sameCompletedNarrationOutcome(command.outcome, aggregate, narration)
  ) return null;
  await assertPreparedBundle(preparedBundle, privateReview, aggregate.currentRevisionId);
  await assertSignedContentApproval(context, aggregate, privateReview, preparedBundle);
  const attempt = completedNarrationAttempt(aggregate, command, narration);
  if (!attempt || !await hasExactNarrationCompletionEvent(aggregate, attempt, args, narration)) return null;
  return { command, aggregate, jobDocument, preparedBundle, attempt };
}

async function findNarrationActionCompletionAuthority(context, args) {
  const completed = await assertCompletedNarrationAuthority(context, args);
  if (completed) return completed;

  assertNarrationWorkerToken(args.workerToken);
  if (args.jobId !== TEST_A_JOB_ID || args.workerId !== TEST_A_WORKER_ID) {
    throw new Error("Narration action completion authority is restricted to the fixed TEST-A worker and job.");
  }
  const command = await context.db
    .query("customerFlowOperationsCommands")
    .withIndex("by_command_id", (query) => query.eq("commandId", args.commandId))
    .unique();
  const jobDocument = await context.db
    .query("fulfillmentJobs")
    .withIndex("by_job_id", (query) => query.eq("jobId", TEST_A_JOB_ID))
    .unique();
  const aggregate = jobDocument?.aggregate;
  if (
    !command
    || command.jobId !== TEST_A_JOB_ID
    || command.action !== "generate_narration"
    || command.state !== "running"
    || command.claim?.workerId !== TEST_A_WORKER_ID
    || command.claim?.leaseToken !== args.leaseToken
    || !Number.isFinite(command.claim?.effectStartedAtMs)
    || !Number.isFinite(command.claim?.leaseExpiresAtMs)
    || command.claim.leaseExpiresAtMs <= Date.now()
    || !aggregate
    || aggregate.jobId !== TEST_A_JOB_ID
    || aggregate.schemaVersion !== "1.1"
    || aggregate.environment !== "test"
    || aggregate.product !== "announcement-page"
    || aggregate.narrationRequired !== true
    || aggregate.state !== "narration_review_required"
    || aggregate.version !== command.expectedVersion + 2
    || command.expectedState !== "tts_queued"
    || !exactObject(command.payload, ["artifactManifestDigest", "revisionId"])
    || aggregate.currentRevisionId !== command.payload.revisionId
  ) {
    throw new Error("Narration action completion does not bind the active command and terminal aggregate.");
  }
  const preparedBundle = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "prepared_bundle" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  const privateReview = [...(aggregate.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "private_review" && artifactSet.revisionId === aggregate.currentRevisionId
  ));
  const narration = findNarrationReviewArtifactSet(aggregate, aggregate.currentRevisionId);
  if (
    !preparedBundle
    || !narration
    || narration.operationsCommandId !== command.commandId
    || narration.revisionId !== aggregate.currentRevisionId
    || narration.sourcePreparedBundleManifestDigest !== preparedBundle.assetManifestDigest
    || command.payload.artifactManifestDigest !== await canonicalManifestDigest(preparedBundle)
  ) {
    throw new Error("Narration action completion provenance is invalid.");
  }
  await assertPreparedBundle(preparedBundle, privateReview, aggregate.currentRevisionId);
  await assertSignedContentApproval(context, aggregate, privateReview, preparedBundle);
  const attempt = completedNarrationAttempt(aggregate, command, narration);
  if (!attempt || !await hasExactNarrationCompletionEvent(aggregate, attempt, args, narration)) {
    throw new Error("Narration action completion event is invalid.");
  }
  return { command, aggregate, jobDocument, preparedBundle, attempt };
}

function sameCompletedNarrationOutcome(outcome, aggregate, narration) {
  return exactObject(outcome, ["artifactSetId", "code", "jobVersion", "revisionId"])
    && outcome.code === "narration_prepared"
    && outcome.jobVersion === aggregate.version
    && outcome.revisionId === aggregate.currentRevisionId
    && outcome.artifactSetId === narration.artifactSetId;
}

function completedNarrationAttempt(aggregate, command, narration) {
  const attempts = (aggregate.stageAttempts || []).filter((attempt) => (
    attempt?.stage === "generate_tts"
    && attempt?.status === "completed"
    && attempt?.revisionId === aggregate.currentRevisionId
    && attempt?.attemptId === narration.sourceRunId
    && attempt?.operationsCommandId === command.commandId
    && attempt.leaseToken === null
    && attempt.leaseExpiresAt === null
    && typeof attempt.completedAt === "string"
    && Number.isFinite(Date.parse(attempt.completedAt))
    && new Date(Date.parse(attempt.completedAt)).toISOString() === attempt.completedAt
  ));
  return attempts.length === 1 ? attempts[0] : null;
}

async function hasExactNarrationCompletionEvent(aggregate, attempt, args, narration) {
  const completion = {
    commandId: `complete:${attempt.attemptId}`,
    stage: "generate_tts",
    leaseToken: args.leaseToken,
    result: {
      artifactSet: {
        ...publicNarrationArtifactSet(narration),
        sourceRunId: attempt.attemptId,
        operationsCommandId: attempt.operationsCommandId,
      },
    },
  };
  const commandDigest = await stageCompletionDigest(completion);
  const events = (aggregate.events || []).filter((event) => (
    event?.commandId === completion.commandId
    && event?.type === "stage_completed"
    && event?.state === "narration_review_required"
    && event?.commandDigest === commandDigest
  ));
  return events.length === 1;
}

async function completeNarrationStage(aggregate, attempt, args, preparedBundle) {
  const at = new Date().toISOString();
  if (Date.parse(at) >= Date.parse(attempt.leaseExpiresAt)) {
    throw new Error("Stage completion lease expired before output could be committed.");
  }
  const artifactSet = await normalizeNarrationArtifactSet(aggregate, attempt, args.artifactSet, preparedBundle);
  const completion = {
    commandId: `complete:${attempt.attemptId}`,
    stage: "generate_tts",
    leaseToken: args.leaseToken,
    result: {
      artifactSet: {
        ...args.artifactSet,
        sourceRunId: attempt.attemptId,
        operationsCommandId: attempt.operationsCommandId,
      },
    },
  };
  const commandDigest = await stageCompletionDigest(completion);
  if ((aggregate.events || []).some((event) => event.commandId === completion.commandId)) {
    throw new Error("Narration stage completion already exists without a committed narration artifact.");
  }
  const next = structuredClone(aggregate);
  next.artifactSets.push(artifactSet);
  const attemptIndex = next.stageAttempts.findIndex((entry) => entry.attemptId === attempt.attemptId);
  if (attemptIndex < 0) throw new Error("Narration stage attempt is missing.");
  next.stageAttempts[attemptIndex] = {
    ...next.stageAttempts[attemptIndex],
    status: "completed",
    completedAt: at,
    leaseToken: null,
    leaseExpiresAt: null,
    failure: null,
  };
  next.state = "narration_review_required";
  next.version += 1;
  next.updatedAt = at;
  next.events.push({
    eventId: await digestId("event", next.jobId, completion.commandId),
    commandId: completion.commandId,
    commandDigest,
    type: "stage_completed",
    at,
    state: next.state,
  });
  return next;
}

async function normalizeNarrationArtifactSet(aggregate, attempt, artifactSet, preparedBundle) {
  const normalized = {
    artifactSetId: await digestId(
      "artifacts",
      aggregate.jobId,
      artifactSet.revisionId,
      artifactSet.kind,
      artifactSet.pageDigest,
      artifactSet.transcriptDigest,
      artifactSet.assetManifestDigest,
    ),
    kind: "narration_review",
    revisionId: artifactSet.revisionId,
    sourceRunId: attempt.attemptId,
    operationsCommandId: attempt.operationsCommandId,
    pageDigest: artifactSet.pageDigest,
    transcriptDigest: artifactSet.transcriptDigest,
    assetManifestDigest: artifactSet.assetManifestDigest,
    manifestRef: artifactSet.manifestRef,
    files: artifactSet.files,
    sourcePreparedBundleManifestDigest: preparedBundle.assetManifestDigest,
  };
  if (aggregate.artifactSets.some((entry) => (
    entry.kind === normalized.kind && entry.revisionId === normalized.revisionId
  ))) {
    throw new Error("Narration review artifact set already exists for this revision.");
  }
  return normalized;
}

async function stageCompletionDigest(completion) {
  return sha256Hex(`stage_completed\0${canonicalJson(completion)}`);
}

async function digestId(prefix, ...parts) {
  return `${prefix}_${(await sha256Hex(parts.join("\0"))).slice(0, 24)}`;
}

async function assertPreparedBundle(preparedBundle, privateReview, revisionId) {
  if (
    !validArtifactSet(preparedBundle)
    || preparedBundle.kind !== "prepared_bundle"
    || preparedBundle.revisionId !== revisionId
    || preparedBundle.manifestRef !== `jobs/${TEST_A_JOB_ID}/revisions/${revisionId}/manifests/prepared_bundle.json`
    || !validArtifactSet(privateReview)
    || privateReview.kind !== "private_review"
    || privateReview.revisionId !== revisionId
    || typeof privateReview.sourceRunId !== "string"
    || privateReview.sourceRunId.length < 1
    || typeof privateReview.operationsCommandId !== "string"
    || privateReview.operationsCommandId.length < 1
    || preparedBundle.sourcePrivateReviewManifestDigest !== await canonicalManifestDigest(privateReview)
    || preparedBundle.pageDigest !== privateReview.pageDigest
    || preparedBundle.transcriptDigest !== privateReview.transcriptDigest
    || preparedBundle.files.length !== privateReview.files.length
    || preparedBundle.files.some((file) => !file.path.startsWith("deploy/"))
    || !samePromotionInventory(preparedBundle.files, privateReview.files)
  ) {
    throw new Error("Narration prepared bundle is not the immutable approved content promotion.");
  }
  await Promise.all([
    assertArtifactSetManifest(privateReview),
    assertArtifactSetManifest(preparedBundle),
  ]);
}

async function assertSignedContentApproval(context, aggregate, privateReview, preparedBundle) {
  const privateManifestDigest = await canonicalManifestDigest(privateReview);
  const preparedManifestDigest = await canonicalManifestDigest(preparedBundle);
  const reviewDecision = [...(aggregate.reviewDecisions || [])].reverse().find((decision) => (
    decision?.decisionType === "content"
    && decision?.outcome === "approved"
    && decision?.revisionId === aggregate.currentRevisionId
    && typeof decision.approvalId === "string"
  ));
  if (!reviewDecision || !sameDigests(reviewDecision.artifactDigests, privateReview, privateManifestDigest)) {
    throw new Error("Narration requires an exact approved human content review.");
  }
  const approvalDocument = await context.db
    .query("fulfillmentReviewApprovals")
    .withIndex("by_approval_id", (query) => query.eq("approvalId", reviewDecision.approvalId))
    .unique();
  const approval = approvalDocument?.approval;
  if (!approval || approvalDocument.approvalId !== reviewDecision.approvalId) {
    throw new Error("Narration persisted human content approval was not found.");
  }
  await assertApprovalSignature(approval);
  const completedRun = (aggregate.stageAttempts || []).find((attempt) => (
    attempt?.stage === "prepare_review"
    && attempt?.status === "completed"
    && attempt?.revisionId === aggregate.currentRevisionId
    && attempt?.attemptId === privateReview.sourceRunId
    && attempt?.operationsCommandId === privateReview.operationsCommandId
  ));
  const binding = approval.binding;
  if (
    approval.approvalId !== reviewDecision.approvalId
    || approval.decision?.decisionType !== "content"
    || approval.decision?.outcome !== "approved"
    || approval.decision?.revisionId !== aggregate.currentRevisionId
    || !sameDigests(approval.decision?.artifactDigests, privateReview, privateManifestDigest)
    || !completedRun
    || binding?.jobId !== TEST_A_JOB_ID
    || binding?.intakeDigest !== aggregate.intakeDigest
    || binding?.environment !== "test"
    || binding?.product !== "announcement-page"
    || binding?.revisionId !== aggregate.currentRevisionId
    || binding?.runId !== privateReview.sourceRunId
    || binding?.sourceRunId !== privateReview.sourceRunId
    || binding?.sourceCommandId !== privateReview.operationsCommandId
    || binding?.artifactManifestDigest !== privateManifestDigest
    || preparedBundle.sourcePrivateReviewManifestDigest !== privateManifestDigest
    || preparedManifestDigest !== preparedBundle.assetManifestDigest
  ) {
    throw new Error("Narration content approval does not bind the exact source run and canonical manifests.");
  }
}

async function assertApprovalSignature(approval) {
  if (
    !approval
    || typeof approval !== "object"
    || Array.isArray(approval)
    || !exactObject(approval, ["approvalId", "binding", "decision", "schemaVersion", "signature"])
    || approval.schemaVersion !== "1.0"
    || !/^approval_[a-f0-9]{24}$/u.test(approval.approvalId || "")
    || typeof approval.signature !== "string"
    || !DIGEST.test(approval.signature)
  ) {
    throw new Error("Narration persisted human content approval is invalid.");
  }
  const key = process.env.BEBEBONJOUR_APPROVAL_HMAC_KEY;
  if (typeof key !== "string" || new TextEncoder().encode(key).byteLength < 32) {
    throw new Error("Narration review approval verification key is unavailable.");
  }
  const signed = {
    schemaVersion: approval.schemaVersion,
    approvalId: approval.approvalId,
    binding: approval.binding,
    decision: approval.decision,
  };
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(canonicalJson(signed)),
  );
  if (hex(signature) !== approval.signature) {
    throw new Error("Narration persisted human content approval signature verification failed.");
  }
}

async function assertNarrationReviewArtifactSet(context, jobId, value, preparedBundle) {
  const keys = [
    "assetManifestDigest",
    "files",
    "kind",
    "manifestRef",
    "pageDigest",
    "revisionId",
    "sourcePreparedBundleManifestDigest",
    "transcriptDigest",
  ];
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactObject(value, keys)
    || value.kind !== "narration_review"
    || value.revisionId !== preparedBundle.revisionId
    || value.manifestRef !== `jobs/${jobId}/revisions/${value.revisionId}/manifests/narration_review.json`
    || value.sourcePreparedBundleManifestDigest !== await canonicalManifestDigest(preparedBundle)
    || value.pageDigest !== preparedBundle.pageDigest
    || value.transcriptDigest !== preparedBundle.transcriptDigest
    || !validFiles(value.files)
  ) {
    throw new Error("Narration review artifact set is invalid or does not bind the immutable prepared bundle.");
  }
  await assertArtifactSetManifest(value);
  await assertArtifactBlobs(context, value.files);
}

async function assertAggregateNarrationReviewArtifactSet(context, jobId, value, preparedBundle) {
  if (
    typeof value?.artifactSetId !== "string"
    || value.artifactSetId.length < 1
    || typeof value?.sourceRunId !== "string"
    || value.sourceRunId.length < 1
    || typeof value?.operationsCommandId !== "string"
    || value.operationsCommandId.length < 1
  ) {
    throw new Error("Narration aggregate artifact provenance is invalid.");
  }
  await assertNarrationReviewArtifactSet(context, jobId, publicNarrationArtifactSet(value), preparedBundle);
}

function validArtifactSet(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.kind === "string"
    && REVISION_ID.test(value.revisionId || "")
    && typeof value.manifestRef === "string"
    && DIGEST.test(value.pageDigest || "")
    && DIGEST.test(value.transcriptDigest || "")
    && DIGEST.test(value.assetManifestDigest || "")
    && validFiles(value.files);
}

function validFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) return false;
  let totalBytes = 0;
  const paths = new Set();
  for (const file of files) {
    if (!validFile(file) || paths.has(file.path)) return false;
    paths.add(file.path);
    totalBytes += file.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) return false;
  }
  return true;
}

function validFile(file) {
  return file
    && typeof file === "object"
    && !Array.isArray(file)
    && exactObject(file, ["bytes", "path", "sha256", "storageId"])
    && safeRelativePath(file.path)
    && Number.isInteger(file.bytes)
    && file.bytes >= 0
    && file.bytes <= MAX_FILE_BYTES
    && DIGEST.test(file.sha256 || "")
    && typeof file.storageId === "string"
    && file.storageId.trim() !== "";
}

function validUploadIntent(file) {
  return file
    && typeof file === "object"
    && !Array.isArray(file)
    && exactObject(file, ["bytes", "path", "sha256"])
    && safeRelativePath(file.path)
    && Number.isInteger(file.bytes)
    && file.bytes >= 0
    && file.bytes <= MAX_FILE_BYTES
    && DIGEST.test(file.sha256 || "");
}

function uploadIntent(file) {
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

async function assertArtifactBlobs(context, files) {
  for (const file of files) {
    const storageId = context.db.system.normalizeId("_storage", file.storageId);
    const metadata = storageId ? await context.db.system.get(storageId) : null;
    if (!metadata || metadata.size !== file.bytes || !metadataDigestMatches(metadata.sha256, file.sha256)) {
      throw new Error("Narration artifact blob does not match its declared integrity metadata.");
    }
  }
}

async function assertArtifactSetManifest(artifactSet) {
  if (artifactSet.assetManifestDigest !== await canonicalManifestDigest(artifactSet)) {
    throw new Error("Narration artifact manifest digest does not match its canonical inventory.");
  }
}

async function canonicalManifestDigest(artifactSet) {
  return sha256Hex(`${JSON.stringify({
    schemaVersion: "1.0",
    kind: artifactSet.kind,
    revisionId: artifactSet.revisionId,
    files: normalizeInventory(artifactSet.files),
  }, null, 2)}\n`);
}

function normalizeInventory(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => ({
    path: file.path,
    storageId: file.storageId,
    bytes: file.bytes,
    sha256: file.sha256,
  })).sort((left, right) => compareCodePointStrings(left.path, right.path));
}

function samePromotionInventory(prepared, privateReview) {
  const privatePaths = privateReview.map((file) => {
    const segments = file.path.split("/");
    return { ...file, path: `deploy/${segments.slice(2).join("/")}` };
  });
  return canonicalJson(normalizeInventory(prepared)) === canonicalJson(normalizeInventory(privatePaths));
}

function sameDigests(digests, artifactSet, canonicalDigest) {
  return digests?.pageDigest === artifactSet?.pageDigest
    && digests?.transcriptDigest === artifactSet?.transcriptDigest
    && digests?.assetManifestDigest === canonicalDigest;
}

async function collectLiveNarrationUploadGrants(context, jobId, revisionId, nowMs) {
  const grants = await context.db
    .query("fulfillmentNarrationUploadGrants")
    .withIndex("by_job_revision", (query) => query.eq("jobId", jobId).eq("revisionId", revisionId))
    .collect();
  const expired = grants.filter((grant) => grant.consumedAtMs === null && grant.expiresAtMs <= nowMs)
    .sort((left, right) => compareCodePointStrings(left.grantId, right.grantId));
  for (const grant of expired) await context.db.delete(grant._id);
  return {
    deleted: expired.length,
    liveGrants: grants.filter((grant) => grant.consumedAtMs === null && grant.expiresAtMs > nowMs),
  };
}

async function assertAndConsumeUploadGrants(context, args, command, preparedBundle, files) {
  if (!Array.isArray(args.uploadGrantIds)
    || args.uploadGrantIds.length !== files.length
    || new Set(args.uploadGrantIds).size !== args.uploadGrantIds.length
    || args.uploadGrantIds.some((grantId) => !GRANT_ID.test(grantId))) {
    throw new Error("Narration upload grants do not match the committed file inventory.");
  }
  const nowMs = Date.now();
  const grants = await Promise.all(args.uploadGrantIds.map((grantId) => context.db
    .query("fulfillmentNarrationUploadGrants")
    .withIndex("by_grant_id", (query) => query.eq("grantId", grantId))
    .unique()));
  const expectedByPath = new Map(files.map((file) => [file.path, uploadIntent(file)]));
  for (const grant of grants) {
    if (!grant) throw new Error("Narration upload grant was not found.");
    if (grant.expiresAtMs <= nowMs) throw new Error("Narration upload grant has expired.");
    if (grant.consumedAtMs !== null) throw new Error("Narration upload grant was already consumed.");
    const expected = expectedByPath.get(grant.expectedFile?.path);
    if (
      grant.jobId !== args.jobId
      || grant.revisionId !== preparedBundle.revisionId
      || grant.commandId !== command.commandId
      || grant.leaseToken !== args.leaseToken
      || !expected
      || grant.scopeKey !== await uploadGrantScope(args, preparedBundle.revisionId, expected)
      || canonicalJson(grant.expectedFile) !== canonicalJson(expected)
    ) {
      throw new Error("Narration upload grant does not bind the committed file inventory.");
    }
  }
  for (const grant of grants) {
    const file = files.find((entry) => entry.path === grant.expectedFile.path);
    await context.db.patch(grant._id, { consumedAtMs: nowMs, storageId: file.storageId });
  }
}

async function uploadGrantScope(args, revisionId, expectedFile) {
  return sha256Hex(canonicalJson({
    jobId: args.jobId,
    revisionId,
    commandId: args.commandId,
    leaseToken: args.leaseToken,
    expectedFile: uploadIntent(expectedFile),
  }));
}

function findNarrationReviewArtifactSet(aggregate, revisionId) {
  return [...(aggregate?.artifactSets || [])].reverse().find((artifactSet) => (
    artifactSet?.kind === "narration_review" && artifactSet.revisionId === revisionId
  )) || null;
}

function sameNarrationArtifactSet(existing, candidate) {
  return canonicalJson(publicNarrationArtifactSet(existing)) === canonicalJson(candidate);
}

function publicNarrationArtifactSet(artifactSet) {
  return {
    kind: artifactSet.kind,
    revisionId: artifactSet.revisionId,
    pageDigest: artifactSet.pageDigest,
    transcriptDigest: artifactSet.transcriptDigest,
    assetManifestDigest: artifactSet.assetManifestDigest,
    sourcePreparedBundleManifestDigest: artifactSet.sourcePreparedBundleManifestDigest,
    manifestRef: artifactSet.manifestRef,
    files: artifactSet.files,
  };
}

function assertNarrationWorkerToken(value) {
  const expected = process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN;
  const disallowed = [
    process.env.BEBEBONJOUR_OPERATIONS_TOKEN,
    process.env.BEBEBONJOUR_OPERATIONS_WORKER_TOKEN,
    process.env.BEBEBONJOUR_COMPLETION_WORKER_TOKEN,
    process.env.CUSTOMER_FLOW_BACKEND_TOKEN,
  ];
  if (!expected || expected.length < 32 || value !== expected || disallowed.includes(value)) {
    throw new Error("Narration worker authorization failed.");
  }
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function sha256Hex(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(digest);
}

function hex(value) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metadataDigestMatches(metadataDigest, expectedHexDigest) {
  if (metadataDigest === expectedHexDigest) return true;
  const bytes = expectedHexDigest.match(/.{2}/gu)?.map((pair) => Number.parseInt(pair, 16));
  return Boolean(bytes) && metadataDigest === globalThis.btoa(String.fromCharCode(...bytes));
}

function assertUploadedArtifactBlobs(context, files) {
  for (const file of files) {
    const storageId = context.db.system.normalizeId("_storage", file.storageId);
    const metadata = storageId ? context.db.system.get(storageId) : null;
    if (!metadata || metadata.size !== file.bytes || !metadataDigestMatches(metadata.sha256, file.sha256)) {
      throw new Error("Narration artifact blob does not match its declared integrity metadata.");
    }
  }
}

function compareCodePointStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  throw new Error("Narration review values must contain deterministic JSON only.");
}
