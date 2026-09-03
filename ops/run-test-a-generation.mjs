#!/usr/bin/env node
import {
  generationOperatorErrorCode,
  runTestAGenerationCommand,
} from "../src/fulfillment/test-a-generation-startup.mjs";

try {
  const result = await runTestAGenerationCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${generationOperatorErrorCode(error)}\n`);
  process.exitCode = 1;
}
