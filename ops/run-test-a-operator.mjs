import { runTestAOperatorCommand } from "../src/fulfillment/test-a-operator-startup.mjs";

try {
  const argv = process.argv.slice(2);
  const result = await runTestAOperatorCommand({
    argv,
    approvalInput: argv[0] === "persist-approval" ? await readStdin() : undefined,
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Private TEST-A operator startup failed."}\n`);
  process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
