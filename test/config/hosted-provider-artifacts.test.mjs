import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const landingOrigin = "https://www.bebebonjour.com";
const successUrl = `${landingOrigin}/suivi?checkout=success`;
const cancelUrl = `${landingOrigin}/suivi?checkout=cancel`;

const [environmentExample, providerManifest, releaseCandidate] = await Promise.all([
  readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  readFile(new URL("../../ops/test-a-hosted-provider-manifest.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(
    new URL("../../openspec/reports/2026-08-18-test-a-hosted-provider-release-candidate.md", import.meta.url),
    "utf8",
  ),
]);

function environmentValue(name) {
  const matches = [...environmentExample.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  assert.equal(matches.length, 1, `${name} must be declared exactly once`);
  return matches[0][1];
}

test("hosted TEST-A artifacts pin CORS and checkout callbacks to the active landing origin", () => {
  assert.equal(environmentValue("CUSTOMER_FLOW_ALLOWED_ORIGINS"), JSON.stringify([landingOrigin]));
  assert.equal(environmentValue("STRIPE_CHECKOUT_SUCCESS_URL"), successUrl);
  assert.equal(environmentValue("STRIPE_CHECKOUT_CANCEL_URL"), cancelUrl);

  assert.deepEqual(providerManifest.vercelApi.allowedOrigins, [landingOrigin]);
  assert.deepEqual(providerManifest.stripe.checkoutCallbacks, {
    successUrl,
    cancelUrl,
  });

  assert.ok(releaseCandidate.includes(`CUSTOMER_FLOW_ALLOWED_ORIGINS=${JSON.stringify([landingOrigin])}`));
  assert.ok(releaseCandidate.includes(`STRIPE_CHECKOUT_SUCCESS_URL=${successUrl}`));
  assert.ok(releaseCandidate.includes(`STRIPE_CHECKOUT_CANCEL_URL=${cancelUrl}`));
});
