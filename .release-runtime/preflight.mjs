import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configPath = path.join(os.homedir(), ".config", "stripe", "config.toml");
const raw = await readFile(configPath, "utf8");
const match = raw.match(/^test_mode_api_key\s*=\s*["']([^"']+)["']/m);
if (!match) throw new Error("Stripe CLI test-mode API credential is missing.");
const prefix = match[1].startsWith("sk_test_")
  ? "sk_test"
  : match[1].startsWith("rk_test_")
    ? "rk_test"
    : "unexpected";
const account = JSON.parse(execFileSync("stripe", ["get", "/v1/account", "--color", "off"], {
  encoding: "utf8",
}));
console.log(JSON.stringify({
  stripeCredentialPresent: true,
  prefix,
  accountId: account.id,
  hasLivemodeField: Object.hasOwn(account, "livemode"),
  livemode: account.livemode ?? null,
}));
