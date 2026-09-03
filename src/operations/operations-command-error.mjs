const REASON_CODE = /^[a-z0-9][a-z0-9_]{2,63}$/u;

export class OperationsCommandError extends Error {
  constructor(reasonCode, options = {}) {
    if (!REASON_CODE.test(reasonCode || "")) throw new Error("Operations reason code is invalid.");
    super(reasonCode, options.cause ? { cause: options.cause } : undefined);
    this.name = "OperationsCommandError";
    this.reasonCode = reasonCode;
    this.retryable = options.retryable === true;
  }
}
