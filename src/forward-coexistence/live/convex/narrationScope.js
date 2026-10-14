export const NARRATION_ACTIONS = Object.freeze([
  "approve_content",
  "request_content_changes",
  "reject_content",
  "render",
  "generate_narration",
  "approve_narration",
  "request_narration_changes",
  "reject_narration",
]);
export function assertNarrationToken(value) {
  const expected = process.env.BEBEBONJOUR_NARRATION_WORKER_TOKEN;
  const others = [
    "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_OPERATIONS_TOKEN",
    "BEBEBONJOUR_OPERATIONS_WORKER_TOKEN",
    "BEBEBONJOUR_COMPLETION_WORKER_TOKEN",
    "BEBEBONJOUR_OPS_RATE_LIMIT_TOKEN",
  ];
  if (
    !expected ||
    expected.length < 32 ||
    value !== expected ||
    others.some((key) => process.env[key] === expected)
  )
    throw new Error("Unauthorized narration capability.");
}
export function assertNarrationClaim(args) {
  if (
    !/^job_[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(args.jobId || "") ||
    args.workerId !== "hosted-narration-worker" ||
    args.limit !== 1 ||
    args.leaseMs !== 300000 ||
    !args.actions.every((action) => NARRATION_ACTIONS.includes(action))
  )
    throw new Error("Narration claim scope rejected.");
}
export function assertNarrationCommand(command, args) {
  if (
    !command ||
    !NARRATION_ACTIONS.includes(command.action) ||
    args.workerId !== "hosted-narration-worker" ||
    (args.leaseMs !== undefined && args.leaseMs !== 300000)
  )
    throw new Error("Narration command scope rejected.");
}
