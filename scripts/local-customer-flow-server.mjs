import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serve } from "@hono/node-server";

import { createCustomerFlowHttpApi } from "../src/customer-flow/http-api.mjs";
import {
  createLocalPaymentGateway,
} from "../src/customer-flow/local-adapters.mjs";
import { createInMemoryCustomerFlowStore } from "../src/customer-flow/memory-store.mjs";
import { createCustomerFlowService } from "../src/customer-flow/service.mjs";
import { createFulfillmentOrchestrator } from "../src/fulfillment/job-orchestrator.mjs";
import { createLocalTestFulfillmentStore } from "../src/persistence/local-test-fulfillment-store.mjs";

const hostname = "127.0.0.1";
const port = parsePort(process.env.PORT || "8787");
const baseUrl = `http://${hostname}:${port}`;
const allowedOrigins = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
];
const paymentGateway = createLocalPaymentGateway({ baseUrl });
const canonicalStorePath = path.join(tmpdir(), `bebebonjour-test-a-${process.pid}.json`);
const fulfillmentOrchestrator = createFulfillmentOrchestrator({
  store: createLocalTestFulfillmentStore({ filePath: canonicalStorePath }),
  handlers: {},
  clock: () => new Date().toISOString(),
  tokenFactory: () => randomUUID(),
  retryPolicy: {
    leaseMsByStage: {},
    maxAttemptsByStage: {},
    backoffMsByStage: {},
  },
});
const service = createCustomerFlowService({
  store: createInMemoryCustomerFlowStore(),
  paymentGateway,
  fulfillmentOrchestrator,
  syntheticOnly: true,
});
const api = createCustomerFlowHttpApi({ service, allowedOrigins });

api.get("/health", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json({
    ok: true,
    boundary: "TEST-A",
    persistence: "ephemeral-local-only",
    providers: "local-adapters-only",
  });
});

api.get("/test-checkout/:jobId", (context) => {
  const jobId = context.req.param("jobId");
  if (!paymentGateway.hasCheckoutForJob(jobId)) {
    return context.notFound();
  }
  context.header("Cache-Control", "no-store");
  context.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  return context.html(`<!doctype html>
<html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Paiement test local — Bébé Bonjour</title>
<style>body{max-width:42rem;margin:10vh auto;padding:2rem;font:18px/1.6 system-ui;color:#4f382e;background:#fffaf6}article{padding:2rem;border:1px solid #e3b7aa;border-radius:1rem;background:#fff}code{overflow-wrap:anywhere}</style>
<article><h1>Paiement TEST-A local</h1><p>Aucun paiement n’a été effectué. Cette page confirme seulement qu’une session locale est corrélée à la demande.</p><p>Seul un événement fournisseur de confiance peut ouvrir la barrière de paiement. Le navigateur client ne dispose d’aucune commande pour le simuler.</p><p>Utilisez le bouton Retour du navigateur pour revenir au suivi dans cet onglet.</p></article>`);
});

const server = serve({ fetch: api.fetch, hostname, port }, () => {
  console.log(`Bébé Bonjour TEST-A customer flow listening on ${baseUrl}`);
  console.log("Ephemeral local state; synthetic .test addresses; no network providers.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}

function shutdown() {
  server.close(async () => {
    await rm(canonicalStorePath, { force: true }).catch(() => undefined);
    process.exit(0);
  });
}

function parsePort(value) {
  if (!/^\d{2,5}$/.test(value)) throw new Error("PORT must be a valid TCP port.");
  const parsed = Number(value);
  if (parsed < 1024 || parsed > 65_535) throw new Error("PORT must be between 1024 and 65535.");
  return parsed;
}
