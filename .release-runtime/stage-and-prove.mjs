import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { createFulfillmentOrchestrator } from "../src/fulfillment/job-orchestrator.mjs";
import { createLocalCommandStageHandlers } from "../src/fulfillment/local-command-stage-handlers.mjs";
import { createLocalGenerationWorkspace } from "../src/fulfillment/local-generation-workspace.mjs";
import { createConvexFulfillmentStore } from "../src/persistence/convex-fulfillment-store.mjs";

const APP_ROOT = path.resolve(".");
const LANDING_ROOT = "/Users/zacariachtatar/repos/bebebonjour-app/.worktrees/t_9bd37a71/.worktrees/landing";
const APP_SHA = "ceb41cdc98a28db8fff0b674f909457a33b63282";
const APP_TREE = "b2855bf9578d306724f99e49030fcf714a8eb6f1";
const LANDING_SHA = "1fcf3af4925151f0598db05cf28022db8de0b69f";
const LANDING_TREE = "66e68e5c638f34856388a7995adc68960703c235";
const SCOPE = "zacaria-chtatars-projects";
const APP_PROJECT = "prj_XJrkufo77hXAdvMuYjPn6F6AVZjn";
const LANDING_PROJECT = "prj_MJTHJrEVehZIRHuQBiZ1CgAG7MuB";
const CONVEX_DEPLOYMENT = "brilliant-hawk-751";
const CONVEX_URL = "https://brilliant-hawk-751.convex.cloud";
const API_BASE = "https://bebebonjour-fulfillment.vercel.app/api/customer-flow";
const API_ALIAS = "bebebonjour-fulfillment.vercel.app";
const LANDING_ORIGIN = "https://www.bebebonjour.com";
const STRIPE_ACCOUNT = "acct_1MKd4KGrir6mz3o7";
const STRIPE_EVENT = "checkout.session.completed";
const RUNTIME_ROOT = path.join(APP_ROOT, ".release-runtime");
const EVIDENCE_PATH = path.join(RUNTIME_ROOT, "provider-proof-ceb41cdc.json");
const GENERATION_ROOT = path.join(RUNTIME_ROOT, "generation-ceb41cdc");
const APP_DEPLOY_ROOT = path.join(RUNTIME_ROOT, "exact-app-candidate-ceb41cdc");
const LANDING_DEPLOY_ROOT = path.join(RUNTIME_ROOT, "exact-landing-candidate-1fcf3af4");
const TOKEN_NAME = `test-a-release-${Date.now()}`;

const secrets = [];
const backendToken = randomBytes(48).toString("base64url");
const encryptionKey = randomBytes(32).toString("base64");
const accessToken = randomBytes(48).toString("base64url");
const bootstrapWebhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
secrets.push(backendToken, encryptionKey, accessToken, bootstrapWebhookSecret);

const stripeConfig = await readFile(path.join(os.homedir(), ".config", "stripe", "config.toml"), "utf8");
const stripeKeyMatch = stripeConfig.match(/^test_mode_api_key\s*=\s*["']([^"']+)["']/m);
if (!stripeKeyMatch || !stripeKeyMatch[1].startsWith("sk_test_")) {
  throw new Error("A Stripe sk_test credential is required before provider mutation.");
}
const stripeSecretKey = stripeKeyMatch[1];
secrets.push(stripeSecretKey);

function scrub(value) {
  let clean = String(value ?? "");
  for (const secret of secrets) clean = clean.split(secret).join("[REDACTED]");
  return clean;
}

