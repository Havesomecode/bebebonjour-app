import { execFileSync } from "node:child_process";

const base = ["vercel", "project", "protection", "bebebonjour-fulfillment", "--scope", "zacaria-chtatars-projects", "--json"];
const before = JSON.parse(execFileSync("npx", base, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const bypass = before.protectionBypass || {};
const tokens = Object.entries(bypass)
  .filter(([, metadata]) => metadata?.scope === "automation-bypass")
  .map(([token]) => token);
if (tokens.length !== 1) {
  throw new Error(`Expected exactly one generated automation bypass token, found ${tokens.length}.`);
}
execFileSync("npx", [
  "vercel", "project", "protection", "disable", "bebebonjour-fulfillment",
  "--protection-bypass", "--protection-bypass-secret", tokens[0],
  "--scope", "zacaria-chtatars-projects", "--json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const after = JSON.parse(execFileSync("npx", base, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const remaining = Object.values(after.protectionBypass || {})
  .filter((metadata) => metadata?.scope === "automation-bypass").length;
if (remaining !== 0) throw new Error("Automation bypass token revocation was not verified.");
console.log(JSON.stringify({ revokedAutomationBypassTokens: 1, remainingAutomationBypassTokens: 0 }));
