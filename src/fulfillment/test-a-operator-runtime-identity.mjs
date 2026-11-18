import { REVIEWED_TEST_A_OPERATOR_POLICY } from "../config/test-a-hosted-provider-manifest.mjs";

export const REVIEWED_TEST_A_OPERATOR_IDENTITY = REVIEWED_TEST_A_OPERATOR_POLICY.identity;

export function requireReviewedTestAOperatorIdentity(environment) {
  const expected = REVIEWED_TEST_A_OPERATOR_IDENTITY;
  return Object.freeze({
    resendFrom: requireExact(environment, "RESEND_FROM", expected.resendFrom),
    publication: Object.freeze({
      stableOrigin: requireExactHttpsOrigin(
        environment,
        "TEST_A_PUBLICATION_ORIGIN",
        expected.publication.stableOrigin,
      ),
      teamId: requireExact(
        environment,
        "TEST_A_PUBLICATION_VERCEL_TEAM_ID",
        expected.publication.teamId,
      ),
      projectId: requireExact(
        environment,
        "TEST_A_PUBLICATION_VERCEL_PROJECT_ID",
        expected.publication.projectId,
      ),
      projectName: requireExact(
        environment,
        "TEST_A_PUBLICATION_VERCEL_PROJECT_NAME",
        expected.publication.projectName,
      ),
    }),
  });
}

function requireExact(environment, name, expected) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  if (value !== expected) {
    throw new Error(`${name} does not match the reviewed TEST-A operator identity.`);
  }
  return expected;
}

function requireExactHttpsOrigin(environment, name, expected) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required.`);
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  if (value !== expected) {
    throw new Error(`${name} does not match the reviewed TEST-A operator identity.`);
  }
  return expected;
}
