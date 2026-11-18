import { CustomerFlowError } from "../customer-flow/service.mjs";

export function createHostedAbuseBudget({ client, backendToken }) {
  if (typeof client?.mutation !== "function" || typeof backendToken !== "string"
      || backendToken.length < 32) throw new Error("Abuse budget configuration is incomplete.");
  return async function consumeBudget(scope) {
    let result;
    try {
      result = await client.mutation("abuse:consume", { backendToken, scope });
    } catch {
      throw new CustomerFlowError(503, "abuse_control_unavailable", "Request admission is unavailable.");
    }
    if (result?.allowed === true && result.retryAfterSeconds === 0) return;
    if (result?.allowed === false && Number.isInteger(result.retryAfterSeconds)
        && result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 86_400) {
      const error = new CustomerFlowError(429, "rate_limited", "Request limit reached.");
      error.retryAfterSeconds = result.retryAfterSeconds;
      throw error;
    }
    throw new CustomerFlowError(503, "abuse_control_unavailable", "Request admission is unavailable.");
  };
}
