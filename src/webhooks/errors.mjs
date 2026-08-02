export class WebhookRequestError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message, options);
    this.name = "WebhookRequestError";
    this.statusCode = statusCode;
  }
}
