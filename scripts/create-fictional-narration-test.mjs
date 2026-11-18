#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/create-fictional-narration-test.mjs --acknowledge-fictional <fr|ar> <text-file>\nRequires CONVEX_URL, BEBEBONJOUR_OPERATIONS_TOKEN; backend must explicitly enable BEBEBONJOUR_NARRATION_TESTS_ENABLED=true. Creates a NEW unpaid, operator-authored test; never calls a provider.",
  );
} else {
  try {
    const [flag, language, file, ...extra] = process.argv.slice(2);
    if (
      flag !== "--acknowledge-fictional" ||
      !["fr", "ar"].includes(language) ||
      !file ||
      extra.length
    )
      throw new Error();
    const url = new URL(process.env.CONVEX_URL);
    const operatorToken = process.env.BEBEBONJOUR_OPERATIONS_TOKEN;
    if (
      url.protocol !== "https:" ||
      url.origin !== process.env.CONVEX_URL ||
      !operatorToken ||
      operatorToken.length < 32
    )
      throw new Error();
    const text = await readFile(file, "utf8");
    if (text.length > 2000 || !text.trim()) throw new Error();
    const client = new ConvexHttpClient(url.origin, {
      logger: false,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        }),
    });
    const result = await client.action(
      makeFunctionReference("narrationRuntime:createFictionalTest"),
      {
        operatorToken,
        language,
        text,
        acknowledgement: "fictional-operator-authored-not-codex",
      },
    );
    console.log(
      JSON.stringify({
        jobId: result.jobId,
        state: "content_review_required",
        payment: "not_applicable",
        provenance: "fictional-operator-authored-not-codex",
      }),
    );
  } catch {
    console.error(
      "Fictional narration test creation failed or was not confirmed. Check configuration and Ops before retrying; no existing job was requested for modification.",
    );
    process.exitCode = 1;
  }
}
