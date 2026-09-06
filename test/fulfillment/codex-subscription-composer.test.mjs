import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertValidCodexSubscriptionComposition,
  buildCodexCompositionRequest,
  codexCompositionToSuggestion,
  sha256,
} from "../../scripts/lib/codex-subscription-composition.mjs";
import { commandPrepareReview } from "../../scripts/lib/commands.mjs";
import { createCodexSubscriptionComposer } from "../../src/fulfillment/codex-subscription-composer.mjs";
import { createLocalPrepareReviewStageHandler } from "../../src/fulfillment/local-prepare-review-stage-handler.mjs";

const SYNTHETIC_INTAKE = Object.freeze({
  schemaVersion: "1.0",
  requestId: "job_synthetic_codex_001",
  submittedAt: "2026-09-06T17:00:00.000Z",
  customer: { email: "synthetic-private@example.test", privateToken: "must-not-cross" },
  baby: { firstName: "Aélio-Z", nameArabic: "أيليو", gender: "girl" },
  languages: ["ar", "fr"],
  voicePreference: { gender: "male" },
  context: { religion: "islam", privateContext: "must-not-cross" },
  notes: {
    specificDemands: "Warm and restrained.",
    religiousReferencesHint: ["must-not-cross"],
  },
});

const VALID_COMPOSITION = Object.freeze({
  schemaVersion: "1.0",
  languages: {
    ar: {
      description: "إعلان ولادة دافئ وخاص.",
      introLines: ["بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ.", "وصلت صغيرتنا بفرح هادئ."],
      introNarration: "بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ. وصلت صغيرتنا بفرح هادئ.",
      blessingLines: ["نسأل الله أن يبارك أيامها.", "وأن يملأ بيتها سكينة."],
      blessingNarration: "نسأل الله أن يبارك أيامها، وأن يملأ بيتها سكينة.",
      closingLines: ["أهلاً بك بيننا.", "لك كل الحب."],
      closingNarration: "أهلاً بك بيننا. لك كل الحب.",
    },
    fr: {
      description: "Une annonce de naissance intime et chaleureuse.",
      introLines: ["Notre petite fille est arrivée.", "La joie s’est installée tout doucement."],
      introNarration: "Notre petite fille est arrivée. La joie s’est installée tout doucement.",
      blessingLines: ["Que ses jours soient doux.", "Et sa maison pleine de paix."],
      blessingNarration: "Que ses jours soient doux, et sa maison pleine de paix.",
      closingLines: ["Bienvenue parmi nous.", "Tu es déjà très aimée."],
      closingNarration: "Bienvenue parmi nous. Tu es déjà très aimée.",
    },
  },
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-composer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    composer: createCodexSubscriptionComposer({
      model: "gpt-synthetic-codex",
      timeoutMs: 1_000,
      ...options,
    }),
  };
}

function fakeCodexProcess(onPrompt) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  child.stdin = {
    end(prompt) {
      Promise.resolve(onPrompt(prompt, child)).catch((error) => child.emit("error", error));
    },
  };
  return child;
}

function successfulSpawn(calls, composition = VALID_COMPOSITION) {
  return (command, args, options) => {
    const call = { command, args, options, prompt: null, schema: null };
    calls.push(call);
    return fakeCodexProcess(async (prompt, child) => {
      call.prompt = prompt;
      const schemaPath = args[args.indexOf("--output-schema") + 1];
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      call.schema = JSON.parse(await readFile(schemaPath, "utf8"));
      await writeFile(outputPath, `${JSON.stringify(composition)}\n`, "utf8");
      queueMicrotask(() => child.emit("close", 0, null));
    });
  };
}

function receiptFor(composition = VALID_COMPOSITION, intake = SYNTHETIC_INTAKE) {
  return {
    composition: structuredClone(composition),
    metadata: {
      adapterVersion: "1.0.0",
      provider: "openai-codex-subscription",
      model: "gpt-synthetic-codex",
      requestDigest: sha256(JSON.stringify({
        adapterVersion: "1.0.0",
        provider: "openai-codex-subscription",
        model: "gpt-synthetic-codex",
        request: buildCodexCompositionRequest(intake),
      })),
      outputDigest: sha256(JSON.stringify(composition)),
    },
  };
}

