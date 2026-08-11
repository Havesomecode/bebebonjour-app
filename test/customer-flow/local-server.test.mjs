import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

const syntheticIntake = {
  schemaVersion: "1.0",
  customer: { email: "local.server@example.test", consent: true },
  baby: { firstName: "Amal Test", gender: "girl" },
  languages: ["fr"],
  voicePreference: { enabled: true, gender: "male" },
};

test("local TEST-A server serves checkout pages only for correlated jobs", async (t) => {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["scripts/local-customer-flow-server.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  t.after(async () => stop(child));

  await waitForHealth(baseUrl, child, () => diagnostics);

  const fabricated = await fetch(`${baseUrl}/test-checkout/job_fabricated`);
  assert.equal(fabricated.status, 404);

  const intakeResponse = await fetch(`${baseUrl}/v1/intakes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "intake:local-server-test",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify(syntheticIntake),
  });
  assert.equal(intakeResponse.status, 201);
  const submission = await intakeResponse.json();

  const checkoutResponse = await fetch(`${baseUrl}/v1/jobs/${submission.jobId}/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${submission.intakeToken}`,
      origin: "http://127.0.0.1:5173",
    },
  });
  assert.equal(checkoutResponse.status, 200);
  const checkout = await checkoutResponse.json();
  assert.equal(checkout.checkoutUrl, `${baseUrl}/test-checkout/${submission.jobId}`);

  const correlated = await fetch(checkout.checkoutUrl);
  assert.equal(correlated.status, 200);
  const checkoutHtml = await correlated.text();
  assert.match(checkoutHtml, /Aucun paiement n’a été effectué/);
  assert.doesNotMatch(checkoutHtml, /http:\/\/127\.0\.0\.1:5173/);
});

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child, diagnostics) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Local server exited before readiness: ${diagnostics()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The loopback listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Local server did not become ready: ${diagnostics()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
