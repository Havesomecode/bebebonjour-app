export function loadHostedCustomerFlowConfig(environment = {}) {
  const allowedOrigins = requiredJsonArray(environment, "CUSTOMER_FLOW_ALLOWED_ORIGINS");
  for (const origin of allowedOrigins) assertHttpsOrigin(origin, "CUSTOMER_FLOW_ALLOWED_ORIGINS");
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new Error("CUSTOMER_FLOW_ALLOWED_ORIGINS must not contain duplicates.");
  }

  const secretKey = requiredString(environment, "STRIPE_SECRET_KEY");
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe test-mode key.");
  }
  const webhookSecret = requiredString(environment, "STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET");
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET must be a Stripe webhook signing secret.");
  }

  const backendToken = requiredString(environment, "CUSTOMER_FLOW_BACKEND_TOKEN");
  if (backendToken.length < 32) {
    throw new Error("CUSTOMER_FLOW_BACKEND_TOKEN must contain at least 32 characters.");
  }

  return {
    convex: {
      url: assertHttpsUrl(requiredString(environment, "CONVEX_URL"), "CONVEX_URL"),
      backendToken,
      tokenEncryptionKey: requiredBase64Key(environment, "CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY"),
    },
    testAccessToken: requiredSecret(environment, "CUSTOMER_FLOW_TEST_ACCESS_TOKEN", 32),
    allowedOrigins,
    stripe: {
      secretKey,
      webhookSecret,
      successUrl: assertHttpsUrl(
        requiredString(environment, "STRIPE_CHECKOUT_SUCCESS_URL"),
        "STRIPE_CHECKOUT_SUCCESS_URL",
      ),
      cancelUrl: assertHttpsUrl(
        requiredString(environment, "STRIPE_CHECKOUT_CANCEL_URL"),
        "STRIPE_CHECKOUT_CANCEL_URL",
      ),
    },
  };
}

export function loadResendDeliveryConfig(environment = {}) {
  return {
    apiKey: requiredPrefix(environment, "RESEND_API_KEY", "re_"),
    from: requiredString(environment, "RESEND_FROM"),
  };
}

function requiredString(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  return value.trim();
}

function requiredPrefix(environment, name, prefix) {
  const value = requiredString(environment, name);
  if (!value.startsWith(prefix)) throw new Error(`${name} has an invalid format.`);
  return value;
}

function requiredSecret(environment, name, minimumLength) {
  const value = requiredString(environment, name);
  if (value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters.`);
  }
  return value;
}

function requiredBase64Key(environment, name) {
  const value = requiredString(environment, name);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, "base64").length !== 32) {
    throw new Error(`${name} must be base64 for exactly 32 bytes.`);
  }
  return value;
}

function requiredJsonArray(environment, name) {
  let value;
  try {
    value = JSON.parse(requiredString(environment, name));
  } catch (error) {
    throw new Error(`${name} must contain a JSON array.`, { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must contain a non-empty JSON string array.`);
  }
  return value;
}

function assertHttpsOrigin(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} entries must be exact HTTPS origins.`);
  }
}

function assertHttpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment.`);
  }
  return value;
}
