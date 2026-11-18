export function loadFulfillmentConfig(environment) {
  const priceMinor = requiredInteger(environment, "FULFILLMENT_PRICE_MINOR");
  if (priceMinor !== 3900) {
    throw new Error("FULFILLMENT_PRICE_MINOR must be 3900 for the current database contract.");
  }

  const currency = requiredString(environment, "FULFILLMENT_CURRENCY").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("FULFILLMENT_CURRENCY must be a three-letter currency code.");
  }
  if (currency !== "EUR") {
    throw new Error("FULFILLMENT_CURRENCY must be EUR for the current database contract.");
  }

  const supabaseUrl = requiredString(environment, "SUPABASE_URL");
  assertHttpsUrl(supabaseUrl, "SUPABASE_URL");
  const fieldMap = requiredJsonObject(environment, "TALLY_FIELD_MAP_JSON");

  return {
    supabase: {
      url: supabaseUrl,
      serviceRoleKey: requiredString(environment, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    tally: {
      signingSecret: requiredString(environment, "TALLY_WEBHOOK_SECRET"),
      normalization: {
        expectedFormId: requiredString(environment, "TALLY_FORM_ID"),
        expectedAmount: priceMinor / 100,
        expectedCurrency: currency,
        fieldMap,
      },
    },
    stripe: {
      signingSecret: requiredString(environment, "STRIPE_WEBHOOK_SECRET"),
      normalization: {
        expectedAmountMinor: priceMinor,
        expectedCurrency: currency,
      },
    },
  };
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requiredInteger(environment, name) {
  const raw = requiredString(environment, name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return value;
}

function requiredJsonObject(environment, name) {
  const raw = requiredString(environment, name);
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must contain a JSON object.`);
  }
  return value;
}

function assertHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid URL.`, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
}
