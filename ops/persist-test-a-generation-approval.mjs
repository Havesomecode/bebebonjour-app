#!/usr/bin/env node

import {
  generationApprovalProvisioningErrorCode,
  persistTestAGenerationApproval,
} from "../src/fulfillment/test-a-generation-approval-startup.mjs";

try {
  const result = await persistTestAGenerationApproval({ argv: process.argv.slice(2) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${generationApprovalProvisioningErrorCode(error)}\n`);
  process.exitCode = 1;
}
