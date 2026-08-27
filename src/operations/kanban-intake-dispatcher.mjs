const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_PATTERN = /^dir:\/Users\/zacariachtatar\/repos\/bebebonjour-app(?:\/\.worktrees\/[A-Za-z0-9._-]+)?$/;

export async function dispatchPendingIntakes({
  queueStore,
  createKanbanTask,
  workerId,
  nowMs = () => Date.now(),
  batchSize = 10,
  leaseMs = 120_000,
  kanbanWorkspace = "dir:/Users/zacariachtatar/repos/bebebonjour-app",
}) {
  if (!queueStore?.claimWorkItems || !queueStore?.completeWorkItem || !queueStore?.releaseWorkItem
      || typeof createKanbanTask !== "function" || !JOB_ID_PATTERN.test(workerId)
      || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10
      || !Number.isInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 300_000
      || !WORKSPACE_PATTERN.test(kanbanWorkspace)) {
    throw new Error("Kanban intake dispatcher configuration is invalid.");
  }

  const clock = typeof nowMs === "function" ? nowMs : () => nowMs;
  const claimTime = clock();
  const items = await queueStore.claimWorkItems({
    workerId,
    limit: batchSize,
    nowMs: claimTime,
    leaseMs,
  });
  const result = { claimed: items.length, completed: 0, failed: 0 };

  for (const item of items) {
    assertWorkItem(item);
    const card = kanbanCardFor(item, kanbanWorkspace);
    try {
      const created = await createKanbanTask(card);
      if (!created || !/^t_[A-Za-z0-9_-]{4,64}$/.test(created.taskId)) {
        throw new Error("Kanban task creation returned an invalid task id.");
      }
      await queueStore.completeWorkItem({
        jobId: item.jobId,
        workerId,
        kanbanTaskId: created.taskId,
        nowMs: clock(),
      });
      result.completed += 1;
    } catch {
      try {
        await queueStore.releaseWorkItem({
          jobId: item.jobId,
          workerId,
          reasonCode: "kanban_create_failed",
          nowMs: clock(),
        });
      } catch {
        // The server will reclaim an expired lease on the next poll.
      }
      result.failed += 1;
    }
  }

  return result;
}

export function kanbanCardFor(
  item,
  workspace = "dir:/Users/zacariachtatar/repos/bebebonjour-app",
) {
  assertWorkItem(item);
  return {
    title: `[BÉBÉ BONJOUR][INTAKE] Process ${item.jobId}`,
    body: [
      "A private intake is ready in the canonical Convex customer-flow store.",
      `Job reference: ${item.jobId}`,
      "Do not copy customer or baby data into Kanban comments or logs.",
      "Verify payment state before generation; preserve exact human approval before publication or delivery.",
      "If payment is pending, schedule this same card for recheck; do not complete it or create a duplicate.",
    ].join("\n"),
    assignee: "default",
    board: "personal-projects",
    tenant: "bebe-bonjour",
    workspace,
    priority: 95,
    idempotencyKey: `bebebonjour:intake:${item.jobId}`,
  };
}

function assertWorkItem(item) {
  if (!item || typeof item !== "object" || !JOB_ID_PATTERN.test(item.jobId)
      || item.source !== "customer-intake" || typeof item.createdAt !== "string"
      || !Number.isInteger(item.attempts) || item.attempts < 1) {
    throw new Error("Claimed intake work item is invalid.");
  }
}
