import assert from "node:assert/strict";
import test from "node:test";

import { dispatchPendingIntakes } from "../../src/operations/kanban-intake-dispatcher.mjs";

test("dispatcher creates PII-free idempotent Kanban cards and completes claimed work", async () => {
  const completed = [];
  const released = [];
  const created = [];
  const queueStore = {
    async claimWorkItems(request) {
      assert.deepEqual(request, {
        workerId: "bridge_test_worker",
        limit: 10,
        nowMs: 1_788_000_000_000,
        leaseMs: 120_000,
      });
      return [
        {
          jobId: "job_private_001",
          source: "customer-intake",
          createdAt: "2026-08-27T10:29:59.000Z",
          attempts: 1,
        },
      ];
    },
    async completeWorkItem(input) { completed.push(structuredClone(input)); },
    async releaseWorkItem(input) { released.push(structuredClone(input)); },
  };

  const result = await dispatchPendingIntakes({
    queueStore,
    workerId: "bridge_test_worker",
    nowMs: 1_788_000_000_000,
    createKanbanTask: async (request) => {
      created.push(structuredClone(request));
      return { taskId: "t_bridge_001" };
    },
  });

  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    title: "[BÉBÉ BONJOUR][INTAKE] Process job_private_001",
    body: [
      "A private intake is ready in the canonical Convex customer-flow store.",
      "Job reference: job_private_001",
      "Do not copy customer or baby data into Kanban comments or logs.",
      "Verify payment state before generation; preserve exact human approval before publication or delivery.",
      "If payment is pending, schedule this same card for recheck; do not complete it or create a duplicate.",
    ].join("\n"),
    assignee: "default",
    board: "personal-projects",
    tenant: "bebe-bonjour",
    workspace: "dir:/Users/zacariachtatar/repos/bebebonjour-app",
    priority: 95,
    idempotencyKey: "bebebonjour:intake:job_private_001",
  });
  assert.equal(JSON.stringify(created).includes("@"), false);
  assert.deepEqual(completed, [{
    jobId: "job_private_001",
    workerId: "bridge_test_worker",
    kanbanTaskId: "t_bridge_001",
    nowMs: 1_788_000_000_000,
  }]);
  assert.deepEqual(released, []);
});

test("dispatcher releases failed claims without leaking provider errors", async () => {
  const released = [];
  const queueStore = {
    async claimWorkItems() {
      return [{
        jobId: "job_private_002",
        source: "customer-intake",
        createdAt: "2026-08-27T10:29:59.000Z",
        attempts: 2,
      }];
    },
    async completeWorkItem() { throw new Error("must not complete"); },
    async releaseWorkItem(input) { released.push(structuredClone(input)); },
  };

  const result = await dispatchPendingIntakes({
    queueStore,
    workerId: "bridge_test_worker",
    nowMs: 1_788_000_000_000,
    createKanbanTask: async () => {
      throw new Error("provider response included parent@example.com");
    },
  });

  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
  assert.deepEqual(released, [{
    jobId: "job_private_002",
    workerId: "bridge_test_worker",
    reasonCode: "kanban_create_failed",
    nowMs: 1_788_000_000_000,
  }]);
  assert.equal(JSON.stringify(result).includes("parent@example.com"), false);
});

test("dispatcher leaves an expired lease for server-side reclaim instead of aborting the poll", async () => {
  const queueStore = {
    async claimWorkItems() {
      return [{
        jobId: "job_private_003",
        source: "customer-intake",
        createdAt: "2026-08-27T10:29:59.000Z",
        attempts: 1,
      }];
    },
    async completeWorkItem() { throw new Error("lease expired"); },
    async releaseWorkItem() { throw new Error("lease expired"); },
  };

  const result = await dispatchPendingIntakes({
    queueStore,
    workerId: "bridge_test_worker",
    nowMs: 1_788_000_000_000,
    createKanbanTask: async () => ({ taskId: "t_bridge003" }),
  });

  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1 });
});
