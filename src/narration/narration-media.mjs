import { createHash } from "node:crypto";
import { MPEGDecoder } from "mpg123-decoder";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_NARRATION_SECONDS = 180;
const MAX_SEGMENT_CHARACTERS = 4_000;
const SHA256 = /^[a-f0-9]{64}$/u;

export const CEDAR_NARRATION_INSTRUCTIONS =
  "Speak in an intimate, warm male voice, with natural family joy. Use gentle, sincere, relaxed pacing with natural pauses; never sound robotic, theatrical, or like an announcer. Pronounce the supplied French or Arabic text faithfully. Do not add, omit, or rewrite words.";

const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function readBoundedResponse(response, maximumBytes, signal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("empty_response");

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
    if (size === 0) throw new Error("empty_response");
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestSpeech({
  apiKey,
  text,
  idempotencyKey,
  signal,
  fetch: fetchImpl = globalThis.fetch,
}) {
  if (
    typeof apiKey !== "string" ||
    Buffer.byteLength(apiKey, "utf8") < 32 ||
    typeof text !== "string" ||
    text !== text.trim() ||
    !text ||
    text.length > MAX_SEGMENT_CHARACTERS ||
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u.test(idempotencyKey) ||
    !signal ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error("tts_input_invalid");
  }

  try {
    const response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: ["Bearer", apiKey].join(" "),
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        input: text,
        response_format: "mp3",
        instructions: CEDAR_NARRATION_INSTRUCTIONS,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("tts_provider_rejected");
    }
    const contentType = response.headers.get("content-type");
    if (
      contentType &&
      !["audio/mpeg", "audio/mp3", "application/octet-stream"].some((value) =>
        contentType.toLowerCase().startsWith(value),
      )
    ) {
      await response.body?.cancel();
      throw new Error("tts_response_invalid");
    }
    return await readBoundedResponse(response, MAX_AUDIO_BYTES, signal);
  } catch (error) {
    const reason =
      error?.message === "tts_provider_rejected"
        ? "tts_provider_rejected"
        : signal.aborted
          ? "tts_timeout"
          : ["response_too_large", "empty_response", "tts_response_invalid"].includes(
                error?.message,
              )
            ? "tts_response_invalid"
            : "tts_transport_failed";
    throw new Error(reason);
  }
}

export async function decodeMp3Duration(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 || bytes.length > MAX_AUDIO_BYTES) {
    throw new Error("invalid_audio");
  }
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    let samples = 0;
    let sampleRate = 0;
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
      const decoded = decoder.decode(bytes.subarray(offset, offset + 8_192));
      if (
        decoded.errors.length > 0 ||
        (sampleRate && decoded.sampleRate && sampleRate !== decoded.sampleRate)
      ) {
        throw new Error("invalid_audio");
      }
      samples += decoded.samplesDecoded;
      sampleRate = decoded.sampleRate || sampleRate;
      if (sampleRate && samples / sampleRate > MAX_NARRATION_SECONDS) {
        throw new Error("invalid_audio");
      }
    }
    const durationSeconds = samples / sampleRate;
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds < 0.1 ||
      durationSeconds > MAX_NARRATION_SECONDS
    ) {
      throw new Error("invalid_audio");
    }
    return durationSeconds;
  } catch {
    throw new Error("invalid_audio");
  } finally {
    decoder.free();
  }
}

