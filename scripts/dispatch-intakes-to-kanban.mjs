#!/usr/bin/env node

import { hostname } from "node:os";

import { ConvexHttpClient } from "convex/browser";

import { dispatchPendingIntakes } from "../src/operations/kanban-intake-dispatcher.mjs";
import { createHermesKanbanTask } from "../src/operations/hermes-kanban-client.mjs";
import { createConvexCustomerFlowStore } from "../src/persistence/convex-customer-flow-store.mjs";

const convexUrl = requiredHttpsUrl(process.env.CONVEX_URL, "CONVEX_URL");
const backendToken = requiredSecret(process.env.CUSTOMER_FLOW_BACKEND_TOKEN, "CUSTOMER_FLOW_BACKEND_TOKEN");
const workerId = `bridge_${hostname()}_${process.pid}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
const queueStore = createConvexCustomerFlowStore({
  client: new ConvexHttpClient(convexUrl),
  backendToken,
});
const result = await dispatchPendingIntakes({
  queueStore,
  createKanbanTask: (card) => createHermesKanbanTask(card),
  workerId,
  batchSize: 1,
  kanbanWorkspace: process.env.BEBEBONJOUR_KANBAN_WORKSPACE
    || "dir:/Users/zacariachtatar/repos/bebebonjour-app",
});

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.failed > 0) process.exitCode = 1;

function requiredHttpsUrl(value, name) {
  if (typeof value !== "string") throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment.`);
  }
  return value;
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters.`);
  }
  return value;
}