async function run(command, args, options = {}) {
  const { cwd = APP_ROOT, input = null, env = {}, allowFailure = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) {
        const finalLine = scrub(stderr || stdout).trim().split("\n").slice(-3).join(" | ");
        reject(new Error(`${command} ${args[0] || ""} failed (${code}): ${finalLine}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{" && trimmed[index] !== "[") continue;
    try { return JSON.parse(trimmed.slice(index)); } catch {}
  }
  throw new Error("Command did not return parseable JSON.");
}

async function gitIdentity(root, expectedSha, expectedTree) {
  const head = (await run("git", ["rev-parse", "HEAD^{commit}"], { cwd: root })).stdout.trim();
  const tree = (await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })).stdout.trim();
  const status = (await run("git", ["status", "--short"], { cwd: root })).stdout
    .split("\n")
    .filter((line) => line && !line.includes(".release-runtime/"));
  if (head !== expectedSha || tree !== expectedTree || status.length > 0) {
    throw new Error(`Candidate identity drift in ${root}.`);
  }
  await run("git", ["verify-commit", expectedSha], { cwd: root });
  return { commit: head, tree };
}

async function materializeCommit(root, commit, destination) {
  const archivePath = `${destination}.tar`;
  await rm(destination, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await run("git", ["archive", "--format=tar", `--output=${archivePath}`, commit], { cwd: root });
  await run("tar", ["-xf", archivePath, "-C", destination]);
  await rm(archivePath, { force: true });
  return destination;
}

async function convexEnvNames() {
  const result = await run("npx", ["convex", "env", "list", "--names-only", "--deployment", CONVEX_DEPLOYMENT]);
  if (result.stdout.includes("No environment variables")) return [];
  return `${result.stdout}\n${result.stderr}`.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

async function vercelEnvNames(project, cwd) {
  const result = await run("npx", ["vercel", "env", "ls", "production", "--scope", SCOPE, "--project", project], { cwd });
  const names = [];
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const match = line.match(/^\s+([A-Z][A-Z0-9_]*)\s+/);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)];
}

async function setVercelEnv(project, cwd, name, value, sensitive) {
  const args = [
    "vercel", "env", "add", name, "production", "--force", "--yes",
    "--scope", SCOPE, "--project", project,
    sensitive ? "--sensitive" : "--no-sensitive",
  ];
  await run("npx", args, { cwd, input: `${value}\n` });
}

async function exactVercelEnvironment(project, cwd, values) {
  const expected = new Set(Object.keys(values));
  for (const name of await vercelEnvNames(project, cwd)) {
    if (!expected.has(name)) {
      await run("npx", ["vercel", "env", "rm", name, "production", "--yes", "--scope", SCOPE, "--project", project], { cwd });
    }
  }
  for (const [name, spec] of Object.entries(values)) {
    await setVercelEnv(project, cwd, name, spec.value, spec.sensitive);
  }
  const actual = (await vercelEnvNames(project, cwd)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Vercel production environment inventory mismatch for ${project}.`);
  }
  return actual;
}

async function deployVercel(root, project, skipDomain, commit, tree) {
  const args = [
    "vercel", "deploy", root, "--prod", "--force", "--yes", "--json",
    "--scope", SCOPE, "--project", project,
    "--meta", `candidateCommit=${commit}`,
    "--meta", `candidateTree=${tree}`,
  ];
  if (skipDomain) args.push("--skip-domain");
  const result = await run("npx", args, { cwd: root });
  const parsed = parseJsonOutput(result.stdout);
  const deployment = parsed.payload || parsed.deployment || parsed;
  const rawUrl = deployment.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error(`Vercel deployment output shape is unsupported: ${Object.keys(parsed).sort().join(",")}`);
  }
  const url = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
  const inspected = parseJsonOutput((await run(
    "npx",
    ["vercel", "inspect", url, "--scope", SCOPE, "--json"],
    { cwd: root },
  )).stdout);
  if (!inspected.id || inspected.readyState !== "READY") {
    throw new Error("Vercel deployment did not resolve to a ready immutable handle.");
  }
  return { id: inspected.id, url, status: inspected.readyState };
}

async function stripeJson(args) {
  const result = await run("stripe", [...args, "--color", "off"]);
  return parseJsonOutput(result.stdout);
}

async function requestJson(url, options = {}, expected = 200) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (response.status !== expected) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).origin}${new URL(url).pathname}.`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response from ${url}.`); }
}

