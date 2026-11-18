import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { verifyTallySignature } from "../../src/webhooks/tally.mjs";

test("an invalid Tally signature is rejected", () => {
  const rawBody = Buffer.from('{"eventId":"evt_tally_001"}', "utf8");

  assert.equal(
    verifyTallySignature(rawBody, "invalid-signature", "test-signing-secret"),
    false,
  );
});

test("a correctly signed Tally payload is accepted", () => {
  const rawBody = Buffer.from('{"eventId":"evt_tally_001"}', "utf8");
  const secret = "test-signing-secret";
  const signature = createHmac("sha256", secret).update(rawBody).digest("base64");

  assert.equal(verifyTallySignature(rawBody, signature, secret), true);
});