test("strict composition schema rejects missing, oversized, and unknown output", () => {
  assert.doesNotThrow(() => assertValidCodexSubscriptionComposition(VALID_COMPOSITION));

  const missing = structuredClone(VALID_COMPOSITION);
  delete missing.languages.fr.closingNarration;
  assert.throws(() => assertValidCodexSubscriptionComposition(missing), /invalid codex subscription composition/i);

  const oversized = structuredClone(VALID_COMPOSITION);
  oversized.languages.fr.description = "x".repeat(401);
  assert.throws(() => assertValidCodexSubscriptionComposition(oversized), /invalid codex subscription composition/i);

  const unknown = structuredClone(VALID_COMPOSITION);
  unknown.credentials = "not allowed";
  assert.throws(() => assertValidCodexSubscriptionComposition(unknown), /invalid codex subscription composition/i);
});

test("request projection is bounded and privacy allowlisted", () => {
  assert.deepEqual(buildCodexCompositionRequest(SYNTHETIC_INTAKE), {
    schemaVersion: "1.0",
    baby: { firstName: "Aélio-Z", nameArabic: "أيليو", gender: "girl" },
    languages: ["ar", "fr"],
    context: { religion: "islam" },
    preferences: { specificDemands: "Warm and restrained." },
  });

  const oversized = structuredClone(SYNTHETIC_INTAKE);
  oversized.notes.specificDemands = "x".repeat(2_001);
  assert.throws(() => buildCodexCompositionRequest(oversized), /composition input rejected/i);

  const wrongRequest = receiptFor();
  wrongRequest.metadata.requestDigest = "0".repeat(64);
  assert.throws(
    () => codexCompositionToSuggestion(wrongRequest, SYNTHETIC_INTAKE),
    /does not match the current intake/u,
  );
});

test("composer runs Codex in an ephemeral tool-disabled directory with a minimal environment", async (t) => {
  const calls = [];
  const context = await fixture(t, {
    spawnImpl: successfulSpawn(calls),
    environment: {
      HOME: "/Users/synthetic",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "must-not-cross",
      CUSTOMER_FLOW_BACKEND_TOKEN: "must-not-cross",
      BEBEBONJOUR_OPERATIONS_WORKER_TOKEN: "must-not-cross",
    },
  });

  const result = await context.composer.compose(SYNTHETIC_INTAKE);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, "codex");
  assert.equal(path.resolve(call.options.cwd).startsWith(path.resolve(context.root)), false);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["HOME", "LANG", "PATH"]);
  assert.deepEqual(call.options.env, {
    HOME: "/Users/synthetic",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
  });
  for (const required of [
    "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
    "--ignore-user-config", "--ignore-rules", "--strict-config", "--output-schema",
    "--output-last-message", "-",
  ]) {
    assert.equal(call.args.includes(required), true, `missing Codex isolation argument: ${required}`);
  }
  for (const feature of [
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "hooks",
    "image_generation",
    "in_app_browser",
    "in_app_updates",
    "multi_agent",
    "plugin_sharing",
    "plugins",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "skill_search",
    "standalone_web_search",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "unified_exec",
    "web_search_request",
    "workspace_dependencies",
  ]) {
    assert.equal(call.args.includes(feature), true, `missing disabled capability: ${feature}`);
  }
  assert.equal(call.schema.additionalProperties, false);
  assert.equal(JSON.stringify(call.schema).includes('"additionalProperties":true'), false);
  assert.equal(call.prompt.includes("synthetic-private@example.test"), false);
  assert.equal(call.prompt.includes("job_synthetic_codex_001"), false);
  assert.equal(call.prompt.includes("must-not-cross"), false);
  assert.equal(call.prompt.includes("Aélio-Z"), true);
  assert.equal(JSON.stringify(result).includes("must-not-cross"), false);
  assert.deepEqual(result.composition, VALID_COMPOSITION);
  assert.deepEqual(result.metadata, {
    adapterVersion: "1.0.0",
    provider: "openai-codex-subscription",
    model: "gpt-synthetic-codex",
    requestDigest: result.metadata.requestDigest,
    outputDigest: result.metadata.outputDigest,
  });
  assert.match(result.metadata.requestDigest, /^[a-f0-9]{64}$/u);
  assert.match(result.metadata.outputDigest, /^[a-f0-9]{64}$/u);
  await assert.rejects(access(call.options.cwd), { code: "ENOENT" });
});

test("composer rejects malformed or schema-invalid output without leaking provider output", async (t) => {
  for (const raw of ["not-json", JSON.stringify({ schemaVersion: "1.0", languages: {} })]) {
    const context = await fixture(t, {
      spawnImpl(command, args) {
        return fakeCodexProcess(async (prompt, child) => {
          const outputPath = args[args.indexOf("--output-last-message") + 1];
          await writeFile(outputPath, raw, "utf8");
          child.emit("close", 0, null);
        });
      },
    });
    await assert.rejects(
      context.composer.compose(SYNTHETIC_INTAKE),
      (error) => error?.reasonCode === "composition_output_rejected"
        && error?.retryable === false
        && !error.message.includes(raw),
    );
  }
});

