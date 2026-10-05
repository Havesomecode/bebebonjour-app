export const NARRATION_CONTROL_ACTIONS = Object.freeze([
  "approve_content",
  "request_content_changes",
  "reject_content",
  "render",
  "approve_narration",
  "request_narration_changes",
  "reject_narration",
]);
export const NARRATION_GENERATION_ACTIONS = Object.freeze([
  "generate_narration",
]);
export const NARRATION_ACTIONS = Object.freeze([
  ...NARRATION_CONTROL_ACTIONS,
  ...NARRATION_GENERATION_ACTIONS,
]);

export function assertNarrationToken(value) {
  const control = process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN;
  const generation = process.env.BEBEBONJOUR_TTS_WORKER_TOKEN;
  const others = [
    "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_OPERATIONS_TOKEN",
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OWNER_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",
  ];
  if (
    !value ||
    value.length < 32 ||
    !control ||
    control.length < 32 ||
    !generation ||
    generation.length < 32 ||
    control === generation ||
    others.some((key) => process.env[key] === value)
  ) {
    throw new Error("Unauthorized narration capability.");
  }
  if (value === control) return "narration_control";
  if (value === generation) return "narration_generation";
  throw new Error("Unauthorized narration capability.");
}

export function assertNarrationClaim(scope, args) {
  const validActions =
    scope === "narration_generation"
      ? Array.isArray(args.actions) &&
        args.actions.length === 1 &&
        args.actions[0] === "generate_narration"
      : scope === "narration_control"
        ? Array.isArray(args.actions) &&
          args.actions.length > 0 &&
          new Set(args.actions).size === args.actions.length &&
          args.actions.every((action) => NARRATION_CONTROL_ACTIONS.includes(action))
        : false;
  if (
    (args.jobId !== undefined &&
      !/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(args.jobId)) ||
    args.workerId !== "hosted-narration-worker" ||
    args.limit !== 1 ||
    args.leaseMs !== 300_000 ||
    !validActions
  ) {
    throw new Error("Narration claim scope rejected.");
  }
}

export function assertNarrationCommand(scope, command, args) {
  const actions =
    scope === "narration_generation"
      ? new Set(NARRATION_GENERATION_ACTIONS)
      : scope === "narration_control"
        ? new Set(NARRATION_CONTROL_ACTIONS)
        : null;
  if (
    !actions ||
    !command ||
    !actions.has(command.action) ||
    args.workerId !== "hosted-narration-worker" ||
    (args.leaseMs !== undefined && args.leaseMs !== 300_000)
  ) {
    throw new Error("Narration command scope rejected.");
  }
}
