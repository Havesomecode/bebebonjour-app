#!/usr/bin/env node

import process from "node:process";
import {
  commandApproveReview,
  commandCompose,
  commandDeploy,
  commandPrepareReview,
  commandRender,
  commandSend,
  commandStatus,
  commandTts,
} from "../scripts/lib/commands.mjs";
import { loadProjectEnv, parseArgs } from "../scripts/lib/common.mjs";

async function main() {
  await loadProjectEnv();
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  switch (command) {
    case "compose":
      await commandCompose(args);
      break;
    case "prepare-review":
      await commandPrepareReview(args);
      break;
    case "approve-review":
      await commandApproveReview(args);
      break;
    case "render":
      await commandRender(args);
      break;
    case "tts":
      await commandTts(args);
      break;
    case "deploy":
      await commandDeploy(args);
      break;
    case "send":
      await commandSend(args);
      break;
    case "status":
      await commandStatus(args);
      break;
    case "help":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp() {
  console.log(`Usage:
  announce compose --input <intake.json> --output <page.json> [--select <candidate-id>]
  announce prepare-review --input <intake.json> --output <dir> [--select <candidate-id>]
  announce approve-review --review <review.json> --output <dir> --reviewer <id> [--acknowledge <reason,...>] [--demands <applied|not_applied>]
  announce render --input <page.json> --approval <approval.json> --output <dir>
  announce render --input <draft-page.json> --output <dir> --allow-draft
  announce tts --input <page.json> --output <dir> [--lang <ar|fr|all>] [--force]
  announce deploy --input <dir> [--job <job.json>] [--dry-run]
  announce send --job <job.json> [--provider console] [--dry-run]  # redacted preview only
  announce status --job <job.json> [--json]

Credentials:
  The CLI loads .env.local and .env from the project root automatically.
  See LIVE_SETUP.md for OPENAI_API_KEY and VERCEL_* setup.
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
