import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertValidCodexCompositionReceipt,
  assertValidCodexSubscriptionComposition,
  buildCodexCompositionPrompt,
  buildCodexCompositionRequest,
  CODEX_SUBSCRIPTION_ADAPTER_VERSION,
  CODEX_SUBSCRIPTION_PROVIDER,
  codexSubscriptionCompositionSchema,
  sha256,
} from "../../scripts/lib/codex-subscription-composition.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const DISABLED_FEATURES = Object.freeze([
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
]);
const SAFE_ENVIRONMENT_KEYS = Object.freeze(["CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);

export class CodexSubscriptionCompositionError extends Error {
  constructor(reasonCode, { retryable }) {
    super(reasonCode);
    this.name = "CodexSubscriptionCompositionError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export function createCodexSubscriptionComposer(options = {}) {
  const executable = requiredExecutable(options.executable || "codex");
  const executableArgs = requiredExecutableArgs(options.executableArgs || []);
  const model = options.model === undefined ? "gpt-5.6-sol" : requiredModel(options.model);
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const spawnImpl = options.spawnImpl || spawn;
  const probeImpl = options.probeImpl || defaultProbe;
  const authStateStore = options.authStateStore || null;
  if (typeof spawnImpl !== "function") throw safeError("composition_configuration_rejected", false);
  if (typeof probeImpl !== "function") throw safeError("composition_configuration_rejected", false);
  if (authStateStore !== null && !hasAuthStateStoreShape(authStateStore)) {
    throw safeError("composition_configuration_rejected", false);
  }
  const environment = projectEnvironment(options.environment || process.env);
  const receiptCache = new Map();

  return Object.freeze({
    async readiness() {
      const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-readiness-"));
      try {
        return await withAuthSession({ authStateStore, environment, sandboxRoot }, async (sessionEnvironment) => {
          const cliVersion = await probeReadiness({
            executable,
            executableArgs,
            environment: sessionEnvironment,
            probeImpl,
            sandboxRoot,
            timeoutMs,
          });
          return Object.freeze({
            status: "ready",
            provider: CODEX_SUBSCRIPTION_PROVIDER,
            model,
            adapterVersion: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
            authMode: authStateStore
              ? "managed-chatgpt-ephemeral"
              : "local-chatgpt-subscription",
            cliVersion,
          });
        });
      } catch (error) {
        throw preserveSafeError(error, "composition_provider_unavailable", true);
      } finally {
        await rm(sandboxRoot, { recursive: true, force: true });
      }
    },

    async compose(intake, invocation = {}) {
      const request = buildCodexCompositionRequest(intake);
      const requestDigest = sha256(JSON.stringify({
        adapterVersion: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
        provider: CODEX_SUBSCRIPTION_PROVIDER,
        model,
        request,
      }));
      const signal = invocation.signal;
      if (signal !== undefined && !isAbortSignal(signal)) {
        throw safeError("composition_configuration_rejected", false);
      }
      if (signal?.aborted) throw safeError("composition_cancelled", true);

      const cached = receiptCache.get(requestDigest);
      if (cached) return structuredClone(cached);

      const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "bebebonjour-codex-compose-"));
      try {
        const schemaPath = path.join(sandboxRoot, "output.schema.json");
        const outputPath = path.join(sandboxRoot, "output.json");
        await writeFile(
          schemaPath,
          `${JSON.stringify(codexSubscriptionCompositionSchema, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        const args = [...executableArgs, ...codexArguments({ schemaPath, outputPath, model })];
        await withAuthSession({ authStateStore, environment, sandboxRoot }, async (sessionEnvironment) => {
          if (authStateStore) {
            await probeReadiness({
              executable,
              executableArgs,
              environment: sessionEnvironment,
              probeImpl,
              sandboxRoot,
              timeoutMs,
            });
          }
          await runCodexProcess({
            executable,
            args,
            cwd: sandboxRoot,
            environment: sessionEnvironment,
            prompt: buildCodexCompositionPrompt(request),
            signal,
            spawnImpl,
            timeoutMs,
          });
        });
        const composition = await readCompositionOutput(outputPath);
        const receipt = {
          composition,
          metadata: {
            adapterVersion: CODEX_SUBSCRIPTION_ADAPTER_VERSION,
            provider: CODEX_SUBSCRIPTION_PROVIDER,
            model,
            requestDigest,
            outputDigest: sha256(JSON.stringify(composition)),
          },
        };
        assertValidCodexCompositionReceipt(receipt);
        receiptCache.set(requestDigest, structuredClone(receipt));
        return structuredClone(receipt);
      } finally {
        await rm(sandboxRoot, { recursive: true, force: true });
      }
    },
  });
}

async function withAuthSession({ authStateStore, environment, sandboxRoot }, operation) {
  if (!authStateStore) return operation(environment);

  let lease;
  try {
    lease = await authStateStore.claim();
  } catch (error) {
    throw preserveSafeError(error, "composition_auth_restore_failed", true);
  }
  const codexHome = path.join(sandboxRoot, "codex-home");
  try {
    if (typeof lease?.authJson !== "string" || Buffer.byteLength(lease.authJson, "utf8") > 64 * 1024) {
      throw new Error("invalid auth state");
    }
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(path.join(codexHome, "auth.json"), lease.authJson, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    try {
      await authStateStore.release(lease);
    } catch {
      // The durable lease expiry remains the recovery boundary.
    }
    throw safeError("composition_auth_restore_failed", true);
  }

  const sessionEnvironment = { ...environment, CODEX_HOME: codexHome };
  delete sessionEnvironment.HOME;
  let result;
  let operationError;
  try {
    result = await operation(Object.freeze(sessionEnvironment));
  } catch (error) {
    operationError = error;
  }

  let refreshedAuth;
  try {
    const authPath = path.join(codexHome, "auth.json");
    const metadata = await lstat(authPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
      throw new Error("unsafe refreshed auth state");
    }
    refreshedAuth = await readFile(authPath, "utf8");
    await authStateStore.commit(lease, refreshedAuth);
  } catch (error) {
    throw preserveSafeError(error, "composition_auth_writeback_failed", true);
  }
  if (operationError) {
    throw preserveSafeError(operationError, "composition_provider_failed", true);
  }
  return result;
}

async function probeReadiness({
  executable,
  executableArgs,
  environment,
  probeImpl,
  sandboxRoot,
  timeoutMs,
}) {
  const commandOptions = {
    cwd: sandboxRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024,
    timeout: Math.min(timeoutMs, 5_000),
  };
  const versionResult = await probeImpl(executable, [...executableArgs, "--version"], commandOptions);
  const statusResult = await probeImpl(
    executable,
    [...executableArgs, "login", "status"],
    commandOptions,
  );
  const versionMatch = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/u.exec(
    versionResult?.stdout || "",
  );
  const loginStatus = `${statusResult?.stdout || ""}${statusResult?.stderr || ""}`;
  if (!versionMatch || !/^Logged in using ChatGPT\s*$/u.test(loginStatus)) {
    throw safeError("composition_provider_unavailable", true);
  }
  return versionMatch[1];
}

function codexArguments({ schemaPath, outputPath, model }) {
  return [
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--color", "never",
    ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ...(model === "codex-cli-default" ? [] : ["--model", model]),
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "-",
  ];
}

async function runCodexProcess({
  executable,
  args,
  cwd,
  environment,
  prompt,
  signal,
  spawnImpl,
  timeoutMs,
}) {
  let child;
  try {
    child = spawnImpl(executable, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw safeError("composition_provider_failed", true);
  }
  if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
    throw safeError("composition_provider_failed", true);
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let processOutputBytes = 0;
    let forceKillTimer = null;

    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", cancel);
      operation();
    };
    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The close or error event remains the source of truth.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already be gone.
        }
      }, 1_000);
      forceKillTimer.unref?.();
    };
    const cancel = () => {
      cancelled = true;
      terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const countOutput = (chunk) => {
      processOutputBytes += Buffer.byteLength(chunk);
      if (processOutputBytes > MAX_PROCESS_OUTPUT_BYTES && !timedOut && !cancelled) {
        timedOut = true;
        terminate();
      }
    };
    child.stdout?.on?.("data", countOutput);
    child.stderr?.on?.("data", countOutput);
    child.once("error", () => finish(() => reject(safeError(
      cancelled ? "composition_cancelled" : "composition_provider_failed",
      true,
    ))));
    child.once("close", (code) => finish(() => {
      if (cancelled) return reject(safeError("composition_cancelled", true));
      if (timedOut) return reject(safeError("composition_timeout", true));
      if (code !== 0) return reject(safeError("composition_provider_failed", true));
      return resolve();
    }));
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      child.stdin.end(prompt);
    } catch {
      finish(() => reject(safeError("composition_provider_failed", true)));
    }
  });
}

async function readCompositionOutput(outputPath) {
  let metadata;
  try {
    metadata = await lstat(outputPath);
  } catch {
    throw safeError("composition_output_rejected", false);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OUTPUT_BYTES) {
    throw safeError("composition_output_rejected", false);
  }
  let composition;
  try {
    composition = JSON.parse(await readFile(outputPath, "utf8"));
    assertValidCodexSubscriptionComposition(composition);
  } catch {
    throw safeError("composition_output_rejected", false);
  }
  return composition;
}

function defaultProbe(command, args, options) {
  return execFileAsync(command, args, options);
}

function projectEnvironment(environment) {
  return Object.freeze(Object.fromEntries(
    SAFE_ENVIRONMENT_KEYS
      .filter((key) => typeof environment[key] === "string" && environment[key] !== "")
      .map((key) => [key, environment[key]]),
  ));
}

function requiredExecutable(value) {
  if (typeof value !== "string" || !/^(?:\/[A-Za-z0-9._+-]+)+$|^[A-Za-z0-9._+-]+$/u.test(value)) {
    throw safeError("composition_configuration_rejected", false);
  }
  return value;
}

function requiredExecutableArgs(value) {
  if (
    !Array.isArray(value)
    || value.length > 4
    || value.some((entry) => (
      typeof entry !== "string"
      || !path.isAbsolute(entry)
      || path.normalize(entry) !== entry
    ))
  ) {
    throw safeError("composition_configuration_rejected", false);
  }
  return Object.freeze([...value]);
}

function requiredModel(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw safeError("composition_configuration_rejected", false);
  }
  return value;
}

function boundedTimeout(value) {
  if (!Number.isInteger(value) || value < 10 || value > 300_000) {
    throw safeError("composition_configuration_rejected", false);
  }
  return value;
}

function isAbortSignal(value) {
  return value
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function hasAuthStateStoreShape(value) {
  return typeof value?.claim === "function"
    && typeof value.commit === "function"
    && typeof value.release === "function";
}

function preserveSafeError(error, fallbackReasonCode, fallbackRetryable) {
  if (
    typeof error?.reasonCode === "string"
    && /^[a-z0-9_]{1,64}$/u.test(error.reasonCode)
    && typeof error.retryable === "boolean"
  ) {
    return safeError(error.reasonCode, error.retryable);
  }
  return safeError(fallbackReasonCode, fallbackRetryable);
}


function safeError(reasonCode, retryable) {
  return new CodexSubscriptionCompositionError(reasonCode, { retryable });
}
