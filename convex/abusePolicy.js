// Deployment-wide attempts, not identities. Exactly five reusable rows.
// Fixed UTC windows may admit a double burst at a boundary.
export const ABUSE_POLICY = Object.freeze({
  intake: { minute: 30, day: 300 },
  checkout: { minute: 60, day: 600 },
  status: { minute: 600, day: 20_000 },
  stripe: { minute: 300, day: 10_000 },
  tally: { minute: 60, day: 1_000 },
});

export function advanceBudget(existing, scope, nowMs) {
  const policy = Object.hasOwn(ABUSE_POLICY, scope) ? ABUSE_POLICY[scope] : null;
  if (!policy || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid abuse budget request.");
  }
  const minuteStartedAtMs = Math.floor(nowMs / 60_000) * 60_000;
  const dayStartedAtMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const minuteAttempts = existing?.minuteStartedAtMs === minuteStartedAtMs
    ? existing.minuteAttempts : 0;
  const dayAttempts = existing?.dayStartedAtMs === dayStartedAtMs
    ? existing.dayAttempts : 0;
  const retryAfterMs = Math.max(
    minuteAttempts >= policy.minute ? minuteStartedAtMs + 60_000 - nowMs : 0,
    dayAttempts >= policy.day ? dayStartedAtMs + 86_400_000 - nowMs : 0,
  );
  if (retryAfterMs > 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1_000), next: null };
  }
  return {
    allowed: true,
    retryAfterSeconds: 0,
    next: { scope, minuteStartedAtMs, dayStartedAtMs,
      minuteAttempts: minuteAttempts + 1, dayAttempts: dayAttempts + 1 },
  };
}