async function waitFor(predicate, label, attempts = 40, delayMs = 1000) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} did not become ready: ${last instanceof Error ? last.message : "timeout"}`);
}

async function health(baseUrl) {
  return waitFor(async () => {
    const response = await fetch(`${baseUrl}/health`, { redirect: "manual" });
    if (response.status !== 200) return null;
    const payload = await response.json();
    return payload?.ok === true ? payload : null;
  }, `health ${baseUrl}`, 60, 1000);
}

async function protectedDeploymentHealth(deploymentUrl, cwd) {
  const result = await run("npx", [
    "vercel", "curl", `${deploymentUrl}/api/customer-flow/health`,
    "--scope", SCOPE,
    "--", "--location", "--silent", "--show-error",
  ], { cwd });
  const payload = parseJsonOutput(result.stdout);
  if (payload?.ok !== true) throw new Error("Protected Vercel deployment health check failed.");
  return payload;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

await mkdir(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
const evidence = {
  schemaVersion: "1.0",
  startedAt: new Date().toISOString(),
  candidates: {},
  convex: {},
  vercelApi: {},
  stripe: {},
  landing: {},
  proof: {},
  review: {},
  warnings: [],
};
let deployKey = null;
let stripeEndpoint = null;

try {
  evidence.candidates.app = await gitIdentity(APP_ROOT, APP_SHA, APP_TREE);
  evidence.candidates.landing = await gitIdentity(LANDING_ROOT, LANDING_SHA, LANDING_TREE);
  await materializeCommit(APP_ROOT, APP_SHA, APP_DEPLOY_ROOT);
  await materializeCommit(LANDING_ROOT, LANDING_SHA, LANDING_DEPLOY_ROOT);

  const account = await stripeJson(["get", "/v1/account"]);
  if (account.id !== STRIPE_ACCOUNT) {
    throw new Error("Stripe CLI is not bound to the authorized TEST-A account/mode.");
  }
  const existingEndpoints = await stripeJson(["get", "/v1/webhook_endpoints", "--limit", "100"]);
  const canonicalEndpoints = existingEndpoints.data.filter(
    (entry) => entry.url === `${API_BASE}/webhooks/stripe`,
  );
  if (canonicalEndpoints.length > 1) {
    throw new Error("Multiple Stripe webhook destinations target the canonical URL.");
  }
  const existingStripeEndpoint = canonicalEndpoints[0] || null;

  for (const name of await convexEnvNames()) {
    if (name !== "CUSTOMER_FLOW_BACKEND_TOKEN") {
      await run("npx", ["convex", "env", "remove", name, "--deployment", CONVEX_DEPLOYMENT]);
    }
  }
  await run("npx", ["convex", "env", "set", "CUSTOMER_FLOW_BACKEND_TOKEN", "--deployment", CONVEX_DEPLOYMENT], { input: `${backendToken}\n` });
  const convexNames = await convexEnvNames();
  if (JSON.stringify(convexNames) !== JSON.stringify(["CUSTOMER_FLOW_BACKEND_TOKEN"])) {
    throw new Error("Convex environment inventory is not exact.");
  }

  const tokenResult = await run("npx", ["convex", "deployment", "token", "create", TOKEN_NAME, "--deployment", CONVEX_DEPLOYMENT]);
  deployKey = tokenResult.stdout.trim();
  secrets.push(deployKey);
  if (!deployKey.includes("|")) throw new Error("Convex deploy token format was not recognized.");
  await run("npx", ["convex", "deploy", "--codegen", "disable", "--message", `TEST-A ${APP_SHA}`], {
    env: { CONVEX_DEPLOY_KEY: deployKey },
  });
  const convexProbe = await fetch(CONVEX_URL, { method: "HEAD" });
  if (convexProbe.status !== 200) throw new Error("Convex deployment URL is not reachable.");
  evidence.convex = {
    deploymentName: CONVEX_DEPLOYMENT,
    url: CONVEX_URL,
    environmentVariableNames: convexNames,
    httpStatus: convexProbe.status,
  };

  const apiEnvironment = {
    CONVEX_URL: { value: CONVEX_URL, sensitive: false },
    CUSTOMER_FLOW_BACKEND_TOKEN: { value: backendToken, sensitive: true },
    CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: { value: encryptionKey, sensitive: true },
    CUSTOMER_FLOW_TEST_ACCESS_TOKEN: { value: accessToken, sensitive: true },
    CUSTOMER_FLOW_ALLOWED_ORIGINS: { value: JSON.stringify([LANDING_ORIGIN]), sensitive: false },
    STRIPE_SECRET_KEY: { value: stripeSecretKey, sensitive: true },
    STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET: { value: bootstrapWebhookSecret, sensitive: true },
    STRIPE_CHECKOUT_SUCCESS_URL: { value: `${LANDING_ORIGIN}/suivi?checkout=success`, sensitive: false },
    STRIPE_CHECKOUT_CANCEL_URL: { value: `${LANDING_ORIGIN}/suivi?checkout=cancel`, sensitive: false },
  };
  let apiEnvNames;
  let bootstrap = null;
  if (existingStripeEndpoint) {
    const expectedNames = Object.keys(apiEnvironment).sort();
    apiEnvNames = (await vercelEnvNames(APP_PROJECT, APP_ROOT)).sort();
    if (JSON.stringify(apiEnvNames) !== JSON.stringify(expectedNames)) {
      throw new Error("Existing Stripe endpoint cannot be reused with a non-exact Vercel environment inventory.");
    }
    for (const [name, spec] of Object.entries(apiEnvironment)) {
      if (name !== "STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET") {
        await setVercelEnv(APP_PROJECT, APP_ROOT, name, spec.value, spec.sensitive);
      }
    }
    stripeEndpoint = existingStripeEndpoint;
  } else {
    apiEnvNames = await exactVercelEnvironment(APP_PROJECT, APP_ROOT, apiEnvironment);
    bootstrap = await deployVercel(APP_DEPLOY_ROOT, APP_PROJECT, true, APP_SHA, APP_TREE);
    await protectedDeploymentHealth(bootstrap.url, APP_DEPLOY_ROOT);

    stripeEndpoint = await stripeJson([
      "post", "/v1/webhook_endpoints", "--confirm",
      "--data", `url=${bootstrap.url}/api/customer-flow/webhooks/stripe`,
      "--data", `enabled_events[0]=${STRIPE_EVENT}`,
      "--data", "description=Bebe Bonjour TEST-A t_3f375e12",
    ]);
    if (!stripeEndpoint.id || !stripeEndpoint.secret?.startsWith("whsec_")
        || stripeEndpoint.livemode !== false
        || stripeEndpoint.enabled_events?.length !== 1
        || stripeEndpoint.enabled_events[0] !== STRIPE_EVENT) {
      throw new Error("Stripe webhook endpoint creation did not match the exact TEST-A contract.");
    }
    secrets.push(stripeEndpoint.secret);
    apiEnvironment.STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET.value = stripeEndpoint.secret;
    await setVercelEnv(
      APP_PROJECT,
      APP_ROOT,
      "STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET",
      stripeEndpoint.secret,
      true,
    );
  }

  const finalApi = await deployVercel(APP_DEPLOY_ROOT, APP_PROJECT, true, APP_SHA, APP_TREE);
  await protectedDeploymentHealth(finalApi.url, APP_DEPLOY_ROOT);
  await stripeJson([
    "post", `/v1/webhook_endpoints/${stripeEndpoint.id}`, "--confirm",
    "--data", `url=${finalApi.url}/api/customer-flow/webhooks/stripe`,
    "--data", "disabled=false",
  ]);
  await run("npx", ["vercel", "alias", "set", finalApi.url, API_ALIAS, "--scope", SCOPE], { cwd: APP_ROOT });
  await health(API_BASE);
  const endpointCanonical = await stripeJson([
    "post", `/v1/webhook_endpoints/${stripeEndpoint.id}`, "--confirm",
    "--data", `url=${API_BASE}/webhooks/stripe`,
    "--data", "disabled=false",
  ]);
  if (endpointCanonical.url !== `${API_BASE}/webhooks/stripe`) {
    throw new Error("Stripe webhook endpoint did not bind the canonical URL.");
  }
  evidence.vercelApi = {
    projectId: APP_PROJECT,
    environmentVariableNames: apiEnvNames,
    bootstrapDeployment: bootstrap,
    finalDeployment: finalApi,
    canonicalUrl: `https://${API_ALIAS}`,
    health: await health(API_BASE),
  };
  evidence.stripe.endpoint = {
    id: stripeEndpoint.id,
    accountId: STRIPE_ACCOUNT,
    livemode: false,
    enabled: endpointCanonical.status === "enabled",
    url: endpointCanonical.url,
    events: endpointCanonical.enabled_events,
  };

  const landingEnvNames = await exactVercelEnvironment(LANDING_PROJECT, LANDING_ROOT, {
    VITE_FULFILLMENT_API_BASE_URL: { value: API_BASE, sensitive: false },
  });
  const landingDeployment = await deployVercel(
    LANDING_DEPLOY_ROOT,
    LANDING_PROJECT,
    false,
    LANDING_SHA,
    LANDING_TREE,
  );
  const landingRootResponse = await waitFor(async () => {
    const response = await fetch(`${LANDING_ORIGIN}/`, { redirect: "manual" });
    return response.status === 200 ? response : null;
  }, "canonical landing", 60, 1000);
  const landingTracking = await fetch(`${LANDING_ORIGIN}/suivi`, { redirect: "manual" });
  const landingNotFound = await fetch(`${LANDING_ORIGIN}/__test_a_not_found__`, { redirect: "manual" });
  if (landingTracking.status !== 200 || landingNotFound.status !== 200) {
    throw new Error("Canonical landing routes or error behavior do not match the release contract.");
  }
  evidence.warnings.push("Landing uses the approved SPA fallback: an unknown path returns index.html with HTTP 200; API unknown routes are verified separately as HTTP 404.");
  evidence.landing = {
    projectId: LANDING_PROJECT,
    environmentVariableNames: landingEnvNames,
    deployment: landingDeployment,
    canonicalOrigin: LANDING_ORIGIN,
    rootStatus: landingRootResponse.status,
    trackingStatus: landingTracking.status,
    notFoundStatus: landingNotFound.status,
  };

  const marker = `TESTA3F375E12${randomBytes(5).toString("hex").toUpperCase()}`;
  const syntheticIntake = {
    schemaVersion: "1.0",
    customer: { email: "delivered@resend.dev", consent: true },
    baby: {
      firstName: marker,
      nameArabic: "اختبار",
      gender: "neutral",
      birthDate: "2026-08-21",
    },
    languages: ["fr"],
    voicePreference: { enabled: false, gender: "male" },
    context: { religion: "none" },
    request: `${marker}-REQUEST`,
  };
  const intake = await requestJson(`${API_BASE}/v1/intakes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `intake:${marker}`,
      "x-test-a-access-token": accessToken,
      origin: LANDING_ORIGIN,
    },
    body: JSON.stringify(syntheticIntake),
  }, 201);
  secrets.push(intake.intakeToken);
  const checkout = await requestJson(`${API_BASE}/v1/jobs/${encodeURIComponent(intake.jobId)}/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${intake.intakeToken}`,
      "x-test-a-access-token": accessToken,
      origin: LANDING_ORIGIN,
    },
    body: "{}",
  }, 200);
  if (!checkout.sessionId?.startsWith("cs_test_") || !checkout.checkoutUrl?.startsWith("https://checkout.stripe.com/")) {
    throw new Error("Hosted checkout did not return an exact Stripe test session.");
  }

  const paymentMethod = await stripeJson([
    "post", "/v1/payment_methods", "-c",
    "-d", "type=card",
    "-d", "card[token]=tok_visa",
    "-d", "billing_details[email]=delivered@resend.dev",
    "-d", `billing_details[name]=${marker}`,
  ]);
  if (!paymentMethod.id?.startsWith("pm_")) throw new Error("Stripe test payment method was not created.");
  await stripeJson([
    "post", `/v1/payment_pages/${checkout.sessionId}/confirm`, "-c",
    "-d", `payment_method=${paymentMethod.id}`,
    "-d", "expected_amount=3900",
  ]);

  const paidStatus = await waitFor(async () => {
    const status = await requestJson(`${API_BASE}/v1/jobs/${encodeURIComponent(intake.jobId)}`, {
      headers: {
        authorization: `Bearer ${intake.intakeToken}`,
        "x-test-a-access-token": accessToken,
        origin: LANDING_ORIGIN,
      },
    });
    return status.payment === "paid" ? status : null;
  }, "Stripe provider delivery and durable payment", 60, 1000);

  const stripeEvents = await stripeJson([
    "get", "/v1/events", "--limit", "20",
    "-d", `type=${STRIPE_EVENT}`,
  ]);
  const providerEvent = stripeEvents.data.find((entry) => entry.data?.object?.id === checkout.sessionId);
  if (!providerEvent?.id) throw new Error("Stripe event identity for the completed session was not found.");
  const stripeSession = await stripeJson(["get", `/v1/checkout/sessions/${checkout.sessionId}`]);
  if (stripeSession.payment_status !== "paid" || stripeSession.amount_total !== 3900
      || String(stripeSession.currency).toLowerCase() !== "eur"
      || stripeSession.metadata?.job_id !== intake.jobId) {
    throw new Error("Stripe Checkout Session does not match the authorized TEST-A contract.");
  }

  const convexClient = new ConvexHttpClient(CONVEX_URL);
  const customerJob = await convexClient.query("customerFlow:readJob", { backendToken, jobId: intake.jobId });
  const storedProviderEvent = await convexClient.query("customerFlow:readProviderEvent", {
    backendToken,
    providerEventId: providerEvent.id,
  });
  const fulfillmentStore = createConvexFulfillmentStore({ client: convexClient, backendToken });
  const aggregateBeforeReplay = await fulfillmentStore.getJob(intake.jobId);
  if (customerJob.payment?.acceptedEventId !== providerEvent.id
      || storedProviderEvent?.result?.jobId !== intake.jobId
      || aggregateBeforeReplay.state !== "generation_queued") {
    throw new Error("Convex durable correlation did not bind the exact Stripe provider event.");
  }
  const customerRaw = JSON.stringify(customerJob);
  const markerOccurrences = customerRaw.split(marker).length - 1;
  const tokenOccurrences = customerRaw.split(intake.intakeToken).length - 1;
  if (markerOccurrences !== 2 || tokenOccurrences !== 0 || "payload" in storedProviderEvent) {
    throw new Error("Durable privacy assertions failed for exact markers or replay material.");
  }

  await run("stripe", [
    "events", "resend", providerEvent.id,
    "--webhook-endpoint", stripeEndpoint.id,
    "-c", "--color", "off",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const replayProviderEvent = await convexClient.query("customerFlow:readProviderEvent", {
    backendToken,
    providerEventId: providerEvent.id,
  });
  const aggregateAfterReplay = await fulfillmentStore.getJob(intake.jobId);
  const customerAfterReplay = await convexClient.query("customerFlow:readJob", { backendToken, jobId: intake.jobId });
  if (aggregateAfterReplay.version !== aggregateBeforeReplay.version
      || customerAfterReplay.version !== customerJob.version
      || JSON.stringify(replayProviderEvent) !== JSON.stringify(storedProviderEvent)) {
    throw new Error("Duplicate Stripe replay changed durable state.");
  }

  const workspace = createLocalGenerationWorkspace({ rootPath: GENERATION_ROOT });
  await workspace.persistJobInput({
    jobId: intake.jobId,
    intakeDigest: customerJob.intakeDigest,
    intake: syntheticIntake,
  });
  const localHandlers = createLocalCommandStageHandlers({
    resolveJobPaths: workspace.resolveJobPaths,
    collectArtifactSet: workspace.collectArtifactSet,
    cleanupStageOutput: workspace.cleanupStageOutput,
    commands: {
      tts: async () => { throw new Error("Narration is disabled for this TEST-A job."); },
    },
  });
  const retryPolicy = {
    leaseMsByStage: {
      prepare_review: 300000,
      render_approved: 300000,
      generate_tts: 300000,
      publish: 300000,
      deliver: 300000,
    },
    maxAttemptsByStage: {
      prepare_review: 1,
      render_approved: 1,
      generate_tts: 1,
      publish: 1,
      deliver: 1,
    },
    backoffMsByStage: {
      prepare_review: 1000,
      render_approved: 1000,
      generate_tts: 1000,
      publish: 1000,
      deliver: 1000,
    },
  };
  const orchestrator = createFulfillmentOrchestrator({
    store: fulfillmentStore,
    handlers: localHandlers,
    clock: () => new Date().toISOString(),
    tokenFactory: () => randomUUID(),
    retryPolicy,
  });
  const reviewStatus = await orchestrator.runNext(intake.jobId);
  if (reviewStatus?.state !== "content_review_required") {
    throw new Error(`Private review generation ended in ${reviewStatus?.state || "unknown"}.`);
  }
  const reviewPaths = await workspace.resolveJobPaths(reviewStatus);
  const privateReview = await workspace.collectArtifactSet({ kind: "private_review", paths: reviewPaths });

  evidence.stripe.checkout = {
    sessionId: checkout.sessionId,
    paymentIntentId: stripeSession.payment_intent,
    providerEventId: providerEvent.id,
    paymentStatus: stripeSession.payment_status,
    amountMinor: stripeSession.amount_total,
    currency: String(stripeSession.currency).toUpperCase(),
    automaticDeliveryObserved: true,
    duplicateReplayAcceptedByProvider: true,
  };
  evidence.proof = {
    jobId: intake.jobId,
    publicStatusAfterPayment: paidStatus,
    customerJobVersionBeforeReplay: customerJob.version,
    customerJobVersionAfterReplay: customerAfterReplay.version,
    aggregateVersionBeforeReplay: aggregateBeforeReplay.version,
    aggregateVersionAfterReplay: aggregateAfterReplay.version,
    providerEventFingerprint: storedProviderEvent.fingerprint,
    markerOccurrencesInCanonicalJob: markerOccurrences,
    plaintextIntakeTokenOccurrences: tokenOccurrences,
    providerPayloadStored: false,
  };
  evidence.review = {
    state: reviewStatus.state,
    revisionId: reviewStatus.currentRevisionId,
    privateReviewRoot: reviewPaths.reviewRoot,
    artifactSetId: privateReview.artifactSetId,
    pageDigest: privateReview.pageDigest,
    transcriptDigest: privateReview.transcriptDigest,
    assetManifestDigest: privateReview.assetManifestDigest,
    humanApprovalPersisted: false,
  };
  evidence.finishedAt = new Date().toISOString();
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    status: "awaiting_human_artifact_approval",
    evidencePath: EVIDENCE_PATH,
    reviewRoot: reviewPaths.reviewRoot,
    jobId: intake.jobId,
    endpointId: stripeEndpoint.id,
    appDeploymentId: finalApi.id,
    landingDeploymentId: landingDeployment.id,
  }));
} catch (error) {
  evidence.failedAt = new Date().toISOString();
  evidence.failure = scrub(error.message);
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  if (stripeEndpoint?.id) {
    try {
      await stripeJson([
        "post", `/v1/webhook_endpoints/${stripeEndpoint.id}`, "--confirm",
        "--data", "disabled=true",
      ]);
      evidence.rollback = { stripeEndpointDisabled: true };
      await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  }
  console.error(scrub(error.stack || error.message));
  process.exitCode = 1;
} finally {
  if (deployKey) {
    try {
      await run("npx", ["convex", "deployment", "token", "delete", TOKEN_NAME, "--deployment", CONVEX_DEPLOYMENT]);
    } catch (error) {
      evidence.warnings.push(`Convex deploy token cleanup failed: ${scrub(error.message)}`);
      await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    }
  }
}