test("composer times out, terminates the child, and removes its sandbox", async (t) => {
  let child;
  let cwd;
  const context = await fixture(t, {
    timeoutMs: 15,
    spawnImpl(command, args, options) {
      cwd = options.cwd;
      child = fakeCodexProcess(() => {});
      return child;
    },
  });

  await assert.rejects(
    context.composer.compose(SYNTHETIC_INTAKE),
    (error) => error?.reasonCode === "composition_timeout" && error?.retryable === true,
  );
  assert.equal(child.killedWith.includes("SIGTERM"), true);
  await assert.rejects(access(cwd), { code: "ENOENT" });
});

test("composer propagates cancellation, terminates the child, and retains no output", async (t) => {
  const controller = new AbortController();
  let child;
  let started;
  const childStarted = new Promise((resolve) => { started = resolve; });
  const context = await fixture(t, {
    spawnImpl() {
      child = fakeCodexProcess(() => started());
      return child;
    },
  });

  const pending = context.composer.compose(SYNTHETIC_INTAKE, { signal: controller.signal });
  await childStarted;
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error?.reasonCode === "composition_cancelled" && error?.retryable === true,
  );
  assert.equal(child.killedWith.includes("SIGTERM"), true);

});

test("composer reuses a validated receipt for idempotent retries", async (t) => {
  const calls = [];
  const context = await fixture(t, { spawnImpl: successfulSpawn(calls) });

  const first = await context.composer.compose(SYNTHETIC_INTAKE);
  const second = await context.composer.compose(structuredClone(SYNTHETIC_INTAKE));

  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(context.root), []);
});

test("validated composition feeds only the deterministic private-review pipeline and binds its metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-private-review-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const intakePath = path.join(root, "intake.json");
  const outputRoot = path.join(root, "review");
  const intake = {
    ...structuredClone(SYNTHETIC_INTAKE),
    requestId: "req_bayane_codex_synthetic_001",
    baby: { firstName: "Bayane", nameArabic: "بَيَان", gender: "girl" },
  };
  await writeFile(intakePath, `${JSON.stringify(intake, null, 2)}\n`, "utf8");
  const receipt = receiptFor(VALID_COMPOSITION, intake);

  await commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }, { composition: receipt, silent: true });

  const dossier = JSON.parse(await readFile(path.join(outputRoot, "review.json"), "utf8"));
  const page = JSON.parse(await readFile(
    path.join(outputRoot, "artifacts", "current", "page.json"),
    "utf8",
  ));
  assert.deepEqual(dossier.generationMaterials.composition, receipt.metadata);
  assert.deepEqual(page.sections.intro.fr.displayLines, VALID_COMPOSITION.languages.fr.introLines);
  assert.deepEqual(page.sections.dua.ar.displayLines, VALID_COMPOSITION.languages.ar.blessingLines);
  assert.deepEqual(page.sections.closing.fr.displayLines, VALID_COMPOSITION.languages.fr.closingLines);
  assert.equal(page.sections.verses.fr.items[0].sourceKey, "quran-55-4");
  await assert.rejects(access(path.join(outputRoot, "deploy")), { code: "ENOENT" });

  await assert.doesNotReject(commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }, { composition: receipt, silent: true }));

  const changed = structuredClone(VALID_COMPOSITION);
  changed.languages.fr.introLines = ["Une autre composition."];
  await assert.rejects(
    commandPrepareReview({
      input: intakePath,
      output: outputRoot,
      select: "religious-bayane",
    }, { composition: receiptFor(changed, intake), silent: true }),
    /different material inputs/i,
  );
});

test("local prepare-review handler obtains composition before deterministic artifact generation", async () => {
  const receipt = receiptFor();
  const calls = [];
  const handler = createLocalPrepareReviewStageHandler({
    async resolveJobPaths() {
      return {
        inputRecordPath: "/synthetic/intake.json",
        reviewRoot: "/synthetic/review",
        revision: { revisionId: "revision_synthetic_001" },
        intakeSnapshot: structuredClone(SYNTHETIC_INTAKE),
        editorialApproval: {
          record: { synthetic: true },
          recordDigest: "b".repeat(64),
        },
      };
    },
    async collectArtifactSet() {
      if (calls.length === 0) return null;
      return { kind: "private_review", revisionId: "revision_synthetic_001" };
    },
    async cleanupStageOutput() {},
    async preflightComposition(args, options) {
      calls.push({ type: "preflight", args, options });
      return { state: "composition_ready" };
    },
    async compose(intake) {
      calls.push({ type: "compose", intake });
      return receipt;
    },
    async prepareReview(args, options) {
      calls.push({ type: "prepareReview", args, options });
    },
  });

  await handler({
    job: { jobId: "job_synthetic_001" },
    async assertStageOwnership() {},
  });

  assert.deepEqual(calls.map((call) => call.type), ["preflight", "compose", "prepareReview"]);
  assert.deepEqual(calls[2].options.composition, receipt);
  assert.equal(calls[2].options.silent, true);
});

