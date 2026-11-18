import assert from "node:assert/strict";
import test from "node:test";

import { createHermesKanbanTask } from "../../src/operations/hermes-kanban-client.mjs";

test("Hermes Kanban client uses the card idempotency key and returns only the durable task id", async () => {
  const calls = [];
  const result = await createHermesKanbanTask({
    title: "[BÉBÉ BONJOUR][INTAKE] Process job_private_001",
    body: "PII-free body",
    assignee: "default",
    board: "personal-projects",
    tenant: "bebe-bonjour",
    workspace: "dir:/Users/zacariachtatar/repos/bebebonjour-app",
    priority: 95,
    idempotencyKey: "bebebonjour:intake:job_private_001",
  }, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ task: { id: "t_bridge001" } }) };
    },
  });

  assert.deepEqual(result, { taskId: "t_bridge001" });
  assert.deepEqual(calls[0], {
    command: "hermes",
    args: [
      "kanban", "--board", "personal-projects", "create",
      "[BÉBÉ BONJOUR][INTAKE] Process job_private_001",
      "--body", "PII-free body",
      "--assignee", "default",
      "--workspace", "dir:/Users/zacariachtatar/repos/bebebonjour-app",
      "--tenant", "bebe-bonjour",
      "--priority", "95",
      "--idempotency-key", "bebebonjour:intake:job_private_001",
      "--created-by", "bebebonjour-intake-bridge",
      "--json",
    ],
    options: { maxBuffer: 1_000_000, timeout: 30_000 },
  });
});
