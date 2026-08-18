import Stripe from "stripe";

const PRICE_MINOR = 3900;
const CURRENCY = "EUR";

export function createStripeTestPaymentGateway(options = {}) {
  const stripe = options.stripe || createStripeClient(options.apiKey);
  const successUrl = requireHttpsUrl(options.successUrl, "Stripe success URL");
  const cancelUrl = requireHttpsUrl(options.cancelUrl, "Stripe cancel URL");

  return {
    async createCheckoutSession(request) {
      assertCheckoutRequest(request);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: request.customerEmail,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: CURRENCY.toLowerCase(),
            unit_amount: PRICE_MINOR,
            product_data: { name: "Faire-part numérique Bébé Bonjour" },
          },
        }],
        metadata: request.metadata,
        payment_intent_data: { metadata: request.paymentIntentMetadata },
        success_url: successUrl,
        cancel_url: cancelUrl,
      }, { idempotencyKey: request.idempotencyKey });

      if (
        session?.livemode !== false
        || typeof session.id !== "string"
        || !session.id.startsWith("cs_test_")
        || !isHttpsUrl(session.url)
      ) {
        throw new Error("Stripe returned an invalid test Checkout Session.");
      }
      return { id: session.id, url: session.url, mode: "test" };
    },
  };
}

function createStripeClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.startsWith("sk_test_")) {
    throw new Error("A Stripe test-mode secret key is required.");
  }
  return new Stripe(apiKey, { maxNetworkRetries: 2 });
}

function assertCheckoutRequest(request) {
  if (
    !request
    || request.amountMinor !== PRICE_MINOR
    || request.currency !== CURRENCY
    || typeof request.customerEmail !== "string"
    || typeof request.idempotencyKey !== "string"
    || !request.metadata
    || request.metadata.environment !== "test"
    || request.metadata.project !== "bebebonjour"
    || request.metadata.product !== "announcement-page"
    || request.paymentIntentMetadata?.job_id !== request.metadata.job_id
    || request.paymentIntentMetadata?.intake_digest !== request.metadata.intake_digest
  ) {
    throw new Error("Stripe Checkout request does not match the TEST-A payment contract.");
  }
}

function requireHttpsUrl(value, label) {
  if (!isHttpsUrl(value)) throw new Error(`${label} must be an HTTPS URL.`);
  return value;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
