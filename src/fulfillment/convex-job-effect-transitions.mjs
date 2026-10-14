import { createJobEffectTransitions } from "./job-effect-transitions.mjs";

// Convex mutations use Web Crypto; Node callers retain their synchronous API.
export const {
  recoverUnfencedNarrationEffectTransition,
  failStageTransition,
  reconcileAbsentExternalEffectTransition,
} = createJobEffectTransitions(withCommand, sameFailure);

async function withCommand(aggregate, command, eventType, at, mutate, replayPayload = command) {
  const commandId = command?.commandId;
  assertNonEmptyString(commandId, "commandId");
  assertTimestamp(at, "transition timestamp");
  const commandDigest = await sha256(`${eventType}\0${canonicalJson(replayPayload)}`);
  const replay = aggregate.events.find((event) => event.commandId === commandId);
  if (replay) {
    if (replay.type !== eventType || replay.commandDigest !== commandDigest) {
      throw new Error("Command replay does not match its original operation and payload.");
    }
    return structuredClone(aggregate);
  }
  if (Date.parse(at) < Date.parse(aggregate.updatedAt)) {
    throw new Error("Transition timestamp cannot precede the aggregate's current version.");
  }
  const next = structuredClone(aggregate);
  mutate(next);
  next.version += 1;
  next.updatedAt = at;
  next.events.push({
    eventId: `event_${(await sha256(`${next.jobId}\0${commandId}`)).slice(0, 24)}`,
    commandId,
    commandDigest,
    type: eventType,
    at,
    state: next.state,
  });
  return next;
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Commands must contain deterministic JSON values only.");
}

function assertTimestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
}

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The only equality used by these guards compares the exact two-field failure
// record. Reject extra keys, symbols and non-plain objects just as Node does.
function sameFailure(actual, expected) {
  if (!actual || Object.getPrototypeOf(actual) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(actual);
  return keys.length === 2
    && keys.includes("retryable") && keys.includes("reasonCode")
    && actual.retryable === expected.retryable
    && actual.reasonCode === expected.reasonCode;
}