export function narrationSegments({ jobId, prepared, page }) {
  if (
    !prepared ||
    prepared.kind !== "prepared_bundle" ||
    typeof prepared.revisionId !== "string" ||
    !prepared.revisionId ||
    !SHA256.test(prepared.pageDigest || "") ||
    !SHA256.test(prepared.transcriptDigest || "") ||
    !SHA256.test(prepared.assetManifestDigest || "") ||
    !SHA256.test(prepared.sourcePrivateReviewManifestDigest || "") ||
    prepared.manifestRef !==
      `jobs/${jobId}/revisions/${prepared.revisionId}/manifests/prepared_bundle.json` ||
    !Array.isArray(prepared.files) ||
    !prepared.files.some(
      (file) =>
        file.path === "artifacts/current/page.json" &&
        file.sha256 === prepared.pageDigest,
    )
  ) {
    throw new Error("approved_prepared_binding_invalid");
  }
  if (
    !page ||
    (page.jobId !== undefined && page.jobId !== jobId) ||
    page.pageRevision !== prepared.revisionId
  ) {
    throw new Error("approved_page_binding_invalid");
  }
  if (
    !Array.isArray(page.languages) ||
    page.languages.length < 1 ||
    page.languages.length > 2 ||
    new Set(page.languages).size !== page.languages.length ||
    page.languages.some((language) => !["fr", "ar"].includes(language)) ||
    !Array.isArray(page.sectionOrder) ||
    page.sectionOrder.length < 1 ||
    page.sectionOrder.length > 6 ||
    new Set(page.sectionOrder).size !== page.sectionOrder.length
  ) {
    throw new Error("approved_page_invalid");
  }

  return page.languages.flatMap((language) =>
    page.sectionOrder.map((section) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/u.test(section)) {
        throw new Error("approved_section_invalid");
      }
      const rawText = page.sections?.[section]?.[language]?.narrationText;
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (
        !text ||
        text !== rawText ||
        text.length > MAX_SEGMENT_CHARACTERS
      ) {
        throw new Error("approved_narration_text_missing");
      }
      return { language, section, text };
    }),
  );
}

export async function generateNarration({
  jobId,
  prepared,
  page,
  apiKey,
  idempotencyKey,
  signal,
  upload,
  fetch,
}) {
  if (
    !/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(jobId || "") ||
    typeof upload !== "function"
  ) {
    throw new Error("narration_input_invalid");
  }
  const segments = narrationSegments({ jobId, prepared, page });
  const files = prepared.files.map((file) => ({ ...file }));
  const tracks = {};
  const clips = [];
  const starts = {};
  let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  async function store(path, bytes, contentType) {
    signal.throwIfAborted();
    totalBytes += bytes.length;
    if (bytes.length < 1 || totalBytes > MAX_ARTIFACT_BYTES) {
      throw new Error("narration_too_large");
    }
    const storageId = await upload(path, bytes, contentType);
    if (typeof storageId !== "string" || !storageId) {
      throw new Error("durable_upload_receipt_invalid");
    }
    files.push({
      path,
      storageId,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  for (const { language, section, text } of segments) {
    const bytes = await requestSpeech({
      apiKey,
      text,
      idempotencyKey: `${idempotencyKey}-${language}-${section}`,
      signal,
      fetch,
    });
    const durationSeconds = await decodeMp3Duration(bytes);
    const path = `artifacts/audio/${language}/${section}.mp3`;
    await store(path, bytes, "audio/mpeg");
    const seconds = starts[language] || 0;
    const roundedSeconds = Math.floor(seconds);
    (tracks[language] ??= []).push({
      section,
      text,
      seconds,
      time: `${String(Math.floor(roundedSeconds / 60)).padStart(2, "0")}:${String(roundedSeconds % 60).padStart(2, "0")}`,
    });
    starts[language] = seconds + durationSeconds;
    clips.push({ language, section, path, durationSeconds });
  }

  const transcript = Buffer.from(
    `${JSON.stringify({ version: 1, tracks }, null, 2)}\n`,
  );
  await store("artifacts/transcript.json", transcript, "application/json");
  const review = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        jobId,
        revisionId: prepared.revisionId,
        preparedManifestDigest: prepared.assetManifestDigest,
        sourcePrivateReviewManifestDigest:
          prepared.sourcePrivateReviewManifestDigest,
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        aiGenerated: true,
        clips,
      },
      null,
      2,
    )}\n`,
  );
  await store("artifacts/narration-review.json", review, "application/json");
  files.sort((left, right) => left.path.localeCompare(right.path));

  const kind = "narration_review";
  return {
    kind,
    revisionId: prepared.revisionId,
    pageDigest: prepared.pageDigest,
    transcriptDigest: sha256(transcript),
    sourcePreparedBundleManifestDigest: prepared.assetManifestDigest,
    assetManifestDigest: sha256(
      `${JSON.stringify(
        {
          schemaVersion: "1.0",
          kind,
          revisionId: prepared.revisionId,
          files: files.map(({ path, storageId, bytes, sha256: digest }) => ({
            path,
            storageId,
            bytes,
            sha256: digest,
          })),
        },
        null,
        2,
      )}\n`,
    ),
    manifestRef: `jobs/${jobId}/revisions/${prepared.revisionId}/manifests/${kind}.json`,
    files,
  };
}
