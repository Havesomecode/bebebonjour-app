import { execFileSync } from "node:child_process";

const scope = "zacaria-chtatars-projects";
const appProject = "prj_XJrkufo77hXAdvMuYjPn6F6AVZjn";
const landingProject = "prj_tVjEDq14vpyiGRGy1IwvpIKJoFVb";
const endpointId = "we_1U7PFgGrir6mz3o7BJGzWJ66";
const appPrior = "https://bebebonjour-fulfillment-aca39xhj3-zacaria-chtatars-projects.vercel.app";
const landingPrior = "https://bebebonjour-landing-bu9ecg2aj-zacaria-chtatars-projects.vercel.app";

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed (${error.status ?? "unknown"}).`);
  }
}

for (const alias of [
  "bebebonjour-fulfillment.vercel.app",
  "bebebonjour-fulfillment-zacaria-chtatars-projects.vercel.app",
  "bebebonjour-fulfillment-zacaria-zacaria-chtatars-projects.vercel.app",
]) {
  run("npx", ["vercel", "alias", "set", appPrior, alias, "--scope", scope]);
}
for (const alias of [
  "www.bebebonjour.com",
  "bebebonjour.com",
  "bebebonjour-landing.vercel.app",
  "bebebonjour-landing-zacaria-chtatars-projects.vercel.app",
  "bebebonjour-landing-git-master-zacaria-chtatars-projects.vercel.app",
]) {
  run("npx", ["vercel", "alias", "set", landingPrior, alias, "--scope", scope]);
}

for (const name of [
  "CONVEX_URL",
  "CUSTOMER_FLOW_BACKEND_TOKEN",
  "CUSTOMER_FLOW_TOKEN_ENCRYPTION_KEY",
  "CUSTOMER_FLOW_TEST_ACCESS_TOKEN",
  "CUSTOMER_FLOW_ALLOWED_ORIGINS",
  "STRIPE_SECRET_KEY",
  "STRIPE_CUSTOMER_FLOW_WEBHOOK_SECRET",
  "STRIPE_CHECKOUT_SUCCESS_URL",
  "STRIPE_CHECKOUT_CANCEL_URL",
]) {
  run("npx", ["vercel", "env", "rm", name, "production", "--yes", "--scope", scope, "--project", appProject]);
}
run("npx", ["vercel", "env", "rm", "VITE_FULFILLMENT_API_BASE_URL", "production", "--yes", "--scope", scope, "--project", landingProject]);
run("npx", ["convex", "env", "remove", "CUSTOMER_FLOW_BACKEND_TOKEN", "--deployment", "brilliant-hawk-751"]);
run("stripe", ["post", `/v1/webhook_endpoints/${endpointId}`, "--confirm", "--data", "disabled=true", "--color", "off"]);

const protection = JSON.parse(run("npx", [
  "vercel", "project", "protection", "bebebonjour-fulfillment",
  "--scope", scope, "--json",
]));
const bypassTokens = Object.entries(protection.protectionBypass || {})
  .filter(([, metadata]) => metadata?.scope === "automation-bypass")
  .map(([token]) => token);
for (const token of bypassTokens) {
  run("npx", [
    "vercel", "project", "protection", "disable", "bebebonjour-fulfillment",
    "--protection-bypass", "--protection-bypass-secret", token,
    "--scope", scope, "--json",
  ]);
}

console.log(JSON.stringify({
  aliasesRestored: 8,
  appEnvironmentVariablesRemoved: 9,
  landingEnvironmentVariablesRemoved: 1,
  convexEnvironmentVariablesRemoved: 1,
  stripeEndpointDisabled: true,
  automationBypassTokensRevoked: bypassTokens.length,
  completedAt: new Date().toISOString(),
}));
