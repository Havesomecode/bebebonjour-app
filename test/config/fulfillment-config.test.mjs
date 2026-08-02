import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadFulfillmentConfig } from "../../src/config/fulfillment-config.mjs";

const fieldMap = JSON.parse(
  await readFile(new URL("../fixtures/tally-field-map.json", import.meta.url), "utf8"),
);

const environment = {
  FULFILLMENT_PRICE_MINOR: "3900",
  FULFILLMENT_CURRENCY: "eur",
  TALLY_FORM_ID: "form_test_001",
  TALLY_FIELD_MAP_JSON: JSON.stringify(fieldMap),
  TALLY_WEBHOOK_SECRET: "tally-secret",
  STRIPE_WEBHOOK_SECRET: "stripe-secret",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

test("production fulfillment configuration is parsed without implicit secrets", () => {
  const config = loadFulfillmentConfig(environment);

  assert.deepEqual(config, {
    supabase: {
      url: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
    },
    tally: {
      signingSecret: "tally-secret",
      normalization: {
        expectedFormId: "form_test_001",
        expectedAmount: 39,
        expectedCurrency: "EUR",
        fieldMap,
      },
    },
    stripe: {
      signingSecret: "stripe-secret",
      normalization: {
        expectedAmountMinor: 3900,
        expectedCurrency: "EUR",
      },
    },
  });
});

test("missing production secrets fail closed", () => {
  assert.throws(
    () => loadFulfillmentConfig({ ...environment, TALLY_WEBHOOK_SECRET: "" }),
    /TALLY_WEBHOOK_SECRET/,
  );
});

test("production price and currency cannot drift from the database contract", () => {
  assert.throws(
    () => loadFulfillmentConfig({ ...environment, FULFILLMENT_PRICE_MINOR: "4000" }),
    /3900/,
  );
  assert.throws(
    () => loadFulfillmentConfig({ ...environment, FULFILLMENT_CURRENCY: "USD" }),
    /EUR/,
  );
});