test("ephemeral managed auth is restored, proven ready, refreshed, and written back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-managed-auth-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialAuth = `${JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
    last_refresh: "2026-09-01T00:00:00.000Z",
  })}\n`;
  const refreshedAuth = `${JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-new-access", refresh_token: "synthetic-new-refresh" },
    last_refresh: "2026-09-06T19:00:00.000Z",
  })}\n`;
  const lease = Object.freeze({
    authJson: initialAuth,
    version: 4,
    authLeaseToken: "codex_auth_lease_1234567890abcdef1234567890abcdef",
    leaseExpiresAtMs: Date.now() + 120_000,
  });
  const authCalls = [];
  const probeCalls = [];
  const authStateStore = {
    async claim() { authCalls.push("claim"); return lease; },
    async commit(value, authJson) { authCalls.push({ type: "commit", value, authJson }); return { version: 5 }; },
    async release(value) { authCalls.push({ type: "release", value }); },
  };
  let codexHome;
  const composer = createCodexSubscriptionComposer({
    authStateStore,
    environment: {
      HOME: "/must/not/cross",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OPENAI_API_KEY: "must-not-cross",
    },
    model: "gpt-5.6-sol",
    async probeImpl(_command, args, options) {
      probeCalls.push({ args, options });
      codexHome = options.env.CODEX_HOME;
      assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), initialAuth);
      if (args[0] === "--version") return { stdout: "codex-cli 0.146.0\n" };
      return { stdout: "", stderr: "Logged in using ChatGPT\n" };
    },
    spawnImpl(command, args, options) {
      assert.equal(command, "codex");
      assert.equal(options.env.CODEX_HOME, codexHome);
      assert.equal(Object.hasOwn(options.env, "HOME"), false);
      return fakeCodexProcess(async (_prompt, child) => {
        const authPath = path.join(options.env.CODEX_HOME, "auth.json");
        assert.equal((await stat(options.env.CODEX_HOME)).mode & 0o077, 0);
        assert.equal((await stat(authPath)).mode & 0o077, 0);
        await writeFile(authPath, refreshedAuth, { encoding: "utf8", mode: 0o600 });
        const outputPath = args[args.indexOf("--output-last-message") + 1];
        await writeFile(outputPath, `${JSON.stringify(VALID_COMPOSITION)}\n`, "utf8");
        queueMicrotask(() => child.emit("close", 0, null));
      });
    },
  });

  const result = await composer.compose(SYNTHETIC_INTAKE);
  assert.equal(result.metadata.model, "gpt-5.6-sol");
  assert.deepEqual(probeCalls.map((call) => call.args), [["--version"], ["login", "status"]]);
  assert.equal(probeCalls.every((call) => call.options.cwd === path.dirname(codexHome)), true);
  assert.deepEqual(authCalls[0], "claim");
  assert.deepEqual(authCalls[1], { type: "commit", value: lease, authJson: refreshedAuth });
  assert.equal(authCalls.length, 2);
  await assert.rejects(access(path.dirname(codexHome)), { code: "ENOENT" });
});

test("managed auth writeback failure discards model output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-writeback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authJson = `${JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
    last_refresh: "2026-09-01T00:00:00.000Z",
  })}\n`;
  const composer = createCodexSubscriptionComposer({
    environment: { PATH: "/usr/bin:/bin" },
    authStateStore: {
      async claim() {
        return {
          authJson,
          version: 1,
          authLeaseToken: "codex_auth_lease_1234567890abcdef1234567890abcdef",
          leaseExpiresAtMs: Date.now() + 120_000,
        };
      },
      async commit() {
        const error = new Error("secret persistence detail");
        error.reasonCode = "composition_auth_writeback_failed";
        error.retryable = true;
        throw error;
      },
      async release() { return { released: true }; },
    },
    async probeImpl(_command, args) {
      return args[0] === "--version"
        ? { stdout: "codex-cli 0.146.0\n" }
        : { stdout: "Logged in using ChatGPT\n" };
    },
    spawnImpl: successfulSpawn([]),
  });

  await assert.rejects(
    composer.compose(SYNTHETIC_INTAKE),
    (error) => error?.reasonCode === "composition_auth_writeback_failed"
      && !error.message.includes("secret persistence detail"),
  );
});
