import { runTestAOperatorCommand } from "../src/fulfillment/test-a-operator-startup.mjs";

try {
  const result = await runTestAOperatorCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Private TEST-A operator startup failed."}\n`);
  process.exitCode = 1;
}
