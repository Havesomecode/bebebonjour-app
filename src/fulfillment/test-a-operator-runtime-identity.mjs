export const REVIEWED_TEST_A_OPERATOR_IDENTITY = Object.freeze({
  resendFrom: "Bébé Bonjour <onboarding@resend.dev>",
  testSink: "delivered@resend.dev",
  publication: Object.freeze({
    teamId: "team_test_a",
    projectId: "prj_test_a_announcements",
    projectName: "bebebonjour-test-a-announcements",
    stableOrigin: "https://announcements.example.test",
  }),
});

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
