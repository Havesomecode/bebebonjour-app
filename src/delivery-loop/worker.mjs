import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexSubscriptionComposer } from "../fulfillment/codex-subscription-composer.mjs";
import { assertValidCodexCompositionReceipt, buildCodexCompositionRequest, sha256 } from "../../scripts/lib/codex-subscription-composition.mjs";
import { buildAnnouncementChapters } from "./chapters.mjs";
import { renderAnnouncement } from "./render.mjs";
import { chapterNarrationText, splitNarrationPhrases, validPhraseStarts } from "./narration-timing.mjs";
import { performNarration, checkVoiceReady } from "./provider-transport.mjs";

const STAGES = new Set(["generate", "draft_email", "final_email"]);
const DEFAULT_STATE_DIR = "/home/hermes/.local/share/bebebonjour-delivery-loop";
const COMPOSER_REASONS = new Set(["composition_configuration_rejected", "composition_cancelled", "composition_timeout", "composition_output_rejected", "composition_provider_failed", "composition_provider_unavailable", "composition_auth_restore_failed", "composition_auth_writeback_failed"]);

export class DeliveryLoopWorkerError extends Error {
  constructor(reasonCode, retryable = false) {
    super(reasonCode);
    this.name = "DeliveryLoopWorkerError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}
const reject = (reason, retryable = false) => { throw new DeliveryLoopWorkerError(reason, retryable); };

export function createDeliveryLoopWorker(options = {}) {
  const { client } = options;
  if (!client || ["query", "mutation", "action"].some((method) => typeof client[method] !== "function")) reject("worker_configuration_rejected");
  const environment = options.environment ?? process.env;
  const workerToken = options.workerToken ?? environment.BEBEBONJOUR_DELIVERY_LOOP_TOKEN;
  const workerId = options.workerId ?? environment.BEBEBONJOUR_DELIVERY_LOOP_WORKER_ID ?? "bebe-delivery-loop";
  const stateDir = options.stateDir ?? environment.BEBEBONJOUR_DELIVERY_LOOP_STATE_DIR ?? DEFAULT_STATE_DIR;
  if (typeof workerToken !== "string" || !workerToken || typeof workerId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(workerId) || typeof stateDir !== "string" || !path.isAbsolute(stateDir) || path.normalize(stateDir) !== stateDir || stateDir === "/") reject("worker_configuration_rejected");
  const compositionTimeoutMs = bounded(options.compositionTimeoutMs ?? Number(environment.BEBEBONJOUR_COMPOSITION_TIMEOUT_MS ?? 300_000), 10, 300_000);
  const providerTimeoutMs = bounded(options.providerTimeoutMs ?? 180_000, 10, 300_000);
  // VoxCPM2 speaks one phrase at a time on CPU: one language can take several minutes.
  const narrationTimeoutMs = bounded(options.narrationTimeoutMs ?? Number(environment.BEBEBONJOUR_NARRATION_TIMEOUT_MS ?? 600_000), 10, 840_000);
  const requestTimeoutMs = bounded(options.requestTimeoutMs ?? 30_000, 10, 60_000);
  const reconciliationAttempts = bounded(options.reconciliationAttempts ?? 3, 1, 5);
  const composer = options.composer ?? createCodexSubscriptionComposer({ model: environment.BEBEBONJOUR_COMPOSITION_MODEL ?? "gpt-5.6-sol", timeoutMs: compositionTimeoutMs, environment });
  if (typeof composer.compose !== "function") reject("worker_configuration_rejected");
  const now = options.now ?? Date.now;
  const voiceState = { ready: false, checkedAtMs: 0 };
  let voiceChecked = false;
  const recheckMs = bounded(Number(environment.BEBEBONJOUR_VOICE_READY_RECHECK_MS ?? 180_000), 1, 86_400_000);
  const logger = options.logger ?? ((event) => console.log(JSON.stringify(event)));
  if (typeof now !== "function" || typeof logger !== "function") reject("worker_configuration_rejected");
  const log = (event, job, extra = {}) => {
    // No exception text, claim/token, intake, prose, or provider bodies in logs.
    try { logger({ event, ...(job ? { jobId: job.jobId, revision: job.revision, stage: job.stage } : {}), ...extra }); } catch { /* logging must not cause effects to replay */ }
  };
  const invoke = (method, name, args, signal, timeout = requestTimeoutMs) => boundedCall(() => client[method](name, args), timeout, signal);
  const identity = (job) => ({ workerToken, jobId: job.jobId, leaseToken: job.leaseToken, revision: job.revision });
  const assertLease = (job, signal) => {
    if (signal?.aborted) reject("worker_cancelled", true);
    if (job.leaseExpiresAtMs <= now() + 1000) reject("stale_lease", true);
  };
  const readRemote = (job, signal) => invoke("query", "deliveryLoop:read", { workerToken, jobId: job.jobId }, signal);
  const peek = async (job, find, signal) => {
    let remote;
    try { remote = await readRemote(job, signal); } catch { reject("backend_readback_unavailable", true); }
    if (!remote) reject("backend_readback_unavailable", true);
    return find(remote);
  };
  const reconcile = async (job, find, signal) => {
    for (let attempt = 0; attempt < reconciliationAttempts; attempt++) {
      let remote;
      try { remote = await readRemote(job, signal); } catch { /* leave uncertain, never assume absence */ }
      if (remote) { const found = find(remote); if (found) return found; }
      if (attempt + 1 < reconciliationAttempts) {
        try { await delay(2000, undefined, { signal }); } catch { break; }
      }
    }
    return null;
  };

  async function generate(job, journal, signal) {
    assertLease(job, signal);
    let input;
    try {
      input = buildCodexCompositionRequest(job.brief).brief;
      if (job.orderMode === "paid_route_a" && input.religion !== "general") reject("composition_input_rejected");
    } catch { reject("composition_input_rejected"); }
    const inputDigest = sha256(JSON.stringify(input));
    if (journal.state.inputDigest && journal.state.inputDigest !== inputDigest) reject("journal_input_mismatch");
    journal.state.inputDigest = inputDigest;
    await journal.save();
    let receipt = await journal.receipt();
    if (!receipt) {
      // Abort the existing subprocess at the earlier of composer bound / lease.
      const deadline = AbortSignal.timeout(Math.max(1, Math.min(compositionTimeoutMs, job.leaseExpiresAtMs - now() - 1000)));
      const composeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      receipt = await composer.compose(input, { signal: composeSignal });
      validateReceipt(receipt, input);
      await journal.storeReceipt(receipt);
    }
    validateReceipt(receipt, input);
    // One phrase list for screens and speech: phraseStarts[i] is the start of screen i.
    const chapters = buildAnnouncementChapters({ composition: receipt.composition, brief: input });
    const audioFiles = [];
    const narrationEnabled = job.intake.voicePreference?.enabled !== false;
    for (const language of narrationEnabled ? input.languages : []) {
      assertLease(job, signal);
      const text = chapterNarrationText(chapters[language]);
      const phraseCount = splitNarrationPhrases(text).length;
      const textDigest = sha256(text);
      let audio = journal.state.audio[language];
      if (audio?.textDigest && audio.textDigest !== textDigest) reject("journal_narration_mismatch");
      if (audio?.status === "complete") {
        validateNarration(audio, textDigest, phraseCount);
      } else {
        const find = (remote) => findNarration(remote, job.revision, language, textDigest);
        const recovered = audio?.status ? await reconcile(job, find, signal) : await peek(job, find, signal);
        if (recovered) {
          audio = { status: "complete", storageId: recovered.storageId, textDigest, phraseStarts: recovered.phraseStarts };
        } else {
          if (audio?.status === "inflight" || audio?.status === "uncertain") reject("narration_reconciliation_required");
          assertLease(job, signal);
          let generated;
          try {
            generated = await boundedCall(() => (options.narrate ?? performNarration)({ text, textDigest, language, voice: job.intake.voicePreference?.voice ?? 'pere' }, environment), Math.min(narrationTimeoutMs, job.leaseExpiresAtMs - now() - 1000), signal);
          } catch { reject("voice_worker_unavailable", true); }
          assertLease(job, signal);
          journal.state.audio[language] = { status: "inflight", textDigest };
          await journal.save();
          try {
            const result = await invoke("action", "deliveryLoopProviders:narrate", { ...identity(job), language, text, textDigest, audioBase64: generated.audioBase64, audioDigest: generated.audioDigest, bytes: generated.bytes, phraseStarts: generated.phraseStarts, provider: generated.provider, model: generated.model, voice: generated.voice }, signal, Math.min(requestTimeoutMs, job.leaseExpiresAtMs - now() - 1000));
            validateNarration(result, textDigest, phraseCount);
            const committed = await reconcile(job, (remote) => findNarration(remote, job.revision, language, textDigest), signal);
            if (!committed || committed.storageId !== result.storageId || JSON.stringify(committed.phraseStarts) !== JSON.stringify(result.phraseStarts)) reject("narration_reconciliation_required");
            audio = { status: "complete", storageId: committed.storageId, textDigest, phraseStarts: committed.phraseStarts };
          } catch {
            const result = await reconcile(job, (remote) => findNarration(remote, job.revision, language, textDigest), signal);
            if (!result) {
              journal.state.audio[language].status = "uncertain";
              await journal.save();
              reject("narration_reconciliation_required");
            }
            audio = { status: "complete", storageId: result.storageId, textDigest, phraseStarts: result.phraseStarts };
          }
        }
        journal.state.audio[language] = audio;
        await journal.save();
      }
      validateNarration(audio, textDigest, phraseCount);
      audioFiles.push({ language, storageId: audio.storageId, textDigest, phraseStarts: audio.phraseStarts });
    }
    const contentHtml = renderAnnouncement({ chapters, languages: input.languages, publicUrl: job.publicUrl, revision: job.revision, pendingReview: true, narrationEnabled, phraseStarts: narrationEnabled ? Object.fromEntries(audioFiles.map(file => [file.language, file.phraseStarts])) : undefined });
    const contentDigest = sha256(contentHtml);
    if (journal.state.published?.contentDigest && journal.state.published.contentDigest !== contentDigest) reject("journal_publication_mismatch");
    const wasPublished = await peek(job, (remote) => findPublication(remote, job.revision, contentDigest), signal);
    if (!wasPublished) {
      assertLease(job, signal);
      journal.state.published = { status: "inflight", contentDigest };
      await journal.save();
      try {
        await invoke("mutation", "deliveryLoop:publish", { ...identity(job), contentHtml, composition: receipt.composition, compositionReceipt: receipt.metadata, compositionJson: JSON.stringify(receipt.composition), audioFiles, contentDigest }, signal);
      } catch {
        const found = await reconcile(job, (remote) => findPublication(remote, job.revision, contentDigest), signal);
        if (!found) reject("publication_transport_failed", true);
      }
      // Exact read-back, not a successful mutation response, establishes success.
      if (!await reconcile(job, (remote) => findPublication(remote, job.revision, contentDigest), signal)) reject("publication_readback_failed", true);
    }
    journal.state.published = { status: "complete", contentDigest };
    await journal.save();
    log("published", job, { contentDigest });
    // The next backend claim owns draft_email under a fresh lease.
    return { status: "published", jobId: job.jobId, revision: job.revision, contentDigest };
  }

  async function sendEmail(job, journal, signal) {
    assertLease(job, signal);
    const find = (remote) => findEmail(remote, job.revision, job.stage);
    const local = journal.state.emails[job.stage];
    let receipt = local?.status ? await reconcile(job, find, signal) : await peek(job, find, signal);
    if (!receipt && (local?.status || (job.effectStartedAtMs !== undefined && job.effectStartedAtMs !== null))) reject("email_reconciliation_required");
    if (!receipt) {
      assertLease(job, signal);
      journal.state.emails[job.stage] = { status: "inflight" };
      await journal.save();
      let reply;
      try {
        // The backend action fences the provider call and commits completeEmail.
        // Never invoke completeEmail here or automatically replay a timed-out call.
        reply = await invoke("action", "deliveryLoopProviders:sendEmail", { ...identity(job), stage: job.stage }, signal, Math.min(providerTimeoutMs, job.leaseExpiresAtMs - now() - 1000));
      } catch { /* reconcile exact backend receipt rather than retry provider */ }
      receipt = await reconcile(job, find, signal);
      if (!receipt || (reply?.providerMessageId && receipt.providerMessageId !== reply.providerMessageId)) {
        journal.state.emails[job.stage] = { status: "uncertain", ...(typeof reply?.providerMessageId === "string" ? { providerMessageId: reply.providerMessageId } : {}) };
        await journal.save();
        reject("email_reconciliation_required");
      }
    }
    if (local?.providerMessageId && receipt.providerMessageId !== local.providerMessageId) reject("email_receipt_mismatch");
    journal.state.emails[job.stage] = { status: "complete", providerMessageId: receipt.providerMessageId };
    await journal.save();
    log("email_sent", job, { providerMessageId: receipt.providerMessageId });
    return { status: "email_sent", jobId: job.jobId, revision: job.revision, providerMessageId: receipt.providerMessageId };
  }

  async function runOnce({ signal } = {}) {
    if (signal?.aborted) return { status: "cancelled" };
    await privateDirectory(stateDir);
    const release = await acquireLock(stateDir);
    if (!release) return { status: "busy" };
    let job;
    try {
      // Locally generated fencing token: never reused across claims.
      let claimed = await invoke("mutation", "deliveryLoop:claim", { workerToken, workerId, leaseToken: randomUUID(), voiceReady: voiceState.ready && now() - voiceState.checkedAtMs < 60_000 }, signal);
      if (claimed?.waitingForVoice) {
        if (!voiceChecked || now() - voiceState.checkedAtMs >= recheckMs) {
          voiceState.ready = await (options.checkVoiceReady ?? checkVoiceReady)(environment);
          voiceState.checkedAtMs = now();
          voiceChecked = true;
          if (voiceState.ready) {
            log("voice_ready");
            claimed = await invoke("mutation", "deliveryLoop:claim", { workerToken, workerId, leaseToken: randomUUID(), voiceReady: true }, signal);
          }
        }
        if (claimed?.waitingForVoice) { log("voice_wait"); return { status: "waiting_for_voice" }; }
      }
      if (!claimed) return { status: "idle" };
      validateClaim(claimed);
      job = claimed;
      log("claimed", job);
      const journal = await openJournal(stateDir, job);
      const result = job.stage === "generate" ? await generate(job, journal, signal) : await sendEmail(job, journal, signal);
      if (job.stage === "generate" && job.intake.voicePreference?.enabled !== false) { voiceState.ready = true; voiceState.checkedAtMs = now(); voiceChecked = true; }
      return result;
    } catch (error) {
      const { reasonCode, retryable } = safeFailure(error);
      if (reasonCode === "voice_worker_unavailable") { voiceState.ready = false; voiceState.checkedAtMs = now(); voiceChecked = true; }
      log("failed", job, { reason: reasonCode, retryable });
      if (job) {
        try {
          // Cleanup is bounded even when the caller's abort signal is cancelled.
          await invoke("mutation", "deliveryLoop:fail", { workerToken, jobId: job.jobId, leaseToken: job.leaseToken, reason: reasonCode, retryable }, undefined);
        } catch { log("failure_report_unavailable", job); }
      }
      return { status: "failed", ...(job ? { jobId: job.jobId, revision: job.revision } : {}), reason: reasonCode, retryable };
    } finally { await release(); }
  }

  async function run({ once = false, signal, pollIntervalMs = 5000, sleep = (ms, currentSignal) => delay(ms, undefined, { signal: currentSignal }) } = {}) {
    bounded(pollIntervalMs, 1, 60_000);
    if (once) return runOnce({ signal });
    while (!signal?.aborted) {
      try { await runOnce({ signal }); } catch { log("poll_failed"); }
      if (signal?.aborted) break;
      try { await sleep(pollIntervalMs, signal); } catch { if (!signal?.aborted) log("poll_wait_failed"); else break; }
    }
    return { status: "stopped" };
  }
  return Object.freeze({ runOnce, run });
}

function validateClaim(job) {
  if (!job || typeof job.jobId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(job.jobId) || !Number.isSafeInteger(job.revision) || job.revision < 1 || !STAGES.has(job.stage) || typeof job.leaseToken !== "string" || !job.leaseToken || !Number.isSafeInteger(job.leaseExpiresAtMs)) reject("claim_rejected");
}
function validateReceipt(receipt, intake) {
  try {
    assertValidCodexCompositionReceipt(receipt);
    const expected = sha256(JSON.stringify({ adapterVersion: receipt.metadata.adapterVersion, provider: receipt.metadata.provider, model: receipt.metadata.model, request: buildCodexCompositionRequest(intake) }));
    if (receipt.metadata.requestDigest !== expected) throw new Error();
  } catch { reject("composition_receipt_rejected"); }
}
function validateNarration(receipt, digest, phraseCount = receipt?.phraseStarts?.length) {
  if (!receipt || typeof receipt.storageId !== "string" || !receipt.storageId || receipt.storageId.length > 256 || /[\u0000-\u0020\u007f/\\?#]/u.test(receipt.storageId) || receipt.textDigest !== digest || !validPhraseStarts(receipt.phraseStarts, phraseCount)) reject("narration_receipt_rejected");
}
function findNarration(remote, revision, language, digest) {
  const value = remote?.narrationReceipts?.find((receipt) => receipt.revision === revision && receipt.language === language && receipt.textDigest === digest);
  if (!value) return null;
  validateNarration(value, digest);
  return value;
}
function findPublication(remote, revision, digest) {
  const value = remote?.revisions?.find((entry) => entry.revision === revision);
  if (!value) return null;
  if (value.contentDigest !== digest) reject("publication_digest_conflict");
  return value;
}
function findEmail(remote, revision, stage) {
  const value = (remote?.emailReceipts ?? remote?.emails)?.find((entry) => entry.revision === revision && entry.stage === stage);
  if (!value || typeof value.providerMessageId !== "string" || !/^[\x21-\x7e]{1,998}$/u.test(value.providerMessageId)) return null;
  return value;
}
function safeFailure(error) {
  if (error instanceof DeliveryLoopWorkerError) return error;
  if (COMPOSER_REASONS.has(error?.reasonCode)) return { reasonCode: error.reasonCode, retryable: error.retryable === true };
  return { reasonCode: "worker_operation_failed", retryable: true };
}
function bounded(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject("worker_configuration_rejected");
  return value;
}
async function boundedCall(operation, timeoutMs, signal) {
  if (signal?.aborted) reject("worker_cancelled", true);
  let timer;
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new DeliveryLoopWorkerError("backend_request_timeout", true)), Math.max(1, timeoutMs));
        abort = () => rejectPromise(new DeliveryLoopWorkerError("worker_cancelled", true));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

async function privateDirectory(directory) {
  // Reject symlink ancestors as well as the leaf. Existing directories can be
  // tightened, but never follow an attacker-supplied symlink into another tree.
  let prefix = path.parse(directory).root;
  for (const part of directory.slice(prefix.length).split(path.sep)) {
    prefix = path.join(prefix, part);
    try {
      const info = await lstat(prefix);
      if (!info.isDirectory() || info.isSymbolicLink()) reject("unsafe_state_directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await mkdir(prefix, { mode: 0o700 }); } catch (createError) { if (createError.code !== "EEXIST") throw createError; }
      const info = await lstat(prefix);
      if (!info.isDirectory() || info.isSymbolicLink()) reject("unsafe_state_directory");
    }
  }
  await chmod(directory, 0o700);
}
async function readJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || info.nlink !== 1) reject("unsafe_journal_file");
    await handle.chmod(0o600);
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof DeliveryLoopWorkerError) throw error;
    reject("journal_read_failed");
  } finally { await handle?.close(); }
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(file, value, immutable = false) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (immutable) {
      try { await link(temp, file); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readJson(file);
        if (JSON.stringify(existing) !== JSON.stringify(value)) reject("immutable_receipt_conflict");
      }
      await unlink(temp);
    } else { await rename(temp, file); }
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close();
    await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
async function openJournal(root, job) {
  const directory = path.join(root, sha256(job.jobId), `r${job.revision}`);
  await privateDirectory(path.dirname(directory));
  await privateDirectory(directory);
  const statePath = path.join(directory, "state.json");
  const receiptPath = path.join(directory, "composition-receipt.json");
  const state = await readJson(statePath) ?? { version: 1, jobId: job.jobId, revision: job.revision, inputDigest: null, audio: {}, emails: {}, published: null };
  if (state.version !== 1 || state.jobId !== job.jobId || state.revision !== job.revision || !state.audio || !state.emails) reject("journal_identity_mismatch");
  return { state, save: () => atomicJson(statePath, state), receipt: () => readJson(receiptPath), storeReceipt: (receipt) => atomicJson(receiptPath, receipt, true) };
}
async function acquireLock(root) {
  const file = path.join(root, ".worker.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token }), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await syncDirectory(root);
      return async () => {
        const lock = await readJson(file);
        if (lock?.token !== token) reject("worker_lock_lost");
        await unlink(file);
        await syncDirectory(root);
      };
    } catch (error) {
      await handle?.close();
      if (error.code !== "EEXIST") throw error;
      const lock = await readJson(file);
      if (!lock || lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid < 1) return null;
      try { process.kill(lock.pid, 0); return null; } catch (killError) { if (killError.code !== "ESRCH") return null; }
      // Conservative PID check: a live or permission-protected process retains
      // the lock. Only a proven-dead local owner can be recovered automatically.
      const current = await readJson(file);
      if (current?.token !== lock.token) return null;
      await unlink(file);
      await syncDirectory(root);
    }
  }
  return null;
}
