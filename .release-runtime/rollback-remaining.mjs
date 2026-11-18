import { execFileSync } from "node:child_process";

const scope = "zacaria-chtatars-projects";
function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${command} ${args.slice(0, 4).join(" ")} failed (${error.status ?? "unknown"}).`);
  }
}

run("npx", [
  "vercel", "env", "rm", "VITE_FULFILLMENT_API_BASE_URL", "production",
  "--yes", "--scope", scope, "--project", "bebebonjour-landing",
]);
run("npx", ["convex", "env", "remove", "CUSTOMER_FLOW_BACKEND_TOKEN", "--deployment", "brilliant-hawk-751"]);

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
  landingEnvironmentVariablesRemoved: 1,
  convexEnvironmentVariablesRemoved: 1,
  automationBypassTokensRevoked: bypassTokens.length,
  completedAt: new Date().toISOString(),
}));
