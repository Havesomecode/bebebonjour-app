import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const landingOrigin = "https://www.bebebonjour.com";
const successUrl = `${landingOrigin}/suivi?checkout=success`;
const cancelUrl = `${landingOrigin}/suivi?checkout=cancel`;

const [
  environmentExample,
  providerManifest,
  releaseCandidate,
  packageJson,
  hostedRuntime,
  vercelRoutingVerifier,
  vercelConfig,
  staticNotFound,
] = await Promise.all([
  readFile(new URL("../../.env.example", import.meta.url), "utf8"),
  readFile(new URL("../../ops/test-a-hosted-provider-manifest.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(
    new URL("../../openspec/reports/2026-08-18-test-a-hosted-provider-release-candidate.md", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../src/customer-flow/hosted-runtime.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/verify-vercel-routing.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../vercel.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../../public/404.html", import.meta.url), "utf8"),
]);

function environmentValue(name) {
  const matches = [...environmentExample.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  assert.equal(matches.length, 1, `${name} must be declared exactly once`);
  return matches[0][1];
}

function assertEnvironmentValueAbsent(name) {
  assert.equal(new RegExp(`^${name}=`, "m").test(environmentExample), false, `${name} must be absent`);
}

test("hosted TEST-A artifacts pin CORS and checkout callbacks to the active landing origin", () => {
  assert.equal(environmentValue("CUSTOMER_FLOW_ALLOWED_ORIGINS"), JSON.stringify([landingOrigin]));
  assert.equal(environmentValue("STRIPE_CHECKOUT_SUCCESS_URL"), successUrl);
  assert.equal(environmentValue("STRIPE_CHECKOUT_CANCEL_URL"), cancelUrl);
  for (const name of [
    "RESEND_FROM",
    "TEST_A_PUBLICATION_ORIGIN",
    "TEST_A_PUBLICATION_VERCEL_TEAM_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_ID",
    "TEST_A_PUBLICATION_VERCEL_PROJECT_NAME",
  ]) assertEnvironmentValueAbsent(name);

  assert.deepEqual(providerManifest.vercelApi.allowedOrigins, [landingOrigin]);
  assert.deepEqual(providerManifest.stripe.checkoutCallbacks, {
    successUrl,
    cancelUrl,
  });

  assert.ok(releaseCandidate.includes(`CUSTOMER_FLOW_ALLOWED_ORIGINS=${JSON.stringify([landingOrigin])}`));
  assert.ok(releaseCandidate.includes(`STRIPE_CHECKOUT_SUCCESS_URL=${successUrl}`));
  assert.ok(releaseCandidate.includes(`STRIPE_CHECKOUT_CANCEL_URL=${cancelUrl}`));
});

test("provider manifest binds one executable least-privilege hosted candidate", () => {
  const hostedOrigin = "https://bebebonjour-fulfillment.vercel.app";
  const apiBaseUrl = `${hostedOrigin}/api/customer-flow`;

  assert.deepEqual(providerManifest.candidate, {
    appRepository: "git@github.com:Havesomecode/bebebonjour-app.git",
    landingRepository: "git@github.com:Havesomecode/bebebonjour-landing.git",
    canonicalHostedOrigin: hostedOrigin,
    canonicalHostedApiBaseUrl: apiBaseUrl,
    landingOrigin,
    bindingEvidence: ["signedAppCommit", "signedLandingCommit"],
  });
  assert.deepEqual(providerManifest.convex.identity, {
    teamSlug: "havesomecode",
    projectSlug: "bebebonjour-test-a",
    deploymentReference: "prod",
    deploymentName: "tacit-antelope-577",
    deploymentType: "production",
  });
  assert.deepEqual(providerManifest.vercelApi.identity, {
    scopeSlug: "zacaria-chtatars-projects",
    projectId: "prj_XJrkufo77hXAdvMuYjPn6F6AVZjn",
    projectName: "bebebonjour-fulfillment",
    environment: "production",
    canonicalAlias: hostedOrigin,
  });
  assert.deepEqual(providerManifest.stripe.endpoint, {
    accountId: "acct_1MKd4KGrir6mz3o7",
    mode: "test",
    url: `${apiBaseUrl}/webhooks/stripe`,
    events: ["checkout.session.completed"],
    enabledAtCreation: true,
    creationTarget: "vercelBootstrapDeploymentUrl",
    preAliasTarget: "vercelFinalDeploymentUrl",
    providerIdEvidence: "required-after-creation",
  });
  assert.deepEqual(providerManifest.resendOperatorRuntime.capabilities, ["status", "persist-approval"]);
  assert.equal(providerManifest.resendOperatorRuntime.providerOperationsEnabled, false);
  assert.equal(Object.hasOwn(providerManifest.resendOperatorRuntime, "identity"), false);
  assert.equal(
    providerManifest.resendOperatorRuntime.futurePublicationIdentityAuthority,
    "parsed exact Vercel inspection bytes for deploymentId, revisionId, buildId, teamId, projectId, and projectName; environment values may only assert expected values",
  );

  assert.deepEqual(providerManifest.operations.map(({ id }) => id), [
    "freeze-signed-candidates",
    "select-convex-production",
    "install-convex-backend-token",
    "deploy-convex-functions",
    "install-vercel-bootstrap-environment",
    "deploy-vercel-bootstrap-candidate",
    "create-stripe-test-webhook",
    "install-stripe-webhook-secret",
    "deploy-vercel-final-candidate",
    "retarget-webhook-to-final-deployment",
    "probe-deployment-before-alias",
    "assign-canonical-alias",
    "retarget-webhook-to-canonical-alias",
    "activate-canonical-landing-build",
    "run-synthetic-provider-proof",
    "install-operator-runtime-secrets",
    "persist-human-approval",
    "keep-provider-effects-disabled",
  ]);
  assert.ok(providerManifest.operations.every(({ requiredEvidence }) => requiredEvidence.length > 0));
  assert.ok(providerManifest.convex.tables.includes("fulfillmentReviewApprovals"));
  assert.deepEqual(
    providerManifest.operations.find(({ id }) => id === "persist-human-approval").requiredEvidence,
    [
      "jobId",
      "intakeDigest",
      "runId",
      "revisionDigest",
      "artifactManifestDigest",
      "approvalId",
      "approvedAt",
      "reviewerAuthority",
    ],
  );
  assert.deepEqual(
    providerManifest.operations.find(({ id }) => id === "keep-provider-effects-disabled").requiredEvidence,
    [
      "disabledCommandProof",
      "providerCredentialsAbsent",
      "authoritativeInspectionRequirement",
      "localCliVersion",
    ],
  );

  assert.deepEqual(providerManifest.secretStores.landingBuild.allowed, []);
  assert.ok(providerManifest.secretStores.landingBuild.forbidden.includes("CUSTOMER_FLOW_TEST_ACCESS_TOKEN"));
  assert.ok(providerManifest.secretStores.vercelProduction.forbidden.includes("RESEND_API_KEY"));
  assert.ok(providerManifest.secretStores.convexProduction.forbidden.includes("STRIPE_SECRET_KEY"));
  assert.ok(providerManifest.convex.tables.includes("customerFlowWorkItems"));
  assert.equal(providerManifest.tallyIntake.mode, "intake-only");
  assert.ok(providerManifest.vercelApi.routes.includes("POST /api/webhooks/tally"));
  for (const name of [
    "TALLY_INTAKE_SIGNING_SECRET",
    "TALLY_INTAKE_FORM_ID",
    "TALLY_INTAKE_FIELD_MAP",
  ]) assert.ok(providerManifest.secretStores.vercelProduction.allowed.includes(name));
  assert.ok(providerManifest.secretStores.resendOperator.forbidden.includes("STRIPE_SECRET_KEY"));
  assert.deepEqual(providerManifest.secretStores.resendOperator.allowed, [
    "CONVEX_URL",
    "CUSTOMER_FLOW_BACKEND_TOKEN",
    "BEBEBONJOUR_APPROVAL_HMAC_KEY",
  ]);
  for (const name of ["VERCEL_TOKEN", "RESEND_API_KEY", "RESEND_FROM", "TEST_A_PUBLICATION_ORIGIN"]) {
    assert.ok(providerManifest.secretStores.resendOperator.forbidden.includes(name));
  }
  assert.deepEqual(providerManifest.resendOperatorRuntime.environmentVariables,
    providerManifest.secretStores.resendOperator.allowed);
  assert.equal(providerManifest.rollback.mode, "configuration-only");
  assert.equal(providerManifest.rollback.preserveEvidence, true);
  assert.ok(providerManifest.rollback.actions.every(({ deleteEvidence }) => deleteEvidence === false));

  assert.doesNotMatch(releaseCandidate, /7823d63|9927586/);
  assert.ok(releaseCandidate.includes(apiBaseUrl));
  assert.ok(releaseCandidate.includes("signed app and landing commit identities"));
});

test("production build syntax-checks every private TEST-A operator module", () => {
  for (const modulePath of [
    "./convex/operations.js",
    "./src/operations/operations-command-error.mjs",
    "./src/operations/operations-action-handlers.mjs",
    "./src/operations/operations-command-worker.mjs",
    "./src/operations/operations-worker-runtime.mjs",
    "./src/operations/production-completion-worker.mjs",
    "./src/persistence/convex-operations-command-queue.mjs",
    "./src/fulfillment/exact-revision-publication-adapter.mjs",
    "./src/fulfillment/test-a-completion-capabilities.mjs",
    "./src/fulfillment/local-artifact-resolver.mjs",
    "./src/fulfillment/vercel-test-a-publication-provider.mjs",
    "./src/fulfillment/persisted-review-decision.mjs",
    "./src/fulfillment/operator-runner-test-a.mjs",
    "./src/fulfillment/test-a-operator-runtime-identity.mjs",
    "./src/fulfillment/test-a-operator-startup.mjs",
    "./src/config/test-a-hosted-provider-manifest.mjs",
    "./src/config/test-a-operator-isolation.mjs",
    "./ops/run-test-a-operator.mjs",
    "./ops/test-a-consolidated-candidate-audit.mjs",
    "./ops/test-a-operator-isolation-audit.mjs",
  ]) {
    assert.ok(packageJson.scripts.build.includes(`node --check ${modulePath}`));
  }
  assert.equal(
    packageJson.scripts.test,
    "node --test 'test/*.test.mjs' 'test/**/*.test.mjs'",
  );
  assert.equal(
    packageJson.scripts["test:integration"],
    "node --test --test-concurrency=1 test/integration/fulfillment-workflow-tracer.test.mjs",
  );
  assert.equal(
    packageJson.scripts["test:operator-isolation"],
    "node ./ops/test-a-consolidated-candidate-audit.mjs",
  );
  assert.equal(
    packageJson.scripts["test:production-audit"],
    "node ./ops/test-a-consolidated-candidate-audit.mjs && node ./ops/test-a-completion-worker-audit.mjs",
  );
  assert.match(packageJson.scripts.verify, /npm run test:production-audit/);
});

test("TEST-A operator runner is absent from public HTTP and package command surfaces", () => {
  assert.doesNotMatch(hostedRuntime, /createTestAOperatorRunner|operator-runner-test-a|test-a-operator-runner/);
  assert.deepEqual(packageJson.bin, { announce: "./bin/announce.mjs" });
  assert.equal(providerManifest.resendOperatorRuntime.publicApiAccess, false);
  assert.match(vercelRoutingVerifier, /inspectGeneratedPublicArtifact\(outputRoot\)/);
  assert.match(vercelRoutingVerifier, /HERMES_VERIFY_RESULT/);
  assert.equal(packageJson.devDependencies.vercel, "52.2.0");
  assert.match(vercelRoutingVerifier, /node_modules.*\.bin.*vercel/s);
  assert.match(vercelRoutingVerifier, /52\.2\.0/);
  assert.doesNotMatch(vercelRoutingVerifier, /process\.env\.VERCEL_CLI/);
});

test("function deployment emits only a bounded static 404 directory", () => {
  assert.equal(vercelConfig.outputDirectory, "public");
  assert.match(staticNotFound, /<meta name="robots" content="noindex">/u);
  assert.equal(staticNotFound.includes("CUSTOMER_FLOW"), false);
});
