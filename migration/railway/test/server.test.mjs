import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { openTestDatabase } from "./database.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("real Node HTTP process binds PORT, rejects unauthenticated intake and drains on SIGTERM", async (t) => {
  await openTestDatabase(t);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      BB_CANDIDATE_MODE: "synthetic",
      DATABASE_URL: process.env.BB_TEST_DATABASE_URL,
      CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      CUSTOMER_FLOW_TEST_ACCESS_TOKEN: "synthetic-server-access-token-at-least-32-chars",
      CUSTOMER_FLOW_ALLOWED_ORIGINS: '["https://bonjour.example.test"]',
      STRIPE_SECRET_KEY: "sk_test_synthetic_no_network",
      STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET: "whsec_synthetic",
      STRIPE_CHECKOUT_SUCCESS_URL: "https://bonjour.example.test/suivi?checkout=success",
      STRIPE_CHECKOUT_CANCEL_URL: "https://bonjour.example.test/suivi?checkout=cancel",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output);
    try { health = await fetch(`${base}/healthz`); if (health.status === 200) break; }
    catch { /* Listener is still starting. */ }
    await delay(50);
  }
  assert.equal(health?.status, 200, output);
  assert.deepEqual(await health.json(), { ok: true, persistence: "postgresql", mode: "synthetic" });
  const blocked = await fetch(`${base}/api/customer-flow/v1/intakes`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(blocked.status, 401);
  child.kill("SIGTERM");
  let timeout;
  try {
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Candidate did not drain within 15 seconds.")), 15_000);
    })]);
    assert.equal(code, 0, output);
    assert.equal(signal, null, output);
  } finally { clearTimeout(timeout); }
  await assert.rejects(() => fetch(`${base}/healthz`));
  assert.doesNotMatch(output, /bb_candidate|sk_test|whsec|postgresql:\/\//);
});
