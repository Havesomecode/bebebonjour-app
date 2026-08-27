import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createHermesKanbanTask(card, options = {}) {
  assertCard(card);
  const runCommand = options.runCommand || defaultRunCommand;
  const args = [
    "kanban", "--board", card.board, "create",
    card.title,
    "--body", card.body,
    "--assignee", card.assignee,
    "--workspace", card.workspace,
    "--tenant", card.tenant,
    "--priority", String(card.priority),
    "--idempotency-key", card.idempotencyKey,
    "--created-by", "bebebonjour-intake-bridge",
    "--json",
  ];
  const { stdout } = await runCommand("hermes", args, {
    maxBuffer: 1_000_000,
    timeout: 30_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Hermes Kanban task creation returned invalid JSON.", { cause: error });
  }
  const taskId = parsed?.task?.id || parsed?.task_id || parsed?.id;
  if (!/^t_[A-Za-z0-9_-]{4,64}$/.test(taskId || "")) {
    throw new Error("Hermes Kanban task creation returned an invalid task id.");
  }
  return { taskId };
}

function defaultRunCommand(command, args, options) {
  return execFileAsync(command, args, { ...options, encoding: "utf8" });
}

function assertCard(card) {
  if (!card || typeof card !== "object" || !card.title || !card.body
      || card.board !== "personal-projects" || card.tenant !== "bebe-bonjour"
      || card.assignee !== "default"
      || !/^dir:\/Users\/zacariachtatar\/repos\/bebebonjour-app(?:\/\.worktrees\/[A-Za-z0-9._-]+)?$/.test(card.workspace)
      || !Number.isInteger(card.priority) || card.priority < 0 || card.priority > 100
      || !/^bebebonjour:intake:[A-Za-z0-9_-]{1,128}$/.test(card.idempotencyKey)) {
    throw new Error("Hermes Kanban card is invalid.");
  }
}
