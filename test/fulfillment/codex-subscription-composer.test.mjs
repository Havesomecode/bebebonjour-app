import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertValidCodexSubscriptionComposition,
  buildCodexCompositionRequest,
  buildCodexCompositionPrompt,
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

const SYNTHETIC_BRIEF = Object.freeze({ firstName: "Aélio-Z", nameArabic: "أيليو", gender: "girl", birthDate: null, religion: "islam", tone: "tendre", phrases: [], languages: ["ar", "fr"] });

const VALID_COMPOSITION = Object.freeze({
  schemaVersion: "2.0",
  languages: {
    ar: {
      description: "إعلان ولادة دافئ وخاص.",
      introLines: ["بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ.", "وصلت صغيرتنا بفرح هادئ."],
      introNarration: "بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ. وصلت صغيرتنا بفرح هادئ.",
      blessingLines: ["نسأل الله أن يبارك أيامها.", "وأن يملأ بيتها سكينة."],
      blessingNarration: "نسأل الله أن يبارك أيامها، وأن يملأ بيتها سكينة.",
      meaningLines: ["Douceur."], revealLines: ["Notre enfant."],
      closingLines: ["أهلاً بك بيننا.", "لك كل الحب."],
      closingNarration: "أهلاً بك بيننا. لك كل الحب.",
    },
    fr: {
      description: "Une annonce de naissance intime et chaleureuse.",
      introLines: ["Notre petite fille est arrivée.", "La joie s’est installée tout doucement."],
      introNarration: "Notre petite fille est arrivée. La joie s’est installée tout doucement.",
      blessingLines: ["Que ses jours soient doux.", "Et sa maison pleine de paix."],
      blessingNarration: "Que ses jours soient doux, et sa maison pleine de paix.",
      meaningLines: ["Douceur."], revealLines: ["Notre enfant."],
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

function receiptFor(composition = VALID_COMPOSITION, intake = SYNTHETIC_BRIEF) {
  return {
    composition: structuredClone(composition),
    metadata: {
      adapterVersion: "2.0.0",
      provider: "openai-codex-subscription",
      model: "gpt-synthetic-codex",
      requestDigest: sha256(JSON.stringify({
        adapterVersion: "2.0.0",
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

test("request accepts only a validated operator brief and binds receipt", () => {
  assert.deepEqual(buildCodexCompositionRequest(SYNTHETIC_BRIEF), { schemaVersion: "3.0", brief: SYNTHETIC_BRIEF, nameReference: null });
  assert.throws(() => buildCodexCompositionRequest(SYNTHETIC_INTAKE), /composition input rejected/i);
  const wrongRequest = receiptFor(); wrongRequest.metadata.requestDigest = "0".repeat(64);
  assert.throws(() => codexCompositionToSuggestion(wrongRequest, SYNTHETIC_BRIEF), /does not match/);
});

test("general wishes use brief religion", () => {
  const brief = { ...SYNTHETIC_BRIEF, firstName: "Liora", nameArabic: null, languages: ["fr"], religion: "general" };
  const suggestion = codexCompositionToSuggestion(receiptFor(VALID_COMPOSITION, brief), brief);
  assert.deepEqual(suggestion.frWishLines, VALID_COMPOSITION.languages.fr.blessingLines);
  assert.equal(suggestion.frDuaLines, undefined);
  assert.throws(() => buildCodexCompositionRequest({ ...brief, religion: "unknown" }), /composition input rejected/);
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

  const result = await context.composer.compose(SYNTHETIC_BRIEF);

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
    adapterVersion: "2.0.0",
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
      context.composer.compose(SYNTHETIC_BRIEF),
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
    context.composer.compose(SYNTHETIC_BRIEF),
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

  const pending = context.composer.compose(SYNTHETIC_BRIEF, { signal: controller.signal });
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

  const first = await context.composer.compose(SYNTHETIC_BRIEF);
  const second = await context.composer.compose(structuredClone(SYNTHETIC_BRIEF));

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
  const brief = { ...SYNTHETIC_BRIEF, firstName: "Bayane", nameArabic: "بَيَان" };
  const receipt = receiptFor(VALID_COMPOSITION, brief);

  await commandPrepareReview({
    input: intakePath,
    output: outputRoot,
    select: "religious-bayane",
  }, { composition: receipt, compositionBrief: brief, silent: true });

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
  }, { composition: receipt, compositionBrief: brief, silent: true }));

  const changed = structuredClone(VALID_COMPOSITION);
  changed.languages.fr.introLines = ["Une autre composition."];
  await assert.rejects(
    commandPrepareReview({
      input: intakePath,
      output: outputRoot,
      select: "religious-bayane",
    }, { composition: receiptFor(changed, brief), compositionBrief: brief, silent: true }),
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
        generationBrief: structuredClone(SYNTHETIC_BRIEF),
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

  const result = await composer.compose(SYNTHETIC_BRIEF);
  assert.equal(result.metadata.model, "gpt-5.6-sol");
  assert.deepEqual(probeCalls.map((call) => call.args), [["--version"], ["login", "status"]]);
  assert.equal(probeCalls.every((call) => call.options.cwd === path.dirname(codexHome)), true);
  assert.deepEqual(authCalls[0], "claim");
  assert.deepEqual(authCalls[1], { type: "commit", value: lease, authJson: refreshedAuth });
  assert.equal(authCalls.length, 2);
  await assert.rejects(access(path.dirname(codexHome)), { code: "ENOENT" });
});

function pathAliasRefusalWarning(tempDir, codexHome) {
  return `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir ${JSON.stringify(tempDir)} (codex_home: AbsolutePathBuf(${JSON.stringify(codexHome)}))\n`;
}

test("readiness accepts only the invocation-bound temporary PATH alias refusal warning", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-warning-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempDir = os.tmpdir();
  const codexHome = path.join(root, 'codex.[home]+(synthetic)"\\');
  const warning = pathAliasRefusalWarning(tempDir, codexHome);
  const version = { stdout: "codex-cli 0.146.0\n", stderr: warning };
  const status = { stdout: "", stderr: `${warning}Logged in using ChatGPT\n` };
  const cases = [
    { name: "reproduced stderr status", ready: true },
    { name: "stdout status", status: { stdout: "Logged in using ChatGPT\n", stderr: warning }, ready: true },
    { name: "warning-free stdout status", version: { stdout: version.stdout }, status: { stdout: "Logged in using ChatGPT\n" }, ready: true },
    { name: "warning-free stderr status", version: { stdout: version.stdout }, status: { stderr: "Logged in using ChatGPT\n" }, ready: true },
    { name: "unknown version warning", version: { ...version, stderr: "WARNING: unknown warning\n" } },
    { name: "additional version warning", version: { ...version, stderr: `${warning}WARNING: unknown warning\n` } },
    { name: "additional version error", version: { ...version, stderr: `${warning}ERROR: unsafe\n` } },
    { name: "duplicate version warning", version: { ...version, stderr: warning.repeat(2) } },
    { name: "unknown status warning", status: { stderr: "WARNING: unknown warning\nLogged in using ChatGPT\n" } },
    { name: "additional status warning", status: { stderr: `${warning}WARNING: unknown warning\nLogged in using ChatGPT\n` } },
    { name: "additional status error", status: { stderr: `${warning}Logged in using ChatGPT\nERROR: unsafe\n` } },
    { name: "duplicate status warning", status: { stderr: `${warning.repeat(2)}Logged in using ChatGPT\n` } },
    { name: "warning after status", status: { stderr: `Logged in using ChatGPT\n${warning}` } },
    { name: "warning in version stdout", version: { stdout: `${warning}${version.stdout}` } },
    { name: "warning in status stdout", status: { stdout: `${warning}Logged in using ChatGPT\n` } },
    { name: "different CODEX_HOME", status: { stderr: `${pathAliasRefusalWarning(tempDir, `${codexHome}-other`)}Logged in using ChatGPT\n` } },
    { name: "different temporary directory", version: { ...version, stderr: pathAliasRefusalWarning(`${tempDir}-other`, codexHome) } },
    { name: "regex-like path mismatch", status: { stderr: `${pathAliasRefusalWarning(tempDir, codexHome.replace(".", "x"))}Logged in using ChatGPT\n` } },
    { name: "missing CODEX_HOME", environment: { TMPDIR: tempDir } },
    { name: "non-temporary CODEX_HOME", environment: { TMPDIR: tempDir, CODEX_HOME: "/synthetic/persistent/codex-home" }, customWarning: true },
    { name: "temporary directory prefix sibling", environment: { TMPDIR: tempDir, CODEX_HOME: `${tempDir}-sibling/codex-home` }, customWarning: true },
    { name: "temporary directory itself", environment: { TMPDIR: tempDir, CODEX_HOME: tempDir }, customWarning: true },
    { name: "relative CODEX_HOME", environment: { TMPDIR: tempDir, CODEX_HOME: "relative/codex-home" }, customWarning: true },
    { name: "traversal CODEX_HOME", environment: { TMPDIR: tempDir, CODEX_HOME: `${tempDir}/nested/../../persistent/codex-home` }, customWarning: true },
    { name: "API-key status", status: { stderr: `${warning}Logged in using an API key\n` } },
    { name: "no-login status", status: { stderr: `${warning}Not logged in\n` } },
    { name: "missing status", status: { stderr: warning } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const environment = entry.environment || { TMPDIR: tempDir, CODEX_HOME: codexHome };
      const customWarning = pathAliasRefusalWarning(environment.TMPDIR, environment.CODEX_HOME);
      const composer = createCodexSubscriptionComposer({
        environment,
        async probeImpl(_command, args, options) {
          assert.deepEqual(options.env, environment);
          if (entry.customWarning) {
            return args[0] === "--version"
              ? { stdout: version.stdout, stderr: customWarning }
              : { stderr: `${customWarning}Logged in using ChatGPT\n` };
          }
          return args[0] === "--version"
            ? (entry.version || version)
            : (entry.status || (entry.version ? { stderr: "Logged in using ChatGPT\n" } : status));
        },
        spawnImpl() { assert.fail("readiness must not call the provider"); },
      });
      if (entry.ready) {
        const result = await composer.readiness();
        assert.equal(result.status, "ready");
        assert.equal(result.cliVersion, "0.146.0");
      } else {
        await assert.rejects(composer.readiness(), (error) => (
          error.reasonCode === "composition_provider_unavailable"
          && error.retryable === true
          && error.message === "composition_provider_unavailable"
        ));
      }
    });
  }
});

test("managed readiness and composition tolerate only the bound PATH alias refusal", async () => {
  const lease = { authJson: '{"auth_mode":"chatgpt","synthetic":true}\n' };
  const commits = [];
  const homes = [];
  const calls = [];
  const composer = createCodexSubscriptionComposer({
    environment: { TMPDIR: os.tmpdir(), CODEX_HOME: "/must/not/be/used", HOME: "/must/not/cross" },
    authStateStore: {
      async claim() { return lease; },
      async commit(value, authJson) { commits.push({ value, authJson }); },
      async release() { assert.fail("successful synthetic auth must be committed"); },
    },
    async probeImpl(_command, args, options) {
      const codexHome = options.env.CODEX_HOME;
      assert.equal(codexHome, path.join(options.cwd, "codex-home"));
      assert.equal(Object.hasOwn(options.env, "HOME"), false);
      homes.push(codexHome);
      const warning = pathAliasRefusalWarning(options.env.TMPDIR, codexHome);
      return args[0] === "--version"
        ? { stdout: "codex-cli 0.146.0\n", stderr: warning }
        : { stdout: "", stderr: `${warning}Logged in using ChatGPT\n` };
    },
    spawnImpl: successfulSpawn(calls),
  });
  assert.equal((await composer.readiness()).authMode, "managed-chatgpt-ephemeral");
  assert.deepEqual((await composer.compose(SYNTHETIC_BRIEF)).composition, VALID_COMPOSITION);
  assert.equal(calls.length, 1);
  assert.equal(commits.length, 2);
  for (const commit of commits) assert.deepEqual(commit, { value: lease, authJson: lease.authJson });
  assert.equal(homes.length, 4);
  assert.notEqual(homes[0], homes[2]);
  for (const home of homes) await assert.rejects(access(path.dirname(home)), { code: "ENOENT" });
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
    composer.compose(SYNTHETIC_BRIEF),
    (error) => error?.reasonCode === "composition_auth_writeback_failed"
      && !error.message.includes("secret persistence detail"),
  );
});

test("name reference is verified and prompt rejects tampering", () => {
  const bayane = { ...SYNTHETIC_BRIEF, firstName: "Bayane", nameArabic: "بَيَان" };
  const request = buildCodexCompositionRequest(bayane);
  assert.ok(request.nameReference.meaning.fr);
  assert.ok(request.nameReference.meaning.ar);
  assert.match(buildCodexCompositionPrompt(request), /Bayan/);
  assert.throws(() => buildCodexCompositionPrompt({ ...request, nameReference: null }));
});

test("composer rejects name leaks without revealing provider output", async (t) => {
  const composition = structuredClone(VALID_COMPOSITION);
  composition.languages.fr.meaningLines = ["Aélio-Z"];
  const context = await fixture(t, { spawnImpl: successfulSpawn([], composition) });
  await assert.rejects(context.composer.compose(SYNTHETIC_BRIEF), e => e.reasonCode === "composition_output_rejected" && e.retryable === true && !e.message.includes("Aélio-Z"));
});
